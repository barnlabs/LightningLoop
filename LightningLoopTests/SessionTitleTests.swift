import XCTest
@testable import LightningLoop

final class SessionTitleTests: XCTestCase {
    func testProvisionalStripsNoiseAndLimitsLength() {
        let title = SessionTitle.provisional(from: "Please help me build a launch brief for the waterford museum site with many extra words that should be trimmed carefully")
        XCTAssertFalse(title.lowercased().hasPrefix("please"))
        XCTAssertLessThanOrEqual(title.count, SessionTitle.maxLength)
        XCTAssertNotEqual(title, SessionTitle.emptyTitle)
    }

    func testProvisionalEmptyGoal() {
        XCTAssertEqual(SessionTitle.provisional(from: "   \n  "), SessionTitle.emptyTitle)
    }

    func testStructuredPrefersPlanThenCriterionThenSummary() {
        let planTitle = SessionTitle.structured(
            goal: "long goal text that is not preferred",
            clarifiedSummary: "summary line",
            criteria: [.init(id: "C1", title: "Criterion title", detail: "d", evidence: "e")],
            plan: [.init(id: "P1", title: "Plan step title", detail: "d", proof: "p")]
        )
        XCTAssertEqual(planTitle, "Plan step title")

        let criterionTitle = SessionTitle.structured(
            goal: "goal",
            clarifiedSummary: "summary",
            criteria: [.init(id: "C1", title: "Criterion title", detail: "d", evidence: "e")],
            plan: []
        )
        XCTAssertEqual(criterionTitle, "Criterion title")

        let summaryTitle = SessionTitle.structured(
            goal: "goal that is longer than needed for testing",
            clarifiedSummary: "One sentence summary of the clarified objective.",
            criteria: [],
            plan: []
        )
        XCTAssertTrue(summaryTitle.contains("summary") || summaryTitle.contains("One sentence"))
    }

    func testResolvedMarksSummaryOnlyAsStructured() {
        let resolved = SessionTitle.resolved(
            goal: "raw goal text that would be provisional",
            clarifiedSummary: "Clarify the museum launch audience and proof.",
            criteria: [],
            plan: []
        )
        XCTAssertEqual(resolved.source, .structured)
        XCTAssertNotEqual(resolved.title, SessionTitle.emptyTitle)

        let empty = SessionTitle.resolved(goal: "please help me write a brief", clarifiedSummary: "", criteria: [], plan: [])
        XCTAssertEqual(empty.source, .provisional)
    }

    func testParseLLMTitleAcceptsJSONAndRejectsPreamble() {
        XCTAssertEqual(SessionTitle.parseLLMTitle("{\"title\":\"Museum Launch Brief\"}"), "Museum Launch Brief")
        XCTAssertNil(SessionTitle.parseLLMTitle("Alright, I need to create a concise title for this chat"))
        XCTAssertNil(SessionTitle.parseLLMTitle(""))
        XCTAssertEqual(
            SessionTitle.parseLLMTitle("```json\n{\"title\":\"Secure Overlay Rollback\"}\n```"),
            "Secure Overlay Rollback"
        )
    }

    func testShouldAutoUpdateRespectsManualLock() {
        XCTAssertFalse(SessionTitle.shouldAutoUpdate(source: .manual, locked: false))
        XCTAssertFalse(SessionTitle.shouldAutoUpdate(source: .provisional, locked: true))
        XCTAssertTrue(SessionTitle.shouldAutoUpdate(source: .provisional, locked: false))
        XCTAssertTrue(SessionTitle.shouldAutoUpdate(source: .structured, locked: false))
    }

    @MainActor
    func testRenameLocksAndUnlockRestoresStructured() throws {
        let model = try makeTitleTestModel()
        model.updateGoal("Please help me write a source-backed launch brief")
        XCTAssertEqual(model.selectedSession?.titleSource, .provisional)
        XCTAssertNotEqual(model.selectedSession?.title, SessionTitle.emptyTitle)

        model.renameSelectedSession(to: "  Launch Brief  ")
        XCTAssertEqual(model.selectedSession?.title, "Launch Brief")
        XCTAssertEqual(model.selectedSession?.titleSource, .manual)
        XCTAssertEqual(model.selectedSession?.titleLocked, true)

        // Goal edit must not overwrite locked manual title.
        model.updateGoal("Completely different goal text that is very long")
        XCTAssertEqual(model.selectedSession?.title, "Launch Brief")

        // Seed plan so unlock restores structured title (not only provisional).
        model.sessions[0].plan = [
            .init(id: "P1", title: "Ship launch brief", detail: "d", proof: "p")
        ]
        model.sessions[0].titleLocked = true
        model.sessions[0].titleSource = .manual
        model.sessions[0].title = "Launch Brief"
        model.unlockSelectedSessionTitle()
        XCTAssertEqual(model.selectedSession?.titleLocked, false)
        XCTAssertEqual(model.selectedSession?.titleSource, .structured)
        XCTAssertEqual(model.selectedSession?.title, "Ship launch brief")
    }

    @MainActor
    func testUnlockAfterSummaryOnlyDoesNotBecomeProvisional() throws {
        let model = try makeTitleTestModel()
        model.updateGoal("Please write a long goal that should not win after clarify")
        model.sessions[0].clarifiedSummary = "Clarify the museum launch audience and proof."
        model.sessions[0].title = "Manual"
        model.sessions[0].titleSource = .manual
        model.sessions[0].titleLocked = true
        model.unlockSelectedSessionTitle()
        XCTAssertEqual(model.selectedSession?.titleSource, .structured)
        XCTAssertFalse(model.selectedSession?.titleLocked == true)

        // Goal edit must not clobber summary-derived structured titles.
        let before = model.selectedSession?.title
        model.updateGoal("Completely different goal after unlock")
        XCTAssertEqual(model.selectedSession?.title, before)
        XCTAssertEqual(model.selectedSession?.titleSource, .structured)
    }

