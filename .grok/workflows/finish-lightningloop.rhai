// Finish LightningLoop: inventory → dual frozen-packet review → optional local
// repair/re-proof → owner gate → delivery handoff report.
//
// Product: barnlabs/LightningLoop
// Local checkout (typical): /Users/baney/Documents/Loop
// SoT packet: docs/REVIEW_PACKET_2026-07-21_FINISH.md
// Checklist: PRODUCTION_READINESS_CHECKLIST.md
//
// Launch examples:
//   /workflow finish-lightningloop
//   /workflow finish-lightningloop {"mode":"review-only"}
//   /workflow finish-lightningloop {"mode":"finish-local","repo_root":"/Users/baney/Documents/Loop"}
//   /workflow finish-lightningloop {"mode":"full"}
//
// Modes:
//   review-only  — inventory + dual adversarial review + report (default safe)
//   finish-local — after PASS: re-run local gates; repair only if both reviews say REWORK
//   full         — finish-local, then pause for owner git authorization and emit
//                  exact delivery commands (never force-push/merge/release)
//
// Hard stop boundaries (encoded in prompts + this script):
//   - No commit/push/PR without owner resume after review PASS
//   - Never stage AGENTS.md; only the packet safe-stage manifest
//   - No signing, notarization, visibility change, secrets, or release
//   - No Pi credential / ~/.pi reads
//   - Fresh branch only: contrib/lightningloop-product-finish

let meta = #{
    name: "finish-lightningloop",
    description: "Finish LightningLoop product packet: inventory, dual adversarial frozen review, local re-proof, owner-gated delivery handoff",
    when_to_use: "Drive LightningLoop (Documents/Loop / barnlabs/LightningLoop) from local-green packet to reviewed draft-PR handoff without unauthorized git or release actions",
    phases: [
        #{ title: "Inventory", detail: "checkout, checklist, packet, GitHub identity" },
        #{ title: "DualReview", detail: "two independent frozen-packet adversarial reviewers" },
        #{ title: "ProductUX", detail: "session titles + provider model loading contracts" },
        #{ title: "Gate", detail: "optional local re-proof / bounded repair" },
        #{ title: "Handoff", detail: "owner gate + delivery report" },
    ],
};

let inventory_schema = #{
    "type": "object",
    "required": ["checkout", "branch", "head", "canonical_repo", "packet_path", "checklist_path", "rework_ids", "missing_ids", "local_green_count", "safe_to_review", "notes"],
    "properties": #{
        "checkout": #{ "type": "string" },
        "branch": #{ "type": "string" },
        "head": #{ "type": "string" },
        "canonical_repo": #{ "type": "string" },
        "packet_path": #{ "type": "string" },
        "checklist_path": #{ "type": "string" },
        "rework_ids": #{ "type": "array", "maxItems": 20, "items": #{ "type": "string" } },
        "missing_ids": #{ "type": "array", "maxItems": 20, "items": #{ "type": "string" } },
        "local_green_count": #{ "type": "integer" },
        "safe_to_review": #{ "type": "boolean" },
        "notes": #{ "type": "string" },
    },
};

let review_schema = #{
    "type": "object",
    "required": ["verdict", "reviewer_label", "findings", "summary"],
    "properties": #{
        "verdict": #{ "type": "string" },
        "reviewer_label": #{ "type": "string" },
        "findings": #{
            "type": "array",
            "maxItems": 12,
            "items": #{
                "type": "object",
                "required": ["severity", "file", "issue"],
                "properties": #{
                    "severity": #{ "type": "string" },
                    "file": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                },
            },
        },
        "summary": #{ "type": "string" },
    },
};

let gate_schema = #{
    "type": "object",
    "required": ["ok", "commands_run", "failures", "notes"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "commands_run": #{ "type": "array", "maxItems": 20, "items": #{ "type": "string" } },
        "failures": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
        "notes": #{ "type": "string" },
    },
};

let repair_schema = #{
    "type": "object",
    "required": ["attempted", "files_touched", "remaining", "notes"],
    "properties": #{
        "attempted": #{ "type": "boolean" },
        "files_touched": #{ "type": "array", "maxItems": 40, "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
        "notes": #{ "type": "string" },
    },
};

// --- args (guard unit before field access) ---
let repo_root = "/Users/baney/Documents/Loop";
let mode = "review-only";
if args != () {
    if args.repo_root != () && type_of(args.repo_root) == "string" && args.repo_root != "" {
        repo_root = args.repo_root;
    }
    if args.mode != () && type_of(args.mode) == "string" && args.mode != "" {
        mode = args.mode;
    }
}
if mode != "review-only" && mode != "finish-local" && mode != "full" {
    pause("verification", "args.mode must be review-only | finish-local | full");
}

