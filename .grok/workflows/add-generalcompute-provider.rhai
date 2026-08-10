let meta = #{
    name: "add-generalcompute-provider",
    description: "Add GeneralCompute (docs.generalcompute.com) as a first-class LightningLoop provider",
    when_to_use: "Adding or repairing the GeneralCompute inference provider in LightningLoop",
    phases: [
        #{ title: "Research", detail: "Confirm OpenAI-compatible contract from docs" },
        #{ title: "Implement", detail: "Wire Swift + harness + tests + docs" },
        #{ title: "Verify", detail: "Build harness, run provider tests, fix failures" },
        #{ title: "Review", detail: "Adversarial skeptic on trust boundaries" },
    ],
};

let research_schema = #{
    "type": "object",
    "required": ["base_url", "env_var", "default_model_id", "default_model_name", "context_window", "max_output_tokens", "supports_images", "auth_mode", "notes"],
    "properties": #{
        "base_url": #{ "type": "string" },
        "env_var": #{ "type": "string" },
        "default_model_id": #{ "type": "string" },
        "default_model_name": #{ "type": "string" },
        "context_window": #{ "type": "integer" },
        "max_output_tokens": #{ "type": "integer" },
        "supports_images": #{ "type": "boolean" },
        "auth_mode": #{ "type": "string" },
        "notes": #{ "type": "string" },
    },
};

let implement_schema = #{
    "type": "object",
    "required": ["files_changed", "summary", "risks"],
    "properties": #{
        "files_changed": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "summary": #{ "type": "string" },
        "risks": #{ "type": "string" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["passed", "commands", "failures", "fixes_applied"],
    "properties": #{
        "passed": #{ "type": "boolean" },
        "commands": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 20 },
        "failures": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 20 },
        "fixes_applied": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 20 },
    },
};

let review_schema = #{
    "type": "object",
    "required": ["verdict", "findings", "evidence"],
    "properties": #{
        "verdict": #{ "type": "string" },
        "findings": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 12 },
        "evidence": #{ "type": "string" },
    },
};

let root = if args == () { () } else { args.root };
if root == () { root = "/Users/baney/Documents/Loop"; }
let docs_url = if args == () { () } else { args.docs_url };
if docs_url == () { docs_url = "https://docs.generalcompute.com"; }

phase("Research");
log("Researching GeneralCompute contract from " + docs_url);

let research_prompt = "";
research_prompt += "You are researching provider integration for LightningLoop at " + root + ".\n";
research_prompt += "Confirm the GeneralCompute inference contract from " + docs_url + " and related pages.\n";
research_prompt += "MUST use tools: open_page/web_fetch or curl for docs and optionally GET https://api.generalcompute.com/v1/public/models.\n";
research_prompt += "Also read existing provider patterns: " + root + "/Harness/core/provider-profile.ts, " + root + "/LightningLoop/Models/ProviderConfiguration.swift, " + root + "/docs/AUTHENTICATION.md, " + root + "/docs/MODEL_SELECTION.md, " + root + "/docs/research/cerebras-provider-2026-07-20.md.\n";
research_prompt += "Critical product fact: Pi (@earendil-works/pi-coding-agent) does NOT include generalcompute as a built-in provider (no GENERALCOMPUTE_API_KEY in providers.md). Therefore LightningLoop must treat it as a LightningLoop-owned fixed OpenAI-compatible preset: NO piProviderID, uses Keychain/env credentials, allows native Discover Models & Test, fixed verified base URL.\n";
research_prompt += "Return structured fields only after reading primary sources.\n";
research_prompt += "Expected defaults from prior public docs/API (verify, do not invent if contradicted):\n";
research_prompt += "- base URL https://api.generalcompute.com/v1\n";
research_prompt += "- env GENERALCOMPUTE_API_KEY\n";
research_prompt += "- default model minimax-m2.7 (MiniMax M2.7), context 192000, max output capped at 131072 (LightningLoop schema max)\n";
research_prompt += "- supports_images false unless docs prove vision\n";
research_prompt += "- auth_mode: bearer API key, LightningLoop-managed (not Pi /login)\n";

