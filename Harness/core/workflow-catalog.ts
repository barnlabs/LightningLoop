export type BuiltinWorkflow = "photo_to_3d" | "software" | "website";

const GUIDANCE: Record<BuiltinWorkflow, string> = {
  photo_to_3d: `LightningLoop built-in workflow: photo to 3D relief.
- Confirm the user owns or is authorized to use the image and state that one view cannot recover hidden geometry.
- For a bounded single-image approximation in artifact mode, use the immutable seeded tooling/photo_to_relief.mjs through the confirmed sandboxed verifier.
- Keep source and outputs inside the approved workspace. Produce relief.glb, relief.obj, preview.png, and report.json.
- Gold requires the GLB to reopen, a nonempty mesh and material, a preview render, dimensions/counts in the report, and the 2.5D limitation disclosed.
- For true multi-view reconstruction, pause unless multiple suitable views and a separately reviewed reconstruction toolchain are available.`,
  software: `LightningLoop built-in workflow: advanced application or script.
- Establish platform, behavior, data/security constraints, testable done conditions, and deployment boundary before editing.
- Inspect the repository and preserve user changes. Mutations and commands must use the confirmed OS-sandboxed shell.
- Gold requires relevant lint/type/test/build gates, an actual run, diff review, dependency/security review, failure-state coverage, and rollback notes.
- Never treat generated source text as implementation evidence.`,
  website: `LightningLoop built-in workflow: intentional responsive website.
- Establish audience/job, content, art direction, brand assets, routes, accessibility constraints, and hosting boundary.
- Use local assets with provenance; avoid generic template filler and unauthorized hotlinks.
- Gold requires real-browser proof at 375 and 1280 CSS pixels, keyboard/focus checks, reduced-motion behavior, long/empty/error states, zero console errors, and reviewed network failures.
- Preview deployment and production deployment are separate capabilities.`,
};

export function routeBuiltinWorkflows(prompt: string): BuiltinWorkflow[] {
  const normalized = prompt.toLowerCase();
  const result: BuiltinWorkflow[] = [];
  if (/\b(photo|image|picture)\b.*\b(3d|mesh|glb|gltf|blender|model)\b|\b(3d|mesh)\b.*\b(photo|image|picture)\b/.test(normalized)) {
    result.push("photo_to_3d");
  }
  if (/\b(site|website|web site|landing page|frontend|responsive site)\b/.test(normalized)) result.push("website");
  if (/\b(app|application|script|cli|service|api|program)\b/.test(normalized) && !result.includes("website")) result.push("software");
  return result;
}

export function builtinWorkflowGuidance(prompt: string): string {
  return routeBuiltinWorkflows(prompt).map((workflow) => GUIDANCE[workflow]).join("\n\n");
}
