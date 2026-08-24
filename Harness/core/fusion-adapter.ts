/**
 * Model fusion: run more than one underlying model per request and return a
 * single reply, chosen by a defined deterministic strategy, while recording
 * per-model provenance (which model was consulted, its usage, and which one was
 * selected). The engine sees a normal {@link AgentAdapter}, so every
 * deterministic loop gate is unchanged.
 *
 * Fail-closed contract: a fused reply must reflect every configured member. If
 * any member errors, no partial or fabricated result is emitted — `complete`
 * rejects and the failure is recorded in provenance.
 */
import type { AgentAdapter, AgentReply, AgentRequest, AgentUsage } from "./loop-types.js";
import { applyModelOverride, type ProviderProfile } from "./provider-profile.js";

/** Deterministic selection strategies among successful member replies. */
export type FusionStrategy = "longest" | "first";

export const FUSION_STRATEGIES: readonly FusionStrategy[] = ["longest", "first"];
export const DEFAULT_FUSION_STRATEGY: FusionStrategy = "longest";

/** At least two members are required; the upper bound keeps cost/latency bounded. */
export const MIN_FUSION_MEMBERS = 2;
export const MAX_FUSION_MEMBERS = 4;

const MODEL_ID_PATTERN = /^[\w./:+-]{1,200}$/u;

export interface FusionMember {
  /** Stable model identifier used only for provenance (validated, printable). */
  model: string;
  adapter: AgentAdapter;
}

export interface FusionMemberProvenance {
  index: number;
  model: string;
  status: "ok" | "error";
  selected: boolean;
  usage?: AgentUsage;
  contentChars?: number;
  error?: string;
}

export interface FusionCallProvenance {
  role: AgentRequest["role"];
  strategy: FusionStrategy;
  /** Empty when the call failed closed (no member was selected). */
  selectedModel: string;
  members: FusionMemberProvenance[];
  aggregateUsage: AgentUsage;
}

export interface FusionAdapterOptions {
  strategy?: FusionStrategy;
  /** Observability sink invoked once per completed or failed fusion call. */
  onProvenance?: (provenance: FusionCallProvenance) => void;
}

function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, total: 0, cost: 0 };
}

/** Validate a model id used both for CLI input and fusion member provenance. */
export function assertFusionModelId(model: string, label = "Fusion model id"): void {
  if (!MODEL_ID_PATTERN.test(model)) throw new Error(`${label} "${model.slice(0, 60)}" is invalid.`);
}

/**
 * Parse and validate a comma-separated fusion model list (e.g. `--model "a,b"`).
 * Requires at least two unique, bounded, printable ids.
 */
export function parseFusionModelIds(input: string): string[] {
  const ids = input.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length < MIN_FUSION_MEMBERS) {
    throw new Error(`Model fusion requires at least ${MIN_FUSION_MEMBERS} comma-separated model ids.`);
  }
  if (ids.length > MAX_FUSION_MEMBERS) {
    throw new Error(`Model fusion supports at most ${MAX_FUSION_MEMBERS} model ids.`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    assertFusionModelId(id);
    if (seen.has(id)) throw new Error(`Fusion model ids must be unique; "${id}" is duplicated.`);
    seen.add(id);
  }
  return ids;
}

export type FusionAdapterFactory = (profile: ProviderProfile) => Promise<AgentAdapter>;

/**
 * Build fusion members from an OpenRouter base profile and a validated id list,
 * creating one adapter per model via an injectable factory (the real factory
 * builds a Pi provider adapter; tests inject a mock). Free + paid models can be
 * combined because each id becomes its own OpenAI-compatible model override.
 */
export async function buildOpenRouterFusionMembers(
  baseProfile: ProviderProfile,
  modelIds: readonly string[],
  createAdapter: FusionAdapterFactory,
): Promise<FusionMember[]> {
  if (baseProfile.preset !== "openrouter") {
    throw new Error("Model fusion is currently supported for the OpenRouter provider.");
  }
  if (modelIds.length < MIN_FUSION_MEMBERS) {
    throw new Error(`Model fusion requires at least ${MIN_FUSION_MEMBERS} model ids.`);
  }
  const members: FusionMember[] = [];
  for (const modelID of modelIds) {
    assertFusionModelId(modelID);
    // freeOnly is intentionally dropped so a free + paid mix is not rejected by
    // the free-mode re-check; the base profile's own free-mode gate is unchanged.
    const { freeOnly: _freeOnly, ...unpinned } = baseProfile;
    const profile = applyModelOverride(unpinned, { modelID });
    members.push({ model: modelID, adapter: await createAdapter(profile) });
  }
  return members;
}

