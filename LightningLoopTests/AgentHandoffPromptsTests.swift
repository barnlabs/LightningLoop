import XCTest
@testable import LightningLoop

final class AgentHandoffPromptsTests: XCTestCase {
    func testPromptCatalogProvidesFourStableCopyTargets() {
        XCTAssertEqual(
            AgentHandoffPrompts.all.map(\.id),
            ["setup-install", "connect-existing-provider-access", "maintain-update", "diagnose-repair"]
        )
        XCTAssertEqual(
            AgentHandoffPrompts.all.map(\.title),
            ["Set up or install LightningLoop", "Connect existing provider access", "Maintain or update LightningLoop", "Diagnose or repair LightningLoop"]
        )
        XCTAssertTrue(AgentHandoffPrompts.all.allSatisfy { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        for prompt in AgentHandoffPrompts.all {
            assertContains(prompt.text, "Do not create persistent automation")
            assertContains(prompt.text, "commit, push, merge, tag, release, publish, transfer")
            assertContains(prompt.text, "change GitHub settings")
        }
    }

    func testProviderAccessPromptProhibitsCredentialHandlingAndLeavesUserAuthenticationToTheUser() {
        let prompt = AgentHandoffPrompts.connectExistingProviderAccess.text

        assertContains(prompt, "Do not read, copy, export, or inspect credentials.")
        assertContains(prompt, "another agent or runtime credential store or data directory")
        assertContains(prompt, "`lightningloop auth`")
        assertContains(prompt, "official sign-in flow")
        assertContains(prompt, "password, passkey, OTP, CAPTCHA, account approval")
        assertContains(prompt, "user-only GUI entry in LightningLoop Settings")
        assertContains(prompt, "Do not operate a password manager")
    }

    func testSetupAndMaintenancePromptsBindTheActualCheckoutToCanonicalMain() {
        for prompt in [AgentHandoffPrompts.setupInstall, AgentHandoffPrompts.maintainUpdate] {
            assertContains(prompt.text, "gh repo view barnlabs/LightningLoop")
            assertContains(prompt.text, "`git remote get-url origin`")
            assertContains(prompt.text, "actual checkout")
            assertContains(prompt.text, "does not authenticate an unrelated checkout")
            assertContains(prompt.text, "clean `main`")
            assertContains(prompt.text, "stop before fetch")
            assertContains(prompt.text, "`origin main`")
            assertContains(prompt.text, "`FETCH_HEAD`")
            assertContains(prompt.text, "`refs/remotes/origin/main`")
            XCTAssertTrue(
                prompt.text.contains("Do not substitute `git pull`") || prompt.text.contains("Do not use `git pull`")
            )
            assertContains(prompt.text, "Preserve")
            assertContains(prompt.text, "`docs/UPDATES.md`")
            assertContains(prompt.text, "`lightningloop doctor`")
            assertContains(prompt.text, "`lightningloop update check`")
            assertContains(prompt.text, "`lightningloop harness status`")
            assertContains(prompt.text, "`manifest-verified`")
            assertContains(prompt.text, "never verifies downloaded artifact bytes")
            assertContains(prompt.text, "applicable local")
            assertContains(prompt.text, "Do not create persistent automation")
            assertContains(prompt.text, "commit, push, merge, tag, release, publish, transfer")
            assertContains(prompt.text, "application settings, secrets, credentials")
            assertContains(prompt.text, "rollback")
        }
    }

    func testDiagnosisPromptPreservesCredentialAndRepairBoundaries() {
        let prompt = AgentHandoffPrompts.diagnoseRepair.text

        assertContains(prompt, "smallest reversible step")
        assertContains(prompt, "`lightningloop doctor`")
        assertContains(prompt, "`lightningloop update check`")
        assertContains(prompt, "`lightningloop harness status`")
        assertContains(prompt, "runtime credential store or data directory")
        assertContains(prompt, "user-only GUI entry")
        assertContains(prompt, "commit, push, merge, tag, release, publish, transfer")
        assertContains(prompt, "exact sanitized evidence")
        assertContains(prompt, "rollback or recovery boundary")
    }

    func testCopyableProductPromptsDoNotExposeDependencyBranding() {
        for prompt in AgentHandoffPrompts.all {
            XCTAssertNil(prompt.text.range(of: #"\bpi\b"#, options: [.regularExpression, .caseInsensitive]))
        }
    }

    private func assertContains(_ text: String, _ expected: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(text.contains(expected), "Expected prompt to contain: \(expected)", file: file, line: line)
    }
}
