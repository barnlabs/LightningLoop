/**
 * Deterministic project identity derived from a filesystem root.
 *
 * The same directory always yields the same id; different directories yield
 * different ids. The id is a bounded, opaque token (a truncated SHA-256 of the
 * normalized absolute path — no path bytes leak), so it is safe to store in the
 * memory ledger and to match at run time when resolving project-scoped desires.
 */
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

export interface ProjectIdentity {
  id: string;
  root: string;
}

function normalizeRoot(root: string): string {
  const absolute = resolve(root && root.trim() ? root : ".");
  // "/a/b" and "/a/b/" are the same project.
  const trimmed = absolute.length > 1 && absolute.endsWith(sep) ? absolute.slice(0, -1) : absolute;
  // Case-fold on case-insensitive platforms so the id is stable there.
  return process.platform === "win32" || process.platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

/** Derive the stable {@link ProjectIdentity} for a workspace/project root. */
export function deriveProjectIdentity(root: string): ProjectIdentity {
  const normalized = normalizeRoot(root);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return { id: `proj_${digest}`, root: normalized };
}