let root_safe = json_encode(repo_root);
let mode_safe = json_encode(mode);
log("finish-lightningloop mode=" + mode + " root=" + repo_root);

// ---------------------------------------------------------------------------
// Phase 1 — Inventory
// ---------------------------------------------------------------------------
phase("Inventory");

let inv_prompt = "";
inv_prompt += "You are inventorying LightningLoop for a product-finish workflow. ";
inv_prompt += "Repo root is this JSON string: " + root_safe + ". ";
inv_prompt += "Mode is this JSON string: " + mode_safe + ". ";
inv_prompt += "Use ONLY read-only tools (run_terminal_command for git/gh status, read_file, list_dir, grep). ";
inv_prompt += "Do not edit files, do not git write, do not push, do not open PRs, do not touch credentials or ~/.pi. ";
inv_prompt += "REQUIRED steps (run them for real; do not invent): ";
inv_prompt += "1) cd to the repo root; run: git status --short --branch; git rev-parse HEAD; git remote -v; git branch -vv. ";
inv_prompt += "2) Read PRODUCTION_READINESS_CHECKLIST.md and list every LL-### row with Status REWORK or MISSING as IDs. ";
inv_prompt += "Count rows with Status LOCAL as local_green_count. ";
inv_prompt += "3) Confirm docs/REVIEW_PACKET_2026-07-21_FINISH.md exists; set packet_path to its absolute path. ";
inv_prompt += "checklist_path is absolute path to PRODUCTION_READINESS_CHECKLIST.md. ";
inv_prompt += "4) Run: gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef ";
inv_prompt += "and set canonical_repo to nameWithOwner (expect barnlabs/LightningLoop). ";
inv_prompt += "5) safe_to_review=true only if the finish packet exists and the checkout looks like the LightningLoop product tree ";
inv_prompt += "(README mentions LightningLoop, LightningLoop/ Swift sources or Harness/ present). ";
inv_prompt += "notes: short factual status (dirty tree, branch name, whether packet claims local gates green). ";
inv_prompt += "rework_ids/missing_ids: short strings like LL-010. Empty arrays only after reading the checklist. ";
inv_prompt += "Return the inventory_schema fields only.";

let inv = agent(inv_prompt, #{
    label: "inventory",
    capability_mode: "execute",
    output_schema: inventory_schema,
});

if inv == () || !inv.success || inv.output == () {
    complete(#{
        summary: "Inventory agent failed; cannot finish LightningLoop safely.",
        mode: mode,
        ok: false,
        stage: "inventory",
    });
}

let inv_out = inv.output;
if inv_out.safe_to_review != true {
    let n = if inv_out.notes != () { inv_out.notes } else { "safe_to_review=false" };
    complete(#{
        summary: "Checkout is not safe to review: " + n,
        mode: mode,
        ok: false,
        stage: "inventory",
        inventory: inv_out,
    });
}

log("inventory ok branch=" + inv_out.branch + " head=" + inv_out.head);

// ---------------------------------------------------------------------------
// Phase 1b — Product UX contracts (titles + model loading)
// ---------------------------------------------------------------------------
phase("ProductUX");

let ux_schema = #{
    "type": "object",
    "required": ["titles_ok", "models_ok", "findings", "summary"],
    "properties": #{
        "titles_ok": #{ "type": "boolean" },
        "models_ok": #{ "type": "boolean" },
        "findings": #{ "type": "array", "maxItems": 10, "items": #{ "type": "string" } },
        "summary": #{ "type": "string" },
    },
};

let ux_prompt = "";
ux_prompt += "Audit LightningLoop product UX for session titles and provider model loading. ";
ux_prompt += "Repo root JSON: " + root_safe + ". Read-only tools only. ";
ux_prompt += "REQUIRED reads: LightningLoop/Support/SessionTitle.swift, docs/SESSION_TITLES.md, docs/MODEL_SELECTION.md, ";
ux_prompt += "AppModel title + refreshRuntimeModelCatalog/testConnection paths, SettingsView inference copy. ";
ux_prompt += "titles_ok=true only if: provisional heuristic + structured plan/criterion titles + manual lock + optional custom-only LLM fail-soft exist. ";
ux_prompt += "models_ok=true only if: built-in catalog is credential-free installed runtime (not live /models), custom uses user-triggered /models, ";
ux_prompt += "Settings copy states catalogued != entitlement, and stale catalog rejection remains. ";
ux_prompt += "findings: short strings for gaps. summary: 2-4 sentences.";

