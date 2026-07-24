import XCTest
import Darwin
@testable import LightningLoop

final class HarnessProcessClientTests: XCTestCase {
    func testNormalAppLaunchSearchesTheUserLocalTUIInstall() {
        let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
        XCTAssertEqual(
            HarnessProcessClient.installedHarnessRoot(homeDirectory: home).path,
            "/Users/example/.local/lib/node_modules/@barnlabs/lightningloop-harness"
        )
    }

    func testNormalAppLaunchUsesDeterministicFinderLaunchableNodeCandidates() {
        let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
        XCTAssertEqual(
            HarnessProcessClient.nodeCandidates(environment: [:], homeDirectory: home).map(\.path),
            [
                "/Users/example/.local/node/bin/node",
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node"
            ]
        )
        XCTAssertEqual(
            HarnessProcessClient.nodeCandidates(
                environment: ["LIGHTNINGLOOP_NODE_PATH": "/tmp/development-node"],
                homeDirectory: home
            ).first?.path,
            "/tmp/development-node"
        )
    }

    func testHarnessDiscoveryRequiresLockedPackageShape() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("dist/cli", isDirectory: true), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("node_modules/@earendil-works/pi-coding-agent", isDirectory: true), withIntermediateDirectories: true)
        try Data("{\"name\":\"@barnlabs/lightningloop-harness\",\"private\":true}".utf8)
            .write(to: root.appendingPathComponent("package.json"))
        try Data("process.exit(0);".utf8).write(to: root.appendingPathComponent("dist/cli/index.js"))
        let client = try XCTUnwrap(
            HarnessProcessClient.discover(environment: [:], rootCandidates: [root]),
            "A private package with the locked harness shape should be discoverable."
        )
        _ = client

        try Data("{\"name\":\"untrusted\",\"private\":true}".utf8)
            .write(to: root.appendingPathComponent("package.json"))
        XCTAssertNil(HarnessProcessClient.discover(environment: [:], rootCandidates: [root]))
    }

    func testArtifactReportAndLegacySessionFieldsDecodeWithoutWeakeningDefaults() throws {
        let reportJSON = """
        {"enabled":true,"passed":true,"summary":"Verified","files":[{"path":"app.js","bytes":4,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"commands":[],"workspaceAudit":{"passed":true,"files":1,"bytes":4,"message":"Confined"}}
        """
        let report = try JSONDecoder().decode(ArtifactExecutionReport.self, from: Data(reportJSON.utf8))
        XCTAssertTrue(report.passed)
        XCTAssertEqual(report.files.first?.path, "app.js")

        let legacy = LoopSession()
        let encoded = try JSONEncoder().encode(legacy)
        let decoded = try JSONDecoder().decode(LoopSession.self, from: encoded)
        XCTAssertNil(decoded.artifactWorkspacePath)
        XCTAssertNil(decoded.artifactVerificationCommands)
        XCTAssertNil(decoded.artifactReport)
    }

    func testRuntimeModelCatalogDecodesCataloguedSelectionAndPublicPreviewWarning() throws {
        let json = """
        {"providerID":"cerebras","models":[{"modelID":"gpt-oss-120b","modelName":"OpenAI GPT OSS","supportsImages":false,"contextWindow":131072,"maxOutputTokens":32768}],"selectedModelID":"gemma-4-31b","selectedModelCatalogued":false,"catalogScope":"Pinned LightningLoop runtime catalog","selectionNotice":"Gemma 4 31B is a public-preview preference and is not catalogued by this runtime."}
        """
        let catalog = try JSONDecoder().decode(HarnessRuntimeModelCatalog.self, from: Data(json.utf8))
        XCTAssertEqual(catalog.providerID, "cerebras")
        XCTAssertEqual(catalog.models.map(\.modelID), ["gpt-oss-120b"])
        XCTAssertFalse(catalog.selectedModelCatalogued)
        XCTAssertTrue(catalog.selectionNotice?.contains("public-preview") == true)
    }

    @MainActor
    func testLoopReadinessExplainsRuntimeProviderAndCatalogBlockers() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let providerStore = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        let archive = SessionArchive(fileURL: root.appendingPathComponent("sessions.json"))

        let unavailable = AppModel(
            engine: CatalogRaceLoopService(),
            archive: archive,
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime unavailable · loop execution blocked",
            skipCredentialRefresh: true
        )
        XCTAssertTrue(unavailable.loopReadinessMessage?.contains("runtime is unavailable") == true)

        let onboarding = AppModel(
            engine: CatalogRaceLoopService(),
            archive: archive,
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        XCTAssertEqual(onboarding.loopReadinessMessage, "Choose an inference provider and model before running this loop.")

        try providerStore.save(.preset(.cerebras))
        let catalogBlocked = AppModel(
            engine: CatalogRaceLoopService(),
            archive: archive,
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        XCTAssertTrue(catalogBlocked.loopReadinessMessage?.contains("public-preview preference") == true)
        catalogBlocked.applyRuntimeModelCatalog(
            .init(
                providerID: "cerebras",
                models: [ProviderConfiguration.cerebrasGemma4_31B],
                selectedModelID: "gemma-4-31b",
                selectedModelCatalogued: true,
                catalogScope: "Test catalog",
                selectionNotice: nil
            ),
            requestedProviderID: "cerebras",
            requestedModelID: "gemma-4-31b"
        )
        XCTAssertNil(catalogBlocked.loopReadinessMessage)
    }

    @MainActor
    func testSameProviderModelChangeRejectsAStaleCataloguedResponse() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let providerStore = ProviderConfigurationStore(fileURL: directory.appendingPathComponent("provider.json"))
        let priorSelection = ProviderConfiguration.preset(.cerebras).applyingRuntimeModel(.init(
            modelID: "gpt-oss-120b",
            modelName: "OpenAI GPT OSS",
            supportsImages: false,
            contextWindow: 131_072,
            maxOutputTokens: 40_960
        ))
        try providerStore.save(priorSelection)
        let model = AppModel(
            engine: CatalogRaceLoopService(),
            providerStore: providerStore,
            skipCredentialRefresh: true
        )
        model.providerProfile = ProviderConfiguration.preset(.cerebras)
        let staleCatalog = HarnessRuntimeModelCatalog(
            providerID: "cerebras",
            models: [.init(
                modelID: "gpt-oss-120b",
                modelName: "OpenAI GPT OSS",
                supportsImages: false,
                contextWindow: 131_072,
                maxOutputTokens: 40_960
            )],
            selectedModelID: "gpt-oss-120b",
            selectedModelCatalogued: true,
            catalogScope: "Pinned LightningLoop runtime catalog",
            selectionNotice: nil
        )

        model.applyRuntimeModelCatalog(
            staleCatalog,
            requestedProviderID: "cerebras",
            requestedModelID: "gpt-oss-120b"
        )

        XCTAssertTrue(model.runtimeModels.isEmpty)
        XCTAssertNil(model.runtimeModelCatalogProviderID)
        XCTAssertTrue(model.settingsMessage.contains("provider or model changed"))
        XCTAssertFalse(model.settingsMessage.contains("is catalogued"))
        XCTAssertFalse(model.hasAPIKey)
    }

    @MainActor
    func testAppModelBindsRequestsToExactRuntimeCatalogCapabilitiesAndLimits() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let providerStore = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try providerStore.save(.preset(.openaiCodex))
        let service = SnapshotCaptureLoopService()
        let model = AppModel(
            engine: service,
            archive: SessionArchive(fileURL: root.appendingPathComponent("sessions.json")),
            memoryArchive: MemoryArchive(fileURL: root.appendingPathComponent("memory.json")),
            evolutionArchive: EvolutionArchive(fileURL: root.appendingPathComponent("evolutions.json")),
            providerStore: providerStore,
            credentialRegistry: .init(fileURL: root.appendingPathComponent("services.json")),
            credentialReader: { _ in nil },
            runtimeLabel: "Shared LightningLoop runtime",
            skipCredentialRefresh: true
        )
        let option = ProviderModelOption(
            modelID: model.providerProfile.modelID,
            modelName: "Runtime exact model",
            supportsImages: false,
            contextWindow: 350_000,
            maxOutputTokens: 8_192
        )
        model.applyRuntimeModelCatalog(
            HarnessRuntimeModelCatalog(
                providerID: model.providerProfile.id,
                models: [option],
                selectedModelID: model.providerProfile.modelID,
                selectedModelCatalogued: true,
                catalogScope: "Exact test snapshot",
                selectionNotice: nil
            ),
            requestedProviderID: model.providerProfile.id,
            requestedModelID: model.providerProfile.modelID
        )
        model.updateGoal("Capture exact model selection")
        model.startClarification()
        for _ in 0..<200 where service.selection == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(service.selection, ExpectedModelSelection(
            providerID: model.providerProfile.id,
            modelID: option.modelID,
            supportsImages: option.supportsImages,
            contextWindow: option.contextWindow,
            maxOutputTokens: option.maxOutputTokens
        ))
    }

    func testBoundedRunnerDrainsBothPipesAndFailsClosedOnFiniteAndEndlessOverflow() throws {
        let environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let root = FileManager.default.temporaryDirectory
        for (command, limit) in [
            ("dd if=/dev/zero bs=1048576 count=9 2>/dev/null", 8 * 1_048_576),
            ("/usr/bin/yes endless", 131_072)
        ] {
            let runner = HarnessSubprocessRunner()
            XCTAssertThrowsError(try runner.executeCommand(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", command],
                rootURL: root,
                environment: environment,
                outputLimit: limit,
                deadline: 5
            )) { error in
                guard case HarnessProcessError.outputTooLarge = error else {
                    return XCTFail("Expected pre-append aggregate overflow, got \(error)")
                }
            }
            assertReaped(runner.mostRecentProcessIdentifier())
        }

        let runner = HarnessSubprocessRunner()
        let result = try runner.executeCommand(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "dd if=/dev/zero bs=65536 count=8 1>&2; printf ok"],
            rootURL: root,
            environment: environment,
            outputLimit: 1_048_576,
            deadline: 5
        )
        XCTAssertEqual(String(data: result.stdout, encoding: .utf8), "ok")
        XCTAssertGreaterThanOrEqual(result.stderr.count, 8 * 65_536)
        assertReaped(result.processIdentifier)
    }

    func testBoundedRunnerDeadlineCancellationAndPromptExitReapOnlyOwnedChildren() async throws {
        let environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let root = FileManager.default.temporaryDirectory
        let deadlineRunner = HarnessSubprocessRunner()
        XCTAssertThrowsError(try deadlineRunner.executeCommand(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["30"],
            rootURL: root,
            environment: environment,
            outputLimit: 4_096,
            deadline: 0.1
        )) { error in
            guard case HarnessProcessError.deadlineExceeded = error else {
                return XCTFail("Expected deadline failure, got \(error)")
            }
        }
        assertReaped(deadlineRunner.mostRecentProcessIdentifier())

        let cancellationRunner = HarnessSubprocessRunner()
        let cancelled = Task.detached {
            try cancellationRunner.executeCommand(
                executableURL: URL(fileURLWithPath: "/bin/sleep"),
                arguments: ["30"],
                rootURL: root,
                environment: environment,
                outputLimit: 4_096,
                deadline: 5
            )
        }
        for _ in 0..<200 where cancellationRunner.activeProcessIdentifier() == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        let cancelledPID = try XCTUnwrap(cancellationRunner.activeProcessIdentifier())
        cancellationRunner.cancel()
        do {
            _ = try await cancelled.value
            XCTFail("Cancellation must throw")
        } catch is CancellationError {
            // Expected.
        }
        assertReaped(cancelledPID)

        let promptRunner = HarnessSubprocessRunner()
        let prompt = try promptRunner.executeCommand(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "printf prompt-exit"],
            rootURL: root,
            environment: environment,
            outputLimit: 4_096,
            deadline: 2
        )
        XCTAssertEqual(String(data: prompt.stdout, encoding: .utf8), "prompt-exit")
        XCTAssertEqual(prompt.terminationStatus, 0)
        assertReaped(prompt.processIdentifier)
    }

    func testJSONLParsingRejectsInvalidUTF8ExtraFieldsBoundsAndBrokenStageSequence() throws {
        let runID = "run"
        let requestID = "request"
        XCTAssertThrowsError(try HarnessProcessClient.validateJSONLForTesting(
            Data([0xff, 0x0a]), runID: runID, requestID: requestID, requestType: "hello"
        ))
        let extra = jsonl([
            envelope(type: "response", runID: runID, requestID: requestID, payload: [
                "requestType": "hello", "product": "LightningLoop", "protocolVersion": 1,
                "provider": "Provider", "model": "model", "capabilities": [], "identity": "identity"
            ], extra: ["unexpected": true])
        ])
        XCTAssertThrowsError(try HarnessProcessClient.validateJSONLForTesting(extra, runID: runID, requestID: requestID, requestType: "hello"))

        let result: [String: Any] = ["stage": "paused"]
        let broken = jsonl([
            envelope(type: "stageChanged", runID: runID, requestID: requestID, payload: ["stage": "implementing", "role": "implementer", "message": "Too early"]),
            envelope(type: "stageChanged", runID: runID, requestID: requestID, payload: ["stage": "paused", "role": "orchestrator", "message": "Paused"]),
            envelope(type: "runPaused", runID: runID, requestID: requestID, payload: result),
            envelope(type: "response", runID: runID, requestID: requestID, payload: ["requestType": "continueRun", "result": result])
        ])
        XCTAssertThrowsError(try HarnessProcessClient.validateJSONLForTesting(broken, runID: runID, requestID: requestID, requestType: "continueRun"))

        let valid = jsonl([
            envelope(type: "stageChanged", runID: runID, requestID: requestID, payload: ["stage": "planning", "role": "orchestrator", "message": "Plan"]),
            envelope(type: "stageChanged", runID: runID, requestID: requestID, payload: ["stage": "reviewing_plan", "role": "reviewer", "message": "Review"]),
            envelope(type: "stageChanged", runID: runID, requestID: requestID, payload: ["stage": "paused", "role": "orchestrator", "message": "Paused"]),
            envelope(type: "runPaused", runID: runID, requestID: requestID, payload: result),
            envelope(type: "response", runID: runID, requestID: requestID, payload: ["requestType": "continueRun", "result": result])
        ])
        XCTAssertEqual(try HarnessProcessClient.validateJSONLForTesting(valid, runID: runID, requestID: requestID, requestType: "continueRun").last, "response")
    }

    private func assertReaped(_ pid: Int32, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThan(pid, 0, file: file, line: line)
        errno = 0
        XCTAssertEqual(Darwin.kill(pid, 0), -1, file: file, line: line)
        XCTAssertEqual(errno, ESRCH, file: file, line: line)
    }

    private func envelope(
        type: String,
        runID: String,
        requestID: String,
        payload: [String: Any],
        extra: [String: Any] = [:]
    ) -> [String: Any] {
        var value: [String: Any] = [
            "protocolVersion": 1,
            "type": type,
            "runID": runID,
            "requestID": requestID,
            "timestamp": "2026-07-21T12:00:00.000Z",
            "payload": payload
        ]
        extra.forEach { value[$0.key] = $0.value }
        return value
    }

    private func jsonl(_ objects: [[String: Any]]) -> Data {
        var data = Data()
        for object in objects {
            data.append(try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            data.append(0x0A)
        }
        return data
    }
}

private final class SnapshotCaptureLoopService: @unchecked Sendable, LoopServicing {
    private let lock = NSLock()
    private var captured: ExpectedModelSelection?

    var selection: ExpectedModelSelection? {
        lock.withLock { captured }
    }

    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        lock.withLock { captured = expectedModelSelection }
        return ClarificationResult(
            summary: "Captured",
            questions: [ClarifyingQuestion(id: "Q1", question: "Continue?", whyItMatters: "Test")],
            timeline: TimelineEntry(role: .orchestrator, title: "Captured", summary: "Captured", metrics: .init())
        )
    }

    func execute(goal: String, summary: String, questions: [ClarifyingQuestion], answers: [String: String], maxReviewCycles: Int, attachments: [ImageAttachment], researchProvider: String?, artifactWorkspace: String?, approveArtifactWrites: Bool, approveVerificationCommands: Bool, expectedModelSelection: ExpectedModelSelection, runID: UUID?, emit: @escaping @Sendable (LoopEngineEvent) async -> Void) async throws -> LoopExecutionResult {
        throw CancellationError()
    }
}

private struct CatalogRaceLoopService: LoopServicing {
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