export class FusionAdapter implements AgentAdapter {
  readonly supportsImages: boolean;
  private readonly members: readonly FusionMember[];
  private readonly strategy: FusionStrategy;
  private readonly onProvenance?: (provenance: FusionCallProvenance) => void;
  private readonly log: FusionCallProvenance[] = [];

  constructor(members: readonly FusionMember[], options: FusionAdapterOptions = {}) {
    if (members.length < MIN_FUSION_MEMBERS) {
      throw new Error(`Model fusion requires at least ${MIN_FUSION_MEMBERS} member models.`);
    }
    if (members.length > MAX_FUSION_MEMBERS) {
      throw new Error(`Model fusion supports at most ${MAX_FUSION_MEMBERS} member models.`);
    }
    const seen = new Set<string>();
    for (const member of members) {
      assertFusionModelId(member.model, "Fusion member model id");
      if (seen.has(member.model)) throw new Error(`Fusion member models must be unique; ${member.model} is duplicated.`);
      seen.add(member.model);
    }
    this.members = [...members];
    this.strategy = options.strategy ?? DEFAULT_FUSION_STRATEGY;
    if (options.onProvenance) this.onProvenance = options.onProvenance;
    // Advertise image support only when every member supports images, so the
    // engine never routes an image that a fusion member cannot process.
    this.supportsImages = this.members.every((member) => member.adapter.supportsImages === true);
  }

  /** All recorded fusion call provenances, oldest first. */
  provenance(): readonly FusionCallProvenance[] {
    return this.log;
  }

  async complete(request: AgentRequest, signal?: AbortSignal): Promise<AgentReply> {
    signal?.throwIfAborted();
    const settled = await Promise.all(this.members.map(async (member) => {
      try {
        return { member, reply: await member.adapter.complete(request, signal) };
      } catch (error) {
        return { member, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }));

    const aggregateUsage = emptyUsage();
    const successes: { index: number; member: FusionMember; reply: AgentReply }[] = [];
    let failureCount = 0;
    settled.forEach((outcome, index) => {
      if ("reply" in outcome) {
        aggregateUsage.input += outcome.reply.usage.input;
        aggregateUsage.output += outcome.reply.usage.output;
        aggregateUsage.total += outcome.reply.usage.total;
        aggregateUsage.cost += outcome.reply.usage.cost;
        successes.push({ index, member: outcome.member, reply: outcome.reply });
      } else {
        failureCount += 1;
      }
    });

    // Only select a reply when every member succeeded (fail-closed).
    const selected = failureCount === 0 ? this.select(successes) : undefined;

    const members: FusionMemberProvenance[] = settled.map((outcome, index) => {
      if ("reply" in outcome) {
        return {
          index,
          model: outcome.member.model,
          status: "ok",
          selected: selected?.index === index,
          usage: outcome.reply.usage,
          contentChars: outcome.reply.content.length,
        };
      }
      return {
        index,
        model: outcome.member.model,
        status: "error",
        selected: false,
        error: outcome.error.message.slice(0, 300),
      };
    });

    const provenance: FusionCallProvenance = {
      role: request.role,
      strategy: this.strategy,
      selectedModel: selected?.member.model ?? "",
      members,
      aggregateUsage,
    };
    this.log.push(provenance);
    this.onProvenance?.(provenance);

    if (failureCount > 0) {
      const failed = members.filter((member) => member.status === "error").map((member) => member.model);
      throw new Error(`Model fusion failed closed: ${failed.join(", ")} did not return a usable reply.`);
    }
    if (!selected) throw new Error("Model fusion produced no selectable reply.");
    return { content: selected.reply.content, usage: aggregateUsage };
  }

  private select(
    successes: { index: number; member: FusionMember; reply: AgentReply }[],
  ): { index: number; member: FusionMember; reply: AgentReply } {
    if (this.strategy === "first") return successes[0]!;
    // "longest": most content characters; ties keep the earlier member (stable).
    return successes.reduce(
      (best, candidate) => (candidate.reply.content.length > best.reply.content.length ? candidate : best),
      successes[0]!,
    );
  }
}