let ux = agent(ux_prompt, #{
    label: "product-ux-titles-models",
    capability_mode: "execute",
    output_schema: ux_schema,
});
if ux != () && ux.success && ux.output != () {
    log("product UX titles_ok=" + ux.output.titles_ok.to_string() + " models_ok=" + ux.output.models_ok.to_string());
} else {
    log("product UX audit agent failed or unusable");
}

// ---------------------------------------------------------------------------
// Phase 2 — Dual independent frozen-packet review
// ---------------------------------------------------------------------------
phase("DualReview");

let packet_safe = json_encode(inv_out.packet_path);
let head_safe = json_encode(inv_out.head);
let branch_safe = json_encode(inv_out.branch);

fn make_reviewer_prompt(label, angle, root_json, packet_json, head_json, branch_json) {
    let p = "";
    p += "You are an independent adversarial reviewer for the LightningLoop product-finish packet. ";
    p += "Reviewer label: " + label + ". Angle: " + angle + ". ";
    p += "Repo root JSON: " + root_json + ". Packet path JSON: " + packet_json + ". ";
    p += "Claimed HEAD JSON: " + head_json + ". Branch JSON: " + branch_json + ". ";
    p += "Read-only tools only. Do NOT edit, commit, push, stage, or mutate GitHub settings. ";
    p += "Never read Pi credentials or ~/.pi. Never invent PASS without file/command evidence. ";
    p += "REQUIRED: ";
    p += "A) read_file the finish packet fully (docs/REVIEW_PACKET_2026-07-21_FINISH.md). ";
    p += "B) Verify the Exact safe-stage manifest vs live git: run git diff --name-only and git ls-files --others --exclude-standard from the repo root; ";
    p += "compare to the 68-path list; AGENTS.md must remain unstaged/excluded. ";
    p += "C) Answer the packet Reviewer questions 1-8 by reading the cited sources (Harness/rpc/server.ts, update-policy, build_and_run.sh, Swift settings views, tests). ";
    p += "D) Spot-check at least two focused tests or implementation files with read_file/grep for your angle. ";
    p += "verdict MUST be exactly one of: PASS, REWORK, BLOCKED (uppercase). ";
    p += "PASS only if all eight questions are acceptably closed for this packet AND no material defect remains. ";
    p += "REWORK if local-fixable defects remain without secret/signing requirements. ";
    p += "BLOCKED if signing/release secrets, live accessibility host gate, or irreversible remote actions are required before delivery. ";
    p += "findings: at most 12 concrete {severity: high|medium|low, file, issue}; empty only after real inspection. ";
    p += "summary: 2-5 sentences with evidence. Set reviewer_label to " + label + ".";
    return p;
}

let review_jobs = [];
review_jobs.push(#{
    prompt: make_reviewer_prompt(
        "reviewer-A-security-runtime",
        "credential/catalog/RPC exclusivity/update URL fail-closed and release-claim boundaries",
        root_safe, packet_safe, head_safe, branch_safe
    ),
    label: "reviewer-A",
    capability_mode: "execute",
    output_schema: review_schema,
});
review_jobs.push(#{
    prompt: make_reviewer_prompt(
        "reviewer-B-product-delivery",
        "manifest completeness, UI/fixture vs live proof honesty, brand/handoff, git delivery proposal, no invented claims",
        root_safe, packet_safe, head_safe, branch_safe
    ),
    label: "reviewer-B",
    capability_mode: "execute",
    output_schema: review_schema,
});

let reviews = parallel(review_jobs);

let review_a = ();
let review_b = ();
if reviews.len() > 0 { review_a = reviews[0]; }
if reviews.len() > 1 { review_b = reviews[1]; }

let verdict_a = "BLOCKED";
let verdict_b = "BLOCKED";
let summary_a = "reviewer-A missing or failed";
let summary_b = "reviewer-B missing or failed";
let findings_all = [];

if review_a != () && review_a.success && review_a.output != () {
    if review_a.output.verdict != () { verdict_a = review_a.output.verdict; }
    if review_a.output.summary != () { summary_a = review_a.output.summary; }
    if review_a.output.findings != () {
        for f in review_a.output.findings { findings_all.push(f); }
    }
}
if review_b != () && review_b.success && review_b.output != () {
    if review_b.output.verdict != () { verdict_b = review_b.output.verdict; }
    if review_b.output.summary != () { summary_b = review_b.output.summary; }
    if review_b.output.findings != () {
        for f in review_b.output.findings { findings_all.push(f); }
    }
}

