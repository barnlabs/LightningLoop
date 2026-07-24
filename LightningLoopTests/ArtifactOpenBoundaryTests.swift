import CryptoKit
import Foundation
import XCTest
@testable import LightningLoop

@MainActor
final class ArtifactOpenBoundaryTests: XCTestCase {
    func testEngineErrorIsRedactedBeforeItIsPersistedInSessionState() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let providerStore = try makeCustomProviderStore(in: directory)
        let model = AppModel(
            engine: SecretErrorLoopService(),
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        model.updateGoal("A safe goal")
        model.startClarification()
        for _ in 0..<40 where model.isRunning {
            try await Task.sleep(for: .milliseconds(25))
        }
        let message = try XCTUnwrap(model.selectedSession?.statusMessage)
        XCTAssertTrue(message.contains("[REDACTED]"))
        XCTAssertFalse(message.contains("csk-"))
    }

    func testEveryNestedEngineEventFieldIsRedactedBeforeSessionPersistence() async throws {
        let secret = "csk-abcdefghijklmnopqrstuvwx"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let providerStore = try makeCustomProviderStore(in: directory)
        let model = AppModel(
            engine: SecretEventLoopService(secret: secret),
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        model.updateGoal("A safe goal")
        model.startClarification()
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(25)) }
        let questionID = try XCTUnwrap(model.selectedSession?.questions.first?.id)
        model.updateAnswer(questionID: questionID, value: "continue")
        model.startLoop()
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(25)) }

        let session = try XCTUnwrap(model.selectedSession)
        let encoded = try JSONEncoder().encode(session)
        let persistedShape = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertFalse(persistedShape.contains(secret))
        XCTAssertTrue(persistedShape.contains("[REDACTED]") || persistedShape.contains("%5BREDACTED%5D"))
    }

    func testNotificationBoundaryHasNoObservableSecretDuringSuspension() async throws {
        let secret = "csk-abcdefghijklmnopqrstuvwx"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let providerStore = try makeCustomProviderStore(in: directory)
        let notifications = SuspendingNotificationRecorder()
        let model = AppModel(
            engine: SecretErrorLoopService(),
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true,
            notificationSend: { title, body in await notifications.send(title: title, body: body) }
        )
        model.updateGoal("A safe goal")
        model.startClarification()

        var captured: (String, String)?
        for _ in 0..<80 where captured == nil {
            captured = await notifications.captured()
            if captured == nil { try await Task.sleep(for: .milliseconds(10)) }
        }
        let notification = try XCTUnwrap(captured)
        XCTAssertTrue(model.isRunning, "The injected notification sender must still be suspended for this assertion window.")
        XCTAssertFalse(notification.0.contains(secret))
        XCTAssertFalse(notification.1.contains(secret))
        let session = try XCTUnwrap(model.selectedSession)
        let observable = String(decoding: try JSONEncoder().encode(session), as: UTF8.self)
        XCTAssertFalse(observable.contains(secret))
        XCTAssertTrue(observable.contains("REDACTED"))

        await notifications.release()
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.isRunning)
    }

    func testEveryNativeNoHarnessPathBlocksClarificationAndExecutionBeforeEngineCalls() async throws {
        let engine = GoldClaimingLoopService()
        for runtimeLabel in [
            "Native direct fallback · explicitly selected custom profile",
            "Shared LightningLoop runtime unavailable · loop execution blocked"
        ] {
            let model = AppModel(
                engine: engine,
                credentialReader: { _ in nil },
                runtimeLabel: runtimeLabel,
                skipCredentialRefresh: true
            )
            model.updateGoal("Create a brief")
            model.startClarification()

            XCTAssertEqual(model.selectedSession?.stage, .paused)
            XCTAssertTrue(model.selectedSession?.statusMessage.contains("clarification and completion require") == true)
            XCTAssertFalse(model.isRunning)

            var session = LoopSession(goal: "Create a brief")
            session.questions = [.init(id: "Q1", question: "Audience?", whyItMatters: "Scope")]
            session.answers = ["Q1": "Developers"]
            model.sessions = [session]
            model.selectedSessionID = session.id

            model.startLoop()

            XCTAssertEqual(model.selectedSession?.stage, .paused)
            XCTAssertTrue(model.selectedSession?.statusMessage.contains("shared LightningLoop harness") == true)
            XCTAssertFalse(model.isRunning)
        }
        let clarifications = await engine.clarificationCount()
        let executions = await engine.executionCount()
        XCTAssertEqual(clarifications, 0)
        XCTAssertEqual(executions, 0)
    }

    func testUncataloguedBuiltInModelBlocksClarificationBeforeEngineUse() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let providerStore = ProviderConfigurationStore(fileURL: directory.appendingPathComponent("provider.json"))
        try providerStore.save(.preset(.cerebras))
        let engine = GoldClaimingLoopService()
        let model = AppModel(
            engine: engine,
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        model.updateGoal("Use the guarded default model")

        model.startClarification()

        XCTAssertEqual(model.selectedSession?.stage, .paused)
        XCTAssertTrue(model.selectedSession?.statusMessage.contains("public-preview preference") == true)
        let clarificationCount = await engine.clarificationCount()
        XCTAssertEqual(clarificationCount, 0)
    }

    func testProviderModelSelectionIsCapturedBeforeEachOperationTask() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let providerStore = ProviderConfigurationStore(fileURL: directory.appendingPathComponent("provider.json"))
        var firstSelection = ProviderConfiguration.preset(.custom)
        firstSelection.id = "first-provider"
        firstSelection.modelID = "first-model"
        firstSelection.modelName = "First model"
        try providerStore.save(firstSelection)
        var secondSelection = firstSelection
        secondSelection.id = "second-provider"
        secondSelection.modelID = "second-model"
        secondSelection.modelName = "Second model"

        let engine = ModelSelectionRecordingLoopService()
        let model = AppModel(
            engine: engine,
            providerStore: providerStore,
            credentialReader: { _ in nil },
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true,
            notificationSend: { _, _ in }
        )
        model.updateGoal("Capture the selected model")
        model.startClarification()
        model.providerProfile = secondSelection
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        let capturedClarificationSelection = await engine.clarificationSelection()
        XCTAssertEqual(
            capturedClarificationSelection,
            ExpectedModelSelection(
                providerID: firstSelection.id,
                modelID: firstSelection.modelID,
                supportsImages: firstSelection.supportsImages,
                contextWindow: firstSelection.contextWindow,
                maxOutputTokens: firstSelection.maxOutputTokens
            )
        )

        let questionID = try XCTUnwrap(model.selectedSession?.questions.first?.id)
        model.updateAnswer(questionID: questionID, value: "Continue")
        model.providerProfile = firstSelection
        model.startLoop()
        model.providerProfile = secondSelection
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        let capturedExecutionSelection = await engine.executionSelection()
        XCTAssertEqual(
            capturedExecutionSelection,
            ExpectedModelSelection(
                providerID: firstSelection.id,
                modelID: firstSelection.modelID,
                supportsImages: firstSelection.supportsImages,
                contextWindow: firstSelection.contextWindow,
                maxOutputTokens: firstSelection.maxOutputTokens
            )
        )
    }

    func testCredentialBearingGoalAndAnswerNeverReachEngineObservableOrPersistedState() async throws {
        let secret = "ordinary-private-value-1234"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sessionsURL = directory.appendingPathComponent("sessions.json")
        let providerStore = try makeCustomProviderStore(in: directory)
        let engine = InputRecordingLoopService()
        let model = AppModel(
            engine: engine,
            archive: SessionArchive(fileURL: sessionsURL),
            providerStore: providerStore,
            credentialReader: { _ in secret },
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )

        model.updateGoal("Prepare a report using \(secret)")
        XCTAssertFalse(try XCTUnwrap(model.selectedSession).goal.contains(secret))
        model.startClarification()
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(10)) }

        let questionID = try XCTUnwrap(model.selectedSession?.questions.first?.id)
        model.updateAnswer(questionID: questionID, value: "Answer contains \(secret)")
        let observableBeforeRun = String(decoding: try JSONEncoder().encode(XCTUnwrap(model.selectedSession)), as: UTF8.self)
        XCTAssertFalse(observableBeforeRun.contains(secret))

        model.startLoop()
        for _ in 0..<80 where model.isRunning { try await Task.sleep(for: .milliseconds(10)) }

        let inputs = await engine.inputs()
        XCTAssertFalse(inputs.clarificationGoal.contains(secret))
        XCTAssertFalse(inputs.executionGoal.contains(secret))
        XCTAssertFalse(inputs.executionAnswers.values.contains { $0.contains(secret) })
        let observableAfterRun = String(decoding: try JSONEncoder().encode(XCTUnwrap(model.selectedSession)), as: UTF8.self)
        XCTAssertFalse(observableAfterRun.contains(secret))
        let persisted = String(decoding: try Data(contentsOf: sessionsURL), as: UTF8.self)
        XCTAssertFalse(persisted.contains(secret))
        XCTAssertTrue(persisted.contains("REDACTED"))
    }

    func testChangedOriginalBytesAndSymlinkAreBlockedBeforeAnyExternalOpen() throws {
        let workspace = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let original = workspace.appendingPathComponent("model.stl")
        let reviewed = Data("solid reviewed\nendsolid reviewed\n".utf8)
        try reviewed.write(to: original)
        let expected = sha256(reviewed)
        let recorder = OpenRecorder()
        let model = artifactModel(workspace: workspace, recorder: recorder)

        try Data("solid changed\nendsolid changed\n".utf8).write(to: original)
        model.openArtifactInDefaultApp(relativePath: "model.stl", expectedSHA256: expected)
        XCTAssertTrue(recorder.urls.isEmpty)
        XCTAssertEqual(model.settingsMessage, "Artifact bytes no longer match the reviewed evidence; opening was blocked.")

        try reviewed.write(to: original)
        let linked = workspace.appendingPathComponent("linked.stl")
        try FileManager.default.createSymbolicLink(atPath: linked.path, withDestinationPath: original.path)
        model.openArtifactInDefaultApp(relativePath: "linked.stl", expectedSHA256: expected)
        XCTAssertTrue(recorder.urls.isEmpty, "A symlink must be rejected before calling a default application.")
        XCTAssertEqual(model.settingsMessage, "Artifact bytes no longer match the reviewed evidence; opening was blocked.")
    }

    func testNonHTMLArtifactsOpenOnlyImmutableReviewedSnapshots() throws {
        let workspace = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let recorder = OpenRecorder()
        let model = artifactModel(workspace: workspace, recorder: recorder)

        for (name, bytes) in [
            ("model.stl", Data("solid reviewed\nendsolid reviewed\n".utf8)),
            ("scene.blend", Data([0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52]))
        ] {
            let original = workspace.appendingPathComponent(name)
            try bytes.write(to: original)
            model.openArtifactInDefaultApp(relativePath: name, expectedSHA256: sha256(bytes))
            let snapshot = try XCTUnwrap(recorder.urls.last)
            XCTAssertNotEqual(snapshot.standardizedFileURL, original.standardizedFileURL)
            XCTAssertEqual(snapshot.pathExtension, original.pathExtension)
            XCTAssertEqual(try Data(contentsOf: snapshot), bytes)
            let attributes = try FileManager.default.attributesOfItem(atPath: snapshot.path)
            let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue
            XCTAssertEqual(permissions & 0o222, 0, "Reviewed handoff snapshots must be read-only before the external app receives their path.")

            try Data("mutated original after review".utf8).write(to: original)
            XCTAssertEqual(try Data(contentsOf: snapshot), bytes, "The default-app handoff must retain the reviewed snapshot, not follow the mutable original path.")
        }
        XCTAssertEqual(recorder.urls.count, 2)
        XCTAssertTrue(model.settingsMessage.contains("immutable reviewed snapshot"))
    }

    private func makeCustomProviderStore(in directory: URL) throws -> ProviderConfigurationStore {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = ProviderConfigurationStore(fileURL: directory.appendingPathComponent("provider.json"))
        try store.save(.preset(.custom))
        return store
    }

    private func artifactModel(workspace: URL, recorder: OpenRecorder) -> AppModel {
        let model = AppModel(
            engine: ArtifactTestLoopService(),
            skipCredentialRefresh: true,
            artifactOpenURL: { url in
                recorder.urls.append(url)
                return true
            }
        )
        var session = LoopSession()
        session.artifactWorkspacePath = workspace.path
        model.sessions = [session]
        model.selectedSessionID = session.id
        return model
    }

    private func makeWorkspace() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
