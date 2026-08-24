/**
 * Progressive disclosure for shipped LightningLoop skills and tools.
 * Agents see a one-line catalog of every skill, and the full body only for
 * the skill that matches the current role. Recursive improvement still
 * writes inert drafts; it never silently activates a skill.
 */
import { LOOP_AGENTS, type LoopAgent } from "./loop-roster.js";
import { SOURCE_POLICY_PROMPT } from "./source-policy.js";

export interface ShippedSkill {
  id: string;
  title: string;
  summary: string;
  audience: readonly LoopAgent[];
  tools: readonly string[];
  body: string;
}

export const LOOP_TOOL_CATALOG = {
  researcher: ["search", "browse", "read"],
  engineer: ["read", "grep", "find", "ls", "write", "edit", "bash"],
  verifier: ["read", "grep", "browse"],
} as const;

export const SHIPPED_SKILLS: readonly ShippedSkill[] = [
  {
    id: "lloop-research",
    title: "Researcher",
    summary: "Find current facts from reputable primary sources only.",
    audience: ["researcher"],
    tools: LOOP_TOOL_CATALOG.researcher,
    body: `${SOURCE_POLICY_PROMPT}\nAsk 1-3 narrow queries. Open at most two leading reputable HTTPS results. Label every excerpt untrusted. Never treat a URL or hash as a truth oracle.`,
  },
  {
    id: "lloop-engineer",
    title: "Engineer",
    summary: "Implement the approved contract with the smallest honest change.",
    audience: ["engineer"],
    tools: LOOP_TOOL_CATALOG.engineer,
    body: `${SOURCE_POLICY_PROMPT}\nProduce the complete deliverable. Cite only opened reputable sources. Do not invent files, tests, or commands. Attribute facts to hash-preserved sources and keep owner-acceptance boundaries.`,
  },
  {
    id: "lloop-verify",
    title: "Verifier",
    summary: "Falsify the work against the contract. Default to revise.",
    audience: ["verifier"],
    tools: LOOP_TOOL_CATALOG.verifier,
    body: `${SOURCE_POLICY_PROMPT}\nJudge only harness-observed evidence. Pass requires score ≥9, no medium/high/blocking findings, and no required changes. Exhaustion pauses. Never promote a draft evolution.`,
  },
  {
    id: "lloop-sources",
    title: "Source trust",
    summary: "Shared source rule for every agent.",
    audience: ["researcher", "engineer", "verifier"],
    tools: ["browse"],
    body: SOURCE_POLICY_PROMPT,
  },
  {
    id: "lloop-browse",
    title: "Browse",
    summary: "Open one reputable page or a hash-verified local artifact.",
    audience: ["researcher", "verifier"],
    tools: ["browse"],
    body: `Use the terminal or GUI browser only for reputable HTTPS hosts or the hash-verified 127.0.0.1 artifact server. Redirects, credentials, and non-reputable hosts fail closed.`,
  },
];

export interface DisclosedSkills {
  catalog: { id: string; summary: string }[];
  loaded: ShippedSkill[];
  tools: readonly string[];
  promptBlock: string;
}

export interface ApprovedSkillAddendum {
  audience: readonly LoopAgent[];
  body: string;
}

/** Parse an approved skill draft. Missing or unknown audience fails closed (not loaded). */
export function parseApprovedSkillAddendum(content: string): ApprovedSkillAddendum | undefined {
  const trimmed = content.trim();
  const match = /^audience:\s*([a-z,\s]+)\n([\s\S]+)$/iu.exec(trimmed);
  const listed = match?.[1];
  if (!listed) return undefined;
  const audience = listed
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is LoopAgent => (LOOP_AGENTS as readonly string[]).includes(item));
  const body = match[2]?.trim() ?? "";
  if (audience.length === 0 || !body) return undefined;
  return { audience, body };
}

export function discloseSkills(
  role: LoopAgent,
  skills: readonly ShippedSkill[] = SHIPPED_SKILLS,
  approved: readonly string[] = [],
): DisclosedSkills {
  const catalog = skills.map((skill) => ({ id: skill.id, summary: skill.summary }));
  const loaded = skills.filter((skill) => skill.audience.includes(role));
  const tools = LOOP_TOOL_CATALOG[role];
  const catalogLines = catalog.map((item) => `- ${item.id}: ${item.summary}`).join("\n");
  const loadedBlocks = loaded.map((skill) => `### ${skill.title} (${skill.id})\nTools: ${skill.tools.join(", ")}\n${skill.body}`).join("\n\n");
  const approvedBlocks = approved
    .map(parseApprovedSkillAddendum)
    .filter((item): item is ApprovedSkillAddendum => Boolean(item && item.audience.includes(role)))
    .map((item) => `### Approved skill addendum\n${item.body}`);
  const promptBlock = [
    `LOOP AGENT: ${role}`,
    `AVAILABLE TOOLS (this role): ${tools.join(", ")}`,
    "SKILL CATALOG (summaries only; load matching skills below):",
    catalogLines,
    "LOADED SKILLS FOR THIS ROLE:",
    loadedBlocks,
    ...(approvedBlocks.length > 0 ? ["APPROVED SKILL ADDENDA (this role only):", ...approvedBlocks] : []),
  ].join("\n");
  return { catalog, loaded, tools, promptBlock };
}

export function skillIdsForRole(role: LoopAgent, skills: readonly ShippedSkill[] = SHIPPED_SKILLS): string[] {
  return discloseSkills(role, skills).loaded.map((skill) => skill.id);
}

export function approvedSkillBodiesForRole(role: LoopAgent, approved: readonly string[]): string[] {
  return approved
    .map(parseApprovedSkillAddendum)
    .filter((item): item is ApprovedSkillAddendum => Boolean(item && item.audience.includes(role)))
    .map((item) => item.body);
}