    @MainActor
    func testStaleLLMTitleGenerationIsIgnored() throws {
        let model = try makeTitleTestModel()
        guard let sessionID = model.selectedSessionID else {
            return XCTFail("missing session")
        }
        model.updateGoal("Initial goal for title race")
        model.sessions[0].clarifiedSummary = "First clarification summary for the loop."

        // Rename bumps generation; unlock bumps again. Capture both.
        model.renameSelectedSession(to: "Locked")
        let staleGeneration = model.titleGeneration(for: sessionID)
        XCTAssertGreaterThan(staleGeneration, 0)
        model.unlockSelectedSessionTitle()
        let currentGeneration = model.titleGeneration(for: sessionID)
        XCTAssertGreaterThan(currentGeneration, staleGeneration)

        model.sessions[0].title = "Structured After Unlock"
        model.sessions[0].titleSource = .structured
        model.sessions[0].titleLocked = false
        model.sessions[0].clarifiedSummary = "First clarification summary for the loop."

        // Stale generation must not apply.
        model.applyLLMTitleResult(sessionID: sessionID, generation: staleGeneration, title: "Stale LLM Title")
        XCTAssertEqual(model.selectedSession?.title, "Structured After Unlock")
        XCTAssertEqual(model.selectedSession?.titleSource, .structured)

        // Matching generation applies.
        model.applyLLMTitleResult(sessionID: sessionID, generation: currentGeneration, title: "Fresh LLM Title")
        XCTAssertEqual(model.selectedSession?.title, "Fresh LLM Title")
        XCTAssertEqual(model.selectedSession?.titleSource, .llm)

        // Locked manual title rejects even matching generation after a new rename.
        model.renameSelectedSession(to: "User Locked")
        let lockedGen = model.titleGeneration(for: sessionID)
        model.applyLLMTitleResult(sessionID: sessionID, generation: lockedGen, title: "Should Not Apply")
        XCTAssertEqual(model.selectedSession?.title, "User Locked")
        XCTAssertEqual(model.selectedSession?.titleSource, .manual)
    }

    @MainActor
    func testUnboundCatalogBlockerAsksForRefresh() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let providerStore = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try providerStore.save(ProviderConfiguration.preset(.cerebras))
        let catalogModel = AppModel(
            engine: TitleTestLoopService(),
            archive: SessionArchive(fileURL: root.appendingPathComponent("sessions.json")),
            providerStore: providerStore,
            credentialRegistry: CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("cred.json")),
            credentialReader: { _ in nil },
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        let message = catalogModel.loopReadinessMessage
        XCTAssertNotNil(message)
        // Gemma preference notice when unbound, or explicit refresh wording for other models.
        XCTAssertTrue(
            message?.localizedCaseInsensitiveContains("refresh") == true
                || message?.localizedCaseInsensitiveContains("public-preview") == true
                || message?.localizedCaseInsensitiveContains("catalog") == true,
            "expected refresh/catalog/preview notice, got: \(message ?? "nil")"
        )
    }

    func testLegacySessionDecodesWithoutTitleSource() throws {
        var session = LoopSession(goal: "legacy goal for decode")
        session.title = "Old title"
        let data = try JSONEncoder().encode(session)
        var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        object.removeValue(forKey: "titleSource")
        object.removeValue(forKey: "titleLocked")
        let stripped = try JSONSerialization.data(withJSONObject: object)
        let decoded = try JSONDecoder().decode(LoopSession.self, from: stripped)
        XCTAssertEqual(decoded.titleSource, .provisional)
        XCTAssertFalse(decoded.titleLocked)
        XCTAssertEqual(decoded.title, "Old title")
    }

    @MainActor
    private func makeTitleTestModel() throws -> AppModel {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Intentionally leak root until process exit for short unit tests; FileManager temp is cleaned by OS.
        let archive = SessionArchive(fileURL: root.appendingPathComponent("sessions.json"))
        let providerStore = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        return AppModel(
            engine: TitleTestLoopService(),
            archive: archive,
            providerStore: providerStore,
            credentialRegistry: CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("cred.json")),
            credentialReader: { _ in nil },
            skipCredentialRefresh: true
        )
    }
}

private struct TitleTestLoopService: LoopServicing {
    func clarify(
        goal: String,
        attachments: [ImageAttachment],
        expectedModelSelection: ExpectedModelSelection,
        runID: UUID?
    ) async throws -> ClarificationResult {
        ClarificationResult(
            summary: "summary",
            questions: [],
            timeline: .init(role: .orchestrator, title: "t", summary: "s", metrics: .init())
        )
    }

    func execute(
        goal: String,
        summary: String,
        questions: [ClarifyingQuestion],
        answers: [String: String],
        maxReviewCycles: Int,
        attachments: [ImageAttachment],
        researchProvider: String?,
        artifactWorkspace: String?,
        approveArtifactWrites: Bool,
        approveVerificationCommands: Bool,
        expectedModelSelection: ExpectedModelSelection,
        runID: UUID?,
        emit: @escaping @Sendable (LoopEngineEvent) async -> Void
    ) async throws -> LoopExecutionResult {
        LoopExecutionResult(
            planning: .init(criteria: [], plan: [], risks: [], acceptanceTest: ""),
            implementation: .init(deliverable: "", notes: []),
            completed: false,
            finalMessage: "paused"
        )
    }
}