log("dual review A=" + verdict_a + " B=" + verdict_b + " findings=" + findings_all.len().to_string());

// Fail closed: both must be PASS for delivery path. Mixed REWORK is repairable under finish-local/full.
let both_pass = verdict_a == "PASS" && verdict_b == "PASS";
let any_blocked = verdict_a == "BLOCKED" || verdict_b == "BLOCKED";
let any_rework = verdict_a == "REWORK" || verdict_b == "REWORK";

// ---------------------------------------------------------------------------
// Early complete for review-only
// ---------------------------------------------------------------------------
if mode == "review-only" {
    phase("Handoff");
    let report = "";
    report += "# LightningLoop finish workflow — review-only\n\n";
    report += "- Checkout: " + inv_out.checkout + "\n";
    report += "- Branch: " + inv_out.branch + "\n";
    report += "- HEAD: " + inv_out.head + "\n";
    report += "- Canonical: " + inv_out.canonical_repo + "\n";
    report += "- Reviewer A: " + verdict_a + " — " + summary_a + "\n";
    report += "- Reviewer B: " + verdict_b + " — " + summary_b + "\n";
    report += "- Both PASS: " + both_pass.to_string() + "\n";
    report += "- REWORK IDs (checklist): " + json_encode(inv_out.rework_ids) + "\n";
    report += "- MISSING IDs (release human path): " + json_encode(inv_out.missing_ids) + "\n\n";
    report += "Next: re-run with mode finish-local after PASS, or full for owner-gated git handoff.\n";
    report += "Do not commit until both independent reviewers return PASS against the frozen packet.\n";

    let path = write_scratch_file("finish-lightningloop-report.md", report);
    complete(#{
        summary: "Review-only complete. A=" + verdict_a + " B=" + verdict_b,
        ok: both_pass,
        mode: mode,
        stage: "review-only",
        path: path,
        inventory: inv_out,
        verdict_a: verdict_a,
        verdict_b: verdict_b,
        findings: findings_all,
        next: "Run mode finish-local or full after dual PASS",
    });
}

// ---------------------------------------------------------------------------
// Phase 3 — Gate: optional repair + local re-proof
// ---------------------------------------------------------------------------
phase("Gate");

let repair_out = #{
    attempted: false,
    files_touched: [],
    remaining: [],
    notes: "no repair",
};

if any_blocked && !both_pass {
    log("blocked by dual review; skipping repair that cannot clear host/signing blockers");
}

// Bounded repair only when REWORK (not BLOCKED) and not both PASS
if any_rework && !any_blocked && !both_pass {
    let findings_safe = json_encode(findings_all);
    let repair_prompt = "";
    repair_prompt += "You are repairing LightningLoop after dual review returned REWORK. ";
    repair_prompt += "Repo root JSON: " + root_safe + ". ";
    repair_prompt += "Findings JSON: " + findings_safe + ". ";
    repair_prompt += "Implement the SMALLEST local-fixable fixes only. ";
    repair_prompt += "Hard bans: no git commit/push/PR, no .git/config edits, no secrets, no signing/notarize, ";
    repair_prompt += "no Pi credentials/~/.pi, no staging AGENTS.md, no inventing release claims, ";
    repair_prompt += "no weakening macOS accessibility, no npm ci unless already authorized and needed for compile. ";
    repair_prompt += "Prefer tests first then code. After edits run focused proof: ";
    repair_prompt += "npm run build:harness && node --test dist/rpc/server.test.js dist/update/update-policy.test.js ";
    repair_prompt += "when Harness changes; note native xcodebuild only if Swift changed and Xcode is available. ";
    repair_prompt += "files_touched: real paths you edited. remaining: what still needs owner/host. ";
    repair_prompt += "attempted=true if you made any edit.";

    let rep = agent(repair_prompt, #{
        label: "repair-rework",
        capability_mode: "all",
        output_schema: repair_schema,
    });
    if rep != () && rep.success && rep.output != () {
        repair_out = rep.output;
    } else {
        repair_out = #{
            attempted: false,
            files_touched: [],
            remaining: ["repair agent failed"],
            notes: "repair agent failed or returned unusable output",
        };
    }
}

// Local re-proof when finishing
let gate_out = #{
    ok: false,
    commands_run: [],
    failures: ["not run"],
    notes: "skipped",
};

