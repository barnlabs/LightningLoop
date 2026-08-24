/**
 * The three LightningLoop agents. People pick a model for each. The loop
 * engine still speaks orchestrator/implementer/reviewer; this roster maps
 * those turns onto Researcher / Engineer / Verifier.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentAdapter, AgentReply, AgentRequest } from "./loop-types.js";
import { lightningLoopDataPath } from "./platform-paths.js";
import { objectValue, stringValue } from "./structured-json.js";
import type { ProviderProfile } from "./provider-profile.js";

export const LOOP_ROSTER_VERSION = 1 as const;
export const LOOP_AGENTS = ["researcher", "engineer", "verifier"] as const;
export type LoopAgent = (typeof LOOP_AGENTS)[number];

const MODEL_ID_PATTERN = /^[\w./:+-]{1,200}$/u;

export interface LoopAgentAssignment {
  modelID: string;
}

export interface LoopRoster {
  schemaVersion: typeof LOOP_ROSTER_VERSION;
  agents: Record<LoopAgent, LoopAgentAssignment>;
}

export function emptyRoster(): LoopRoster {
  return {
    schemaVersion: LOOP_ROSTER_VERSION,
    agents: {
      researcher: { modelID: "" },
      engineer: { modelID: "" },
      verifier: { modelID: "" },
    },
  };
}

export const EMPTY_ROSTER: LoopRoster = emptyRoster();

export function loopRosterPath(): string {
  const override = process.env.LIGHTNINGLOOP_AGENTS_CONFIG_PATH;
  if (override) {
    if (!isAbsolute(override)) throw new Error("LIGHTNINGLOOP_AGENTS_CONFIG_PATH must be absolute.");
    return override;
  }
  return lightningLoopDataPath("agents.json");
}

export function isLoopAgent(value: string): value is LoopAgent {
  return (LOOP_AGENTS as readonly string[]).includes(value);
}

export function loopAgentForRequestRole(role: AgentRequest["role"]): LoopAgent {
  if (role === "implementer") return "engineer";
  if (role === "reviewer") return "verifier";
  return "researcher";
}

export function parseLoopRoster(value: unknown): LoopRoster {
  const root = objectValue(value, "loop roster");
  if (root.schemaVersion !== LOOP_ROSTER_VERSION) throw new Error("Loop roster version is unsupported.");
  const agents = objectValue(root.agents, "loop roster.agents");
  const parsed = emptyRoster();
  for (const agent of LOOP_AGENTS) {
    if (agents[agent] === undefined) continue;
    const entry = objectValue(agents[agent], `loop roster.agents.${agent}`);
    if (entry.modelID === "") {
      parsed.agents[agent] = { modelID: "" };
      continue;
    }
    const modelID = stringValue(entry.modelID, `loop roster.agents.${agent}.modelID`).trim();
    if (modelID && !MODEL_ID_PATTERN.test(modelID)) {
      throw new Error(`Loop agent ${agent} model ID is invalid.`);
    }
    parsed.agents[agent] = { modelID };
  }
  return parsed;
}

export function loadLoopRoster(path = loopRosterPath()): LoopRoster {
  try {
    return parseLoopRoster(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return emptyRoster();
    throw error;
  }
}

function writeRosterFile(roster: LoopRoster, path: string): void {
  const encoded = `${JSON.stringify(roster, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 8_192 || /(?:api.?key|authorization|bearer\s|(?:csk|sk)-[a-z0-9])/iu.test(encoded)) {
    throw new Error("Loop roster must remain bounded and credential-free.");
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Loop roster directory is unsafe.");
  }
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 16_384) {
      throw new Error("Existing loop roster is unsafe.");
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  const temporary = join(parent, `.agents.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, encoded, "utf8");
    fstatSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function saveLoopAgentModel(agent: LoopAgent, modelID: string, path = loopRosterPath()): LoopRoster {
  if (!isLoopAgent(agent)) throw new Error("Unknown loop agent.");
  const trimmed = modelID.trim();
  if (trimmed && !MODEL_ID_PATTERN.test(trimmed)) throw new Error("Loop agent model ID is invalid.");
  const roster = loadLoopRoster(path);
  roster.agents[agent] = { modelID: trimmed };
  writeRosterFile(roster, path);
  return roster;
}

export function resolveAgentModelID(roster: LoopRoster, agent: LoopAgent, fallbackModelID: string): string {
  return roster.agents[agent].modelID || fallbackModelID;
}

export interface RosterMember {
  agent: LoopAgent;
  modelID: string;
  adapter: AgentAdapter;
}

export interface RosterCallProvenance {
  requestRole: AgentRequest["role"];
  agent: LoopAgent;
  modelID: string;
}

export class RosterAdapter implements AgentAdapter {
  readonly supportsImages?: boolean;

  constructor(
    private readonly members: readonly RosterMember[],
    private readonly fallback: AgentAdapter,
    private readonly onProvenance?: (provenance: RosterCallProvenance) => void,
  ) {
    if (this.members.length !== LOOP_AGENTS.length) {
      throw new Error("RosterAdapter requires Researcher, Engineer, and Verifier members.");
    }
    this.supportsImages = fallback.supportsImages === true || this.members.some((member) => member.adapter.supportsImages === true);
  }

  private memberFor(role: AgentRequest["role"]): RosterMember {
    const agent = loopAgentForRequestRole(role);
    const member = this.members.find((item) => item.agent === agent);
    if (!member) throw new Error(`Roster is missing the ${agent} agent.`);
    return member;
  }

  async complete(request: AgentRequest, signal?: AbortSignal): Promise<AgentReply> {
    const member = this.memberFor(request.role);
    this.onProvenance?.({ requestRole: request.role, agent: member.agent, modelID: member.modelID });
    return member.adapter.complete(request, signal);
  }
}

export async function buildRosterMembers(
  profile: ProviderProfile,
  roster: LoopRoster,
  createAdapter: (memberProfile: ProviderProfile) => Promise<AgentAdapter>,
): Promise<RosterMember[]> {
  const members: RosterMember[] = [];
  for (const agent of LOOP_AGENTS) {
    const modelID = resolveAgentModelID(roster, agent, profile.modelID);
    const memberProfile: ProviderProfile = modelID === profile.modelID
      ? profile
      : { ...profile, modelID, modelName: modelID };
    members.push({
      agent,
      modelID,
      adapter: await createAdapter(memberProfile),
    });
  }
  return members;
}

export function formatRosterLines(roster: LoopRoster, fallbackModelID: string): string[] {
  return LOOP_AGENTS.map((agent) => {
    const assigned = roster.agents[agent].modelID;
    const model = assigned || fallbackModelID || "(provider default)";
    const source = assigned ? "pinned" : "provider default";
    return `${agent}: ${model} · ${source}`;
  });
}