let research = agent(research_prompt, #{
    label: "gc-research",
    capability_mode: "read-only",
    output_schema: research_schema,
});

if research == () || !research.success || research.output == () {
    pause("verification", "Research agent failed; resume after fixing research path.");
}

let contract = research.output;
let contract_json = json_encode(contract);
log("Contract JSON: " + contract_json);

phase("Implement");
let implement_prompt = "";
implement_prompt += "Implement GeneralCompute as a first-class LightningLoop provider in " + root + ".\n";
implement_prompt += "Repo root: " + root + ". Use read_file/grep/search_replace/write. Match surrounding code style.\n\n";
implement_prompt += "VERIFIED CONTRACT JSON (from research agent — trust only after re-checking docs):\n";
implement_prompt += contract_json + "\n\n";
implement_prompt += "Fallback defaults if research is sparse (still verify against docs):\n";
implement_prompt += "- baseURL https://api.generalcompute.com/v1\n";
implement_prompt += "- env GENERALCOMPUTE_API_KEY\n";
implement_prompt += "- default model minimax-m2.7 / MiniMax M2.7\n";
implement_prompt += "- contextWindow 192000, maxOutputTokens 131072 (schema cap), supportsImages false\n";
implement_prompt += "- auth bearer API key, LightningLoop-managed\n\n";

implement_prompt += "ARCHITECTURE DECISION (mandatory):\n";
implement_prompt += "GeneralCompute is NOT in Pi's built-in provider list. Implement as LightningLoop-managed fixed OpenAI-compatible preset:\n";
implement_prompt += "- preset id: generalcompute\n";
implement_prompt += "- displayName: GeneralCompute\n";
implement_prompt += "- fixed baseURL only (reject other hosts like other presets)\n";
implement_prompt += "- NO piProviderID on profile (registerProvider path like custom)\n";
implement_prompt += "- usesPiAuthentication = false\n";
implement_prompt += "- allowsNativeConnectionTesting = true (Discover Models & Test)\n";
implement_prompt += "- Keychain service: com.barnlabs.LightningLoop.provider.generalcompute.apiKey\n";
implement_prompt += "- CredentialProvider case generalcompute for Settings credential UI\n";
implement_prompt += "- Env fallback " + contract.env_var + " in model-adapter credential reader\n";
implement_prompt += "- Do NOT claim Pi /login manages this provider\n\n";