let gate_prompt = "";
gate_prompt += "Re-prove LightningLoop local finish gates from repo root JSON: " + root_safe + ". ";
gate_prompt += "Use shell for verification only. Do NOT commit, push, edit git config, or touch credentials/~/.pi. ";
gate_prompt += "Do NOT run npm ci unless node_modules is missing and you document that install was required. ";
gate_prompt += "Run in order when possible and record exact commands + pass/fail: ";
gate_prompt += "1) npm run verify:harness (or npm run build:harness && node --test if full verify too heavy — prefer full verify). ";
gate_prompt += "2) git diff --check ";
gate_prompt += "3) node dist/cli/index.js update check  (if dist exists after build) ";
gate_prompt += "4) If xcodebuild is available and Swift sources exist: note whether native tests already documented as green in packet; ";
gate_prompt += "run native tests only if repair touched Swift OR if mode needs fresh proof and time allows. ";
gate_prompt += "ok=true only if the harness/diff checks you ran all passed. ";
gate_prompt += "commands_run: list exact commands. failures: non-empty strings for each failure. notes: short.";

let gate = agent(gate_prompt, #{
    label: "local-gates",
    capability_mode: "all",
    output_schema: gate_schema,
});
if gate != () && gate.success && gate.output != () {
    gate_out = gate.output;
}

// If dual review did not both PASS, stop before owner git handoff
if !both_pass {
    phase("Handoff");
    let report = "";
    report += "# LightningLoop finish — stopped before delivery\n\n";
    report += "Dual review did not both PASS (A=" + verdict_a + ", B=" + verdict_b + ").\n\n";
    report += "## Inventory\n";
    report += "- Branch: " + inv_out.branch + "\n";
    report += "- HEAD: " + inv_out.head + "\n";
    report += "- REWORK checklist IDs: " + json_encode(inv_out.rework_ids) + "\n";
    report += "- MISSING (human release path): " + json_encode(inv_out.missing_ids) + "\n\n";
    report += "## Reviewer A\n" + summary_a + "\n\n";
    report += "## Reviewer B\n" + summary_b + "\n\n";
    report += "## Repair\n" + json_encode(repair_out) + "\n\n";
    report += "## Local gates\n" + json_encode(gate_out) + "\n\n";
    report += "Action: fix findings, freeze a new packet if needed, re-run this workflow.\n";
    report += "Do not create delivery branch or draft PR until both reviewers PASS.\n";
    let path = write_scratch_file("finish-lightningloop-report.md", report);
    complete(#{
        summary: "Stopped: dual review not both PASS (A=" + verdict_a + " B=" + verdict_b + ")",
        ok: false,
        mode: mode,
        stage: "pre-delivery-block",
        path: path,
        inventory: inv_out,
        verdict_a: verdict_a,
        verdict_b: verdict_b,
        findings: findings_all,
        repair: repair_out,
        gates: gate_out,
    });
}

if gate_out.ok != true {
    phase("Handoff");
    let report = "";
    report += "# LightningLoop finish — local gates failed after dual PASS\n\n";
    report += "Dual review PASS, but local re-proof failed. Do not deliver.\n\n";
    report += json_encode(gate_out) + "\n";
    let path = write_scratch_file("finish-lightningloop-report.md", report);
    complete(#{
        summary: "Dual PASS but local gates failed; no delivery",
        ok: false,
        mode: mode,
        stage: "gates-failed",
        path: path,
        inventory: inv_out,
        verdict_a: verdict_a,
        verdict_b: verdict_b,
        gates: gate_out,
    });
}

// finish-local ends after green gates + dual PASS
if mode == "finish-local" {
    phase("Handoff");
    let report = "";
    report += "# LightningLoop finish-local — READY for owner git gate\n\n";
    report += "Both independent reviewers: PASS. Local gates: ok.\n\n";
    report += "Still NOT delivered. Remaining MISSING release rows require human Apple/signing authority:\n";
    report += json_encode(inv_out.missing_ids) + "\n\n";
    report += "Live UI/accessibility REWORK rows may remain host-blocked (LL-010/011).\n\n";
    report += "Next: re-run with mode full and resume the owner gate to prepare delivery branch commands, ";
    report += "or execute delivery yourself:\n";
    report += "  git switch -c contrib/lightningloop-product-finish\n";
    report += "  stage ONLY the 68-path safe-stage manifest from the finish packet\n";
    report += "  commit once; push HEAD to barnlabs/LightningLoop; open DRAFT PR to main\n";
    report += "Never force-push, merge, tag, release, or stage AGENTS.md.\n";
    let path = write_scratch_file("finish-lightningloop-report.md", report);
    complete(#{
        summary: "finish-local READY: dual PASS + local gates ok; owner git gate not run",
        ok: true,
        mode: mode,
        stage: "finish-local-ready",
        path: path,
        inventory: inv_out,
        verdict_a: verdict_a,
        verdict_b: verdict_b,
        gates: gate_out,
        next: "mode full + owner resume for delivery handoff",
    });
}

