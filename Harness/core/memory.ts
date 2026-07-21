import type { MemoryEntry, MemoryScope } from "./schema.js";

const SCOPE_WEIGHT: Record<MemoryScope, number> = { run: 3, project: 2, user: 1 };

export function eligibleMemory(
  entries: readonly MemoryEntry[],
  allowedScopes: readonly MemoryScope[],
  now = new Date(),
): MemoryEntry[] {
  const scopes = new Set(allowedScopes);
  return entries
    .filter((entry) => scopes.has(entry.scope))
    .filter((entry) => entry.sensitivity !== "secret_prohibited")
    .filter((entry) => entry.verification !== "contradicted")
    .filter((entry) => !entry.supersededBy)
    .filter((entry) => !entry.expiresAt || new Date(entry.expiresAt) > now)
    .filter((entry) => entry.scope === "run" || entry.promotionApprovedByUser)
    .sort((a, b) => {
      const scope = SCOPE_WEIGHT[b.scope] - SCOPE_WEIGHT[a.scope];
      return scope !== 0 ? scope : b.confidence - a.confidence;
    });
}