private final class OpenRecorder {
    var urls: [URL] = []
}

private struct ArtifactTestLoopService: LoopServicing {
    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        throw CancellationError()
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
        throw CancellationError()
    }
}

private struct SecretErrorLoopService: LoopServicing {
    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "upstream rejected csk-abcdefghijklmnopqrstuvwx"])
    }

    func execute(goal: String, summary: String, questions: [ClarifyingQuestion], answers: [String: String], maxReviewCycles: Int, attachments: [ImageAttachment], researchProvider: String?, artifactWorkspace: String?, approveArtifactWrites: Bool, approveVerificationCommands: Bool, expectedModelSelection: ExpectedModelSelection, runID: UUID?, emit: @escaping @Sendable (LoopEngineEvent) async -> Void) async throws -> LoopExecutionResult {
        throw CancellationError()
    }
}

private struct SecretEventLoopService: LoopServicing {
    let secret: String

    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        .init(
            summary: "summary \(secret)",
            questions: [.init(id: "question-\(secret)", question: "question \(secret)", whyItMatters: "why \(secret)")],
            timeline: .init(role: .orchestrator, title: "title \(secret)", summary: "timeline \(secret)", metrics: .init())
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
        let planning = PlanningDraft(
            criteria: [.init(id: "criterion-\(secret)", title: "criterion \(secret)", detail: "detail \(secret)", evidence: "evidence \(secret)")],
            plan: [.init(id: "plan-\(secret)", title: "plan \(secret)", detail: "detail \(secret)", proof: "proof \(secret)")],
            risks: ["risk \(secret)"],
            acceptanceTest: "acceptance \(secret)"
        )
        let review = ReviewRecord(
            target: "target \(secret)", round: 1, score: 0, passed: false,
            summary: "review \(secret)",
            findings: [.init(severity: "high \(secret)", criterionID: "criterion-\(secret)", issue: "issue \(secret)", requiredChange: "change \(secret)")],
            requiredChanges: ["required \(secret)"],
            criterionAssessments: [.init(criterionID: "criterion-\(secret)", status: "status \(secret)", evidence: "evidence \(secret)", evidenceRefs: ["ref \(secret)"])]
        )
        let implementation = ImplementationDraft(
            deliverable: "deliverable \(secret)", notes: ["note \(secret)"],
            files: [.init(path: "file-\(secret)", content: "content \(secret)")],
            verificationCommands: [.init(executable: "tool-\(secret)", arguments: [secret], purpose: "purpose \(secret)")]
        )
        await emit(.planning(planning))
        await emit(.timeline(.init(role: .implementer, title: "event \(secret)", summary: "event summary \(secret)", metrics: .init())))
        await emit(.review(review))
        await emit(.implementation(implementation))
        let report = ArtifactExecutionReport(
            enabled: true, passed: false, summary: "report \(secret)",
            files: [.init(path: "path-\(secret)", bytes: 1, sha256: "hash-\(secret)")],
            commands: [.init(executable: "exec-\(secret)", arguments: [secret], purpose: "purpose \(secret)", exitCode: 1, output: "output \(secret)", passed: false, origin: "origin \(secret)", durationMs: 1)],
            previews: [.init(kind: "kind \(secret)", title: "preview \(secret)", sourcePath: "source-\(secret)", previewPath: "preview-\(secret)", mimeType: "type-\(secret)", passed: false, message: "message \(secret)", width: 1, height: 1, loopback: .init(scheme: "scheme-\(secret)", host: "host-\(secret)", status: 500, contentType: "content-\(secret)", bytes: 1, sha256: "hash-\(secret)"))],
            workspaceAudit: .init(passed: false, files: 1, bytes: 1, message: "audit \(secret)")
        )
        return .init(planning: planning, implementation: implementation, completed: false, finalMessage: "final \(secret)", artifactReport: report)
    }
}