// ---------------------------------------------------------------------------
// Phase 4 — full mode: owner authorization before any git delivery advice
// ---------------------------------------------------------------------------
phase("Handoff");
await_user(
    "user",
    "Dual review PASS and local gates ok. Resume to authorize the delivery HAND-OFF REPORT only (exact git commands + safe-stage list). This run will NOT push/merge/release by itself unless a follow-up agent is explicitly instructed after you resume. Reply by resuming the workflow."
);

let handoff_prompt = "";
handoff_prompt += "Produce the LightningLoop delivery handoff for Donovan. ";
handoff_prompt += "Repo root JSON: " + root_safe + ". ";
handoff_prompt += "Packet path JSON: " + packet_safe + ". ";
handoff_prompt += "Read the finish packet safe-stage 68-path manifest and current git status. ";
handoff_prompt += "capability: execute for read-only git/gh inspection. ";
handoff_prompt += "HARD BAN: do not git commit, push, force-push, merge, tag, release, edit .git/config, ";
handoff_prompt += "change GitHub settings/visibility, or open a PR unless the user already did so. ";
handoff_prompt += "Only PRINT the exact command sequence the owner should run: ";
handoff_prompt += "1) create fresh branch contrib/lightningloop-product-finish from current dirty tree (not reuse codex/lightningloop) ";
handoff_prompt += "2) git add -- <each of the 68 paths>  (never AGENTS.md) ";
handoff_prompt += "3) git diff --cached --check && git diff --cached --name-only ";
handoff_prompt += "4) git commit -m 'feat: LightningLoop product finish packet' ";
handoff_prompt += "5) git push -u https://github.com/barnlabs/LightningLoop.git HEAD:refs/heads/contrib/lightningloop-product-finish ";
handoff_prompt += "6) gh pr create --draft --base main --head contrib/lightningloop-product-finish --fill ";
handoff_prompt += "Also list remaining MISSING checklist IDs that still block signed/notarized public release. ";
handoff_prompt += "Put the full markdown into notes; set ok=true if the handoff text is complete; commands_run can list the recommended commands; failures empty if none.";

let handoff = agent(handoff_prompt, #{
    label: "delivery-handoff",
    capability_mode: "execute",
    output_schema: gate_schema,
});

let handoff_notes = "handoff agent failed";
let handoff_ok = false;
if handoff != () && handoff.success && handoff.output != () {
    if handoff.output.notes != () { handoff_notes = handoff.output.notes; }
    if handoff.output.ok == true { handoff_ok = true; }
}

let report = "";
report += "# LightningLoop full finish handoff\n\n";
report += "## Status\n";
report += "- Dual review: PASS / PASS\n";
report += "- Local gates: ok\n";
report += "- Branch (current): " + inv_out.branch + "\n";
report += "- HEAD: " + inv_out.head + "\n";
report += "- Canonical repo: " + inv_out.canonical_repo + "\n\n";
report += "## Delivery handoff\n\n";
report += handoff_notes + "\n\n";
report += "## Still out of automated finish scope (human release path)\n";
report += "- MISSING: " + json_encode(inv_out.missing_ids) + "\n";
report += "- Typical: LL-013 runtime bundle, LL-014 signing, LL-015 notarize, LL-016 update feed, LL-017 install/rollback, LL-021 ops, LL-022 publish\n";
report += "- Live UI REWORK may remain: LL-010, LL-011 (host accessibility auth)\n\n";
report += "This workflow does not merge or release. Owner runs the printed commands after final eyeball.\n";

let path = write_scratch_file("finish-lightningloop-report.md", report);
complete(#{
    summary: "full handoff ready (dual PASS + gates); owner must run git/PR commands",
    ok: handoff_ok,
    mode: mode,
    stage: "full-handoff",
    path: path,
    inventory: inv_out,
    verdict_a: verdict_a,
    verdict_b: verdict_b,
    gates: gate_out,
    handoff_ok: handoff_ok,
});