implement_prompt += "FILES TO UPDATE (touch all that apply):\n";
implement_prompt += "1) " + root + "/Harness/core/provider-profile.ts\n";
implement_prompt += "   - Add generalcompute to ProviderPreset union\n";
implement_prompt += "   - Add presets map entry with baseURL " + contract.base_url + "\n";
implement_prompt += "   - Add to selectableProviderPresets (near other API-key providers)\n";
implement_prompt += "   - parseProviderProfile allowlist; set piProviderID ONLY for Pi-managed presets (cerebras, groq, fireworks, xai, openai-codex, anthropic). generalcompute and custom get no piProviderID\n";
implement_prompt += "   - profileForPreset defaults for generalcompute; return without piProviderID for generalcompute\n";
implement_prompt += "   - providerCredentialService: generalcompute -> com.barnlabs.LightningLoop.provider.generalcompute.apiKey\n";
implement_prompt += "   - fixedLightningLoopCredentialServices: include generalcompute service\n\n";
implement_prompt += "2) " + root + "/Harness/core/provider-profile.test.ts — add focused tests for generalcompute defaults, no piProviderID, selectable list includes it, base URL locked\n\n";
implement_prompt += "3) " + root + "/Harness/pi/model-adapter.ts — when reading credential for non-pi providers, if preset is generalcompute accept process.env." + contract.env_var + " before/alongside macOS Keychain; improve error text so it is not only 'Custom providers'\n\n";
implement_prompt += "4) " + root + "/Harness/pi/lightningloop-extension.ts — allow non-darwin when generalcompute uses $" + contract.env_var + " (macOS still prefers keychain command). Update status header copy for LightningLoop-managed fixed provider vs pure custom\n\n";
implement_prompt += "5) " + root + "/Harness/cli/index.ts — help text provider select list includes generalcompute\n\n";
implement_prompt += "6) " + root + "/LightningLoop/Models/ProviderConfiguration.swift\n";
implement_prompt += "   - case generalcompute\n";
implement_prompt += "   - label GeneralCompute\n";
implement_prompt += "   - preset() defaults matching contract\n";
implement_prompt += "   - credentialProvider -> .generalcompute\n";
implement_prompt += "   - usesPiAuthentication false for generalcompute (and custom/selectionRequired)\n";
implement_prompt += "   - allowsNativeConnectionTesting true for .custom OR .generalcompute\n";
implement_prompt += "   - credentialService returns fixed generalcompute service when not Pi-managed and not custom host-suffixed\n\n";
implement_prompt += "7) " + root + "/LightningLoop/Services/KeychainStore.swift — CredentialProvider.generalcompute label/purpose/service; inferenceCases includes it; saveCredential allows generalcompute (only block Pi-managed cerebras/groq/fireworks)\n\n";
implement_prompt += "8) " + root + "/LightningLoopTests/MemoryEvolutionTests.swift — update testEveryBuiltInPresetIsPiManaged… to allow generalcompute as LightningLoop-managed API-key preset (not Pi)\n\n";
implement_prompt += "9) " + root + "/LightningLoopTests/ProviderConfigurationTests.swift — add assertions for generalcompute fixed URL and native testing allowed\n\n";
implement_prompt += "10) Docs:\n";
implement_prompt += "   - " + root + "/docs/research/generalcompute-provider-2026-07-25.md (mirror cerebras research note style; cite " + docs_url + ")\n";
implement_prompt += "   - Update " + root + "/docs/AUTHENTICATION.md, " + root + "/docs/MODEL_SELECTION.md, " + root + "/RUNBOOK.md briefly: GeneralCompute is LightningLoop-managed API key + fixed base URL; Settings Discover Models; env " + contract.env_var + "\n";
implement_prompt += "   - Touch " + root + "/README.md Providers section only if needed for accuracy\n\n";
implement_prompt += "11) Optional small model-adapter.test.ts coverage for env credential path if easy.\n\n";
implement_prompt += "DO NOT put any real API keys in source/tests. DO NOT force-push or commit unless asked. DO NOT invent Pi support.\n";
implement_prompt += "After edits, list files_changed and a short summary.\n";

let implement = agent(implement_prompt, #{
    label: "gc-implement",
    capability_mode: "all",
    output_schema: implement_schema,
});

if implement == () || !implement.success {
    pause("verification", "Implement agent failed; inspect workspace and resume.");
}
log("Implement: " + if implement.output != () { implement.output.summary } else { "no summary" });

phase("Verify");
let verify_prompt = "";
verify_prompt += "Verify the GeneralCompute provider integration in " + root + ".\n";
verify_prompt += "Run from " + root + ":\n";
verify_prompt += "1) npm run check:harness\n";
verify_prompt += "2) npm run build:harness && node --test dist/core/provider-profile.test.js\n";
verify_prompt += "3) If model-adapter tests exist and are relevant, run dist/pi/model-adapter.test.js\n";
verify_prompt += "4) grep the tree (excluding node_modules/dist) for generalcompute and confirm: preset, baseURL https://api.generalcompute.com/v1, no piProviderID, Keychain service, selectable list, Swift enum, tests updated.\n";
verify_prompt += "5) If harness tests fail due to your incomplete wiring, FIX them (capability all) and re-run until green or report remaining failures honestly.\n";
verify_prompt += "Swift XCTest may be skipped if Xcode unavailable; do not claim Swift tests passed without running them.\n";
verify_prompt += "Return passed=true only if TypeScript compile + provider-profile tests pass and code grep shows the preset wired end-to-end.\n";