private actor SuspendingNotificationRecorder {
    private var value: (String, String)?
    private var continuation: CheckedContinuation<Void, Never>?

    func send(title: String, body: String) async {
        value = (title, body)
        await withCheckedContinuation { continuation = $0 }
    }

    func captured() -> (String, String)? { value }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private actor GoldClaimingLoopService: LoopServicing {
    private var clarifications = 0
    private var executions = 0

    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        clarifications += 1
        return .init(
            summary: "Ready",
            questions: [.init(id: "Q1", question: "Audience?", whyItMatters: "Scope")],
            timeline: .init(role: .orchestrator, title: "Ready", summary: "Ready", metrics: .init())
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
        executions += 1
        return .init(
            planning: .init(criteria: [], plan: [], risks: [], acceptanceTest: ""),
            implementation: .init(deliverable: "Untrusted Gold claim", notes: []),
            completed: true,
            finalMessage: "Gold"
        )
    }

    func clarificationCount() -> Int { clarifications }
    func executionCount() -> Int { executions }
}

private actor ModelSelectionRecordingLoopService: LoopServicing {
    private var recordedClarificationSelection: ExpectedModelSelection?
    private var recordedExecutionSelection: ExpectedModelSelection?

    func clarify(
        goal: String,
        attachments: [ImageAttachment],
        expectedModelSelection: ExpectedModelSelection,
        runID: UUID?
    ) async throws -> ClarificationResult {
        recordedClarificationSelection = expectedModelSelection
        return .init(
            summary: "Ready",
            questions: [.init(id: "Q1", question: "Continue?", whyItMatters: "Scope")],
            timeline: .init(role: .orchestrator, title: "Ready", summary: "Ready", metrics: .init())
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
        recordedExecutionSelection = expectedModelSelection
        return .init(
            planning: .init(criteria: [], plan: [], risks: [], acceptanceTest: ""),
            implementation: .init(deliverable: "Captured", notes: []),
            completed: false,
            finalMessage: "Paused"
        )
    }

    func clarificationSelection() -> ExpectedModelSelection? { recordedClarificationSelection }
    func executionSelection() -> ExpectedModelSelection? { recordedExecutionSelection }
}

private actor InputRecordingLoopService: LoopServicing {
    private var clarificationGoal = ""
    private var executionGoal = ""
    private var executionAnswers: [String: String] = [:]

    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        clarificationGoal = goal
        return .init(
            summary: "Ready",
            questions: [.init(id: "Q1", question: "Audience?", whyItMatters: "Scope")],
            timeline: .init(role: .orchestrator, title: "Ready", summary: "Ready", metrics: .init())
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
        executionGoal = goal
        executionAnswers = answers
        return .init(
            planning: .init(criteria: [], plan: [], risks: [], acceptanceTest: ""),
            implementation: .init(deliverable: "Safe", notes: []),
            completed: false,
            finalMessage: "Paused"
        )
    }

    func inputs() -> (clarificationGoal: String, executionGoal: String, executionAnswers: [String: String]) {
        (clarificationGoal, executionGoal, executionAnswers)
    }
}