let verify = agent(verify_prompt, #{
    label: "gc-verify",
    capability_mode: "all",
    output_schema: verify_schema,
});

let verify_ok = verify != () && verify.success && verify.output != () && verify.output.passed == true;
if !verify_ok {
    log("Verify failed closed; launching one fix pass");
    let fix_prompt = "";
    fix_prompt += "Fix GeneralCompute provider integration failures in " + root + ".\n";
    if verify != () && verify.output != () {
        fix_prompt += "Verify output: " + json_encode(verify.output) + "\n";
    }
    fix_prompt += "Re-run npm run check:harness and provider-profile tests after fixes. Keep security boundaries intact.\n";
    let fix = agent(fix_prompt, #{
        label: "gc-fix",
        capability_mode: "all",
        output_schema: verify_schema,
    });
    let fix_ok = fix != () && fix.success && fix.output != () && fix.output.passed == true;
    if !fix_ok {
        pause("verification", "Verification still failing after fix pass. Inspect and resume.");
    }
    verify = fix;
}

phase("Review");
let review_prompt = "";
review_prompt += "Adversarially review the GeneralCompute provider integration in " + root + ".\n";
review_prompt += "Read the actual diffs with git status/diff and the key files. Look for:\n";
review_prompt += "- Accidental Pi-managed claim or piProviderID set for generalcompute\n";
review_prompt += "- Mutable base URL for non-custom preset\n";
review_prompt += "- Secrets in repo\n";
review_prompt += "- Credential service not in redaction catalog\n";
review_prompt += "- Tests still asserting every built-in is Pi-managed\n";
review_prompt += "- Settings path that cannot store key for generalcompute\n";
review_prompt += "Verdict SHIP only if no material trust-boundary or correctness blockers. Otherwise BLOCK with concrete findings.\n";
review_prompt += "Use git and read_file; do not invent.\n";

let review = agent(review_prompt, #{
    label: "gc-review",
    capability_mode: "read-only",
    output_schema: review_schema,
});

let report = "# GeneralCompute provider workflow result\n\n";
report += "## Contract\n```json\n" + contract_json + "\n```\n\n";
if implement != () && implement.success && implement.output != () {
    report += "## Implementation\n" + implement.output.summary + "\n\nFiles:\n";
    if implement.output.files_changed != () {
        for f in implement.output.files_changed {
            report += "- " + f + "\n";
        }
    }
    if implement.output.risks != () {
        report += "\nRisks: " + implement.output.risks + "\n\n";
    }
}
let verify_passed = false;
if verify != () && verify.success && verify.output != () {
    if verify.output.passed == true { verify_passed = true; }
    report += "## Verify\npassed=" + if verify_passed { "true" } else { "false" } + "\n";
    if verify.output.commands != () {
        for c in verify.output.commands { report += "- cmd: " + c + "\n"; }
    }
    if verify.output.failures != () {
        for f in verify.output.failures { report += "- fail: " + f + "\n"; }
    }
    report += "\n";
}
let review_verdict = "unavailable";
if review != () && review.success && review.output != () {
    if review.output.verdict != () { review_verdict = review.output.verdict; }
    report += "## Review\nverdict: " + review_verdict + "\n";
    if review.output.evidence != () { report += review.output.evidence + "\n"; }
    if review.output.findings != () {
        for f in review.output.findings { report += "- " + f + "\n"; }
    }
}

let path = write_scratch_file("generalcompute-provider-report.md", report);
complete(#{
    path: path,
    summary: "GeneralCompute provider integration workflow finished",
    contract: contract,
    verify_passed: verify_passed,
    review_verdict: review_verdict,
});
