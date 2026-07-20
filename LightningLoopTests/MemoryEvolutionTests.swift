import XCTest
@testable import LightningLoop

final class MemoryEvolutionTests: XCTestCase {
    func testTerminalManagedLedgersDecodeWithNativeSchemas() throws {
        let memoryJSON = #"""
        [{
          "id": "11111111-1111-4111-8111-111111111111",
          "scope": "project",
          "statement": "Prefer deterministic acceptance tests.",
          "tags": ["quality"],
          "sourceArtifact": "Terminal user note",
          "confidence": 1,
          "verification": "unverified",
          "createdAt": "2026-07-19T12:00:00Z",
          "promotionApprovedByUser": false
        }]
        """#
        let evolutionJSON = #"""
        [{
          "id": "22222222-2222-4222-8222-222222222222",
          "kind": "system_prompt",
          "name": "Evidence first",
          "version": "0.1.0-draft",
          "state": "draft",
          "source": "Terminal user proposal",
          "reason": "Reduce unsupported claims",
          "exactDiff": "Require named evidence for material assertions.",
          "permissions": [],
          "evaluationSuite": "Not yet assigned",
          "reviewerHasMaterialFinding": false,
          "createdAt": "2026-07-19T12:00:00Z"
        }]
        """#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let memories = try decoder.decode([MemoryRecord].self, from: Data(memoryJSON.utf8))
        let evolutions = try decoder.decode([EvolutionProposal].self, from: Data(evolutionJSON.utf8))
        XCTAssertEqual(memories.first?.scope, .project)
        XCTAssertFalse(memories.first?.promotionApprovedByUser ?? true)
        XCTAssertEqual(evolutions.first?.kind, .systemPrompt)
        XCTAssertEqual(evolutions.first?.state, .draft)
    }

    func testHarnessPreviewAndScriptEvidenceDecodeWithNativeSchema() throws {
        let reportJSON = #"""
        {
          "enabled": true,
          "passed": true,
          "summary": "Verified preview and runner evidence.",
          "files": [{"path":"_lightningloop/previews/index-desktop.png","bytes":128,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
          "commands": [{"executable":"python3","arguments":["-m","compileall","-q","."],"purpose":"Harness-selected Python syntax compilation","exitCode":0,"output":"","passed":true,"origin":"harness","durationMs":42}],
          "previews": [{
            "kind":"html",
            "title":"index.html static picture evidence",
            "sourcePath":"index.html",
            "previewPath":"_lightningloop/previews/index-desktop.png",
            "mimeType":"image/png",
            "passed":true,
            "message":"Rendered and served over loopback.",
            "width":1280,
            "height":1280,
            "loopback":{"scheme":"http","host":"127.0.0.1","status":200,"contentType":"text/html; charset=utf-8","bytes":512,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
          }],
          "workspaceAudit":{"passed":true,"files":2,"bytes":640,"message":"Confined."}
        }
        """#
        let report = try JSONDecoder().decode(ArtifactExecutionReport.self, from: Data(reportJSON.utf8))
        XCTAssertTrue(report.passed)
        XCTAssertEqual(report.commands.first?.origin, "harness")
        XCTAssertEqual(report.commands.first?.durationMs, 42)
        XCTAssertEqual(report.previews?.first?.loopback?.status, 200)
        XCTAssertEqual(report.previews?.first?.previewPath, "_lightningloop/previews/index-desktop.png")
    }

    func testProjectMemoryRequiresExplicitPromotion() {
        var memory = MemoryRecord(
            scope: .project,
            statement: "Use deterministic Gold gates.",
            tags: ["policy"],
            sourceArtifact: "User-provided note",
            promotionApprovedByUser: false
        )
        XCTAssertFalse(memory.isEligible)
        memory.promotionApprovedByUser = true
        XCTAssertTrue(memory.isEligible)
        memory.verification = .contradicted
        XCTAssertFalse(memory.isEligible)
    }

    func testRunMemoryOnlyAppliesToItsBoundSession() {
        let runID = UUID()
        let memory = MemoryRecord(
            scope: .run,
            statement: "Keep the output concise.",
            tags: [],
            sourceArtifact: "User note",
            sourceRunID: runID,
            promotionApprovedByUser: true
        )
        XCTAssertTrue(memory.isEligible(for: runID))
        XCTAssertFalse(memory.isEligible(for: UUID()))
        XCTAssertFalse(memory.isEligible(for: nil))
    }

    func testEvolutionCannotActivateWithoutEveryGate() {
        var proposal = EvolutionProposal(
            kind: .skill,
            name: "Website Studio",
            source: "User-provided",
            reason: "Add responsive site workflow",
            exactDiff: "+ draft workflow"
        )
        XCTAssertFalse(proposal.canActivate)
        proposal.state = .userApproved
        proposal.evaluationSummary = "Held-out suite passed"
        proposal.rollbackTarget = "catalog@0.1.0"
        XCTAssertTrue(proposal.canActivate)
        proposal.reviewerHasMaterialFinding = true
        XCTAssertFalse(proposal.canActivate)
    }

    func testCredentialProvidersHaveDistinctKeychainServices() {
        let services = CredentialProvider.allCases.map(\.service)
        XCTAssertEqual(Set(services).count, CredentialProvider.allCases.count)
        XCTAssertTrue(services.allSatisfy { $0.hasPrefix("com.barnlabs.LightningLoop.") })
    }

    func testEvolutionActivationRequiresEvidenceRollbackAndCleanReview() {
        var proposal = EvolutionProposal(
            kind: .systemPrompt,
            name: "Primary sources",
            source: "User-provided",
            reason: "Improve factual grounding",
            exactDiff: "Prefer primary-source citations."
        )
        proposal.state = .userApproved
        XCTAssertFalse(proposal.canActivate)
        proposal.evaluationSummary = "Held-out citation suite passed."
        proposal.rollbackTarget = "system-prompt@0.1.0"
        XCTAssertTrue(proposal.canActivate)
        proposal.reviewerHasMaterialFinding = true
        XCTAssertFalse(proposal.canActivate)
    }

    func testHistoricalCustomCredentialBlocksMemoryAndEvolutionAfterProfileSwitch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        var former = ProviderConfiguration.preset(.custom)
        former.id = "former-host"
        former.baseURL = "https://former.example.com/v1"
        var active = ProviderConfiguration.preset(.custom)
        active.id = "active-host"
        active.baseURL = "https://active.example.com/v1"
        let registry = CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("services.json"))
        XCTAssertTrue(try registry.register(profile: former))
        let secret = "former-custom-secret-value"
        let formerService = former.credentialService
        XCTAssertTrue(try CredentialServiceCatalog.services(activeProfile: active, registry: registry).contains(formerService))

        let memoryURL = root.appendingPathComponent("memory.json")
        let memory = MemoryRecord(scope: .project, statement: "Do not expose \(secret)", tags: [], sourceArtifact: "fixture", promotionApprovedByUser: true)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        try encoder.encode([memory]).write(to: memoryURL)
        let reader = ActiveMemoryReader(fileURL: memoryURL, providerProfile: active, credentialRegistry: registry,
                                        credentialReader: { service in service == formerService ? secret : nil })
        XCTAssertTrue(reader.eligibleMemory(for: nil).isEmpty)

        var proposal = EvolutionProposal(kind: .systemPrompt, name: "Fixture", source: "test", reason: "test", exactDiff: "Do not expose \(secret)")
        proposal.state = .active
        let evolutionURL = root.appendingPathComponent("evolutions.json")
        try encoder.encode([proposal]).write(to: evolutionURL)
        let evolutionReader = ActiveEvolutionReader(fileURL: evolutionURL, providerProfile: active, credentialRegistry: registry,
                                                    credentialReader: { service in service == formerService ? secret : nil })
        XCTAssertTrue(evolutionReader.activeSystemPromptAddenda().isEmpty)
    }

    func testLongLivedReadersRecomputeRegistryAndCredentialsOnEveryRead() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        var former = ProviderConfiguration.preset(.custom)
        former.id = "former-dynamic"
        former.baseURL = "https://former-dynamic.example.com/v1"
        var active = ProviderConfiguration.preset(.custom)
        active.id = "active-dynamic"
        active.baseURL = "https://active-dynamic.example.com/v1"
        let registry = CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("services.json"))
        let credentials = DynamicCredentialStore()
        let secret = "credential-added-after-reader-init"
        credentials.set(secret, for: former.credentialService)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let memoryURL = root.appendingPathComponent("memory.json")
        let memory = MemoryRecord(
            scope: .project,
            statement: "Historical value: \(secret)",
            tags: [],
            sourceArtifact: "fixture",
            promotionApprovedByUser: true
        )
        try encoder.encode([memory]).write(to: memoryURL)
        var proposal = EvolutionProposal(
            kind: .systemPrompt,
            name: "Dynamic catalog",
            source: "test",
            reason: "test",
            exactDiff: "Historical value: \(secret)"
        )
        proposal.state = .active
        let evolutionURL = root.appendingPathComponent("evolutions.json")
        try encoder.encode([proposal]).write(to: evolutionURL)

        let memoryReader = ActiveMemoryReader(
            fileURL: memoryURL,
            providerProfile: active,
            credentialRegistry: registry,
            credentialReader: credentials.read
        )
        let evolutionReader = ActiveEvolutionReader(
            fileURL: evolutionURL,
            providerProfile: active,
            credentialRegistry: registry,
            credentialReader: credentials.read
        )
        XCTAssertEqual(memoryReader.eligibleMemory(for: nil).count, 1)
        XCTAssertEqual(evolutionReader.activeSystemPromptAddenda().count, 1)

        XCTAssertTrue(try registry.register(profile: former))
        XCTAssertTrue(memoryReader.eligibleMemory(for: nil).isEmpty)
        XCTAssertTrue(evolutionReader.activeSystemPromptAddenda().isEmpty)
    }

    func testShortNewCredentialIsRejectedAndLegacyShortCredentialIsStillProtected() throws {
        XCTAssertThrowsError(try KeychainStore(account: "lightningloop-length-test").saveCredential("tiny", for: .custom)) {
            XCTAssertEqual($0 as? KeychainStoreError, .invalidCredentialLength)
        }

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let active = ProviderConfiguration.preset(.custom)
        let memoryURL = root.appendingPathComponent("memory.json")
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        try encoder.encode([
            MemoryRecord(scope: .project, statement: "legacy tiny value", tags: [], sourceArtifact: "fixture", promotionApprovedByUser: true)
        ]).write(to: memoryURL)
        let reader = ActiveMemoryReader(
            fileURL: memoryURL,
            providerProfile: active,
            credentialRegistry: .init(fileURL: root.appendingPathComponent("services.json")),
            credentialReader: { service in service == active.credentialService ? "tiny" : nil }
        )
        XCTAssertTrue(reader.eligibleMemory(for: nil).isEmpty)
    }

    @MainActor
    func testLoadedSessionsAndLedgersAreSanitizedWithoutRewritingSourceHistory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let secret = "historical-credential-value"
        let active = ProviderConfiguration.preset(.custom)
        let registry = CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("services.json"))
        let sessionArchive = SessionArchive(fileURL: root.appendingPathComponent("sessions.json"))
        var session = LoopSession(goal: "Goal \(secret)")
        session.implementation = "Deliverable \(secret)"
        XCTAssertTrue(sessionArchive.save([session]))
        let rawSessionBytes = try Data(contentsOf: root.appendingPathComponent("sessions.json"))

        let memoryArchive = MemoryArchive(fileURL: root.appendingPathComponent("memory.json"), credentialRegistry: registry)
        XCTAssertTrue(memoryArchive.save([
            MemoryRecord(scope: .project, statement: "Memory \(secret)", tags: [secret], sourceArtifact: secret, promotionApprovedByUser: true)
        ]))
        let rawMemoryBytes = try Data(contentsOf: root.appendingPathComponent("memory.json"))
        let evolutionArchive = EvolutionArchive(fileURL: root.appendingPathComponent("evolutions.json"), credentialRegistry: registry)
        var proposal = EvolutionProposal(kind: .skill, name: secret, source: secret, reason: secret, exactDiff: secret)
        proposal.state = .active
        XCTAssertTrue(evolutionArchive.save([proposal]))
        let rawEvolutionBytes = try Data(contentsOf: root.appendingPathComponent("evolutions.json"))

        let providerStore = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try providerStore.save(active)
        let model = AppModel(
            engine: LedgerMutationTestService(),
            archive: sessionArchive,
            memoryArchive: memoryArchive,
            evolutionArchive: evolutionArchive,
            providerStore: providerStore,
            credentialRegistry: registry,
            credentialReader: { service in service == active.credentialService ? secret : nil },
            skipCredentialRefresh: true
        )
        let observable = String(describing: model.sessions) + String(describing: model.memories) + String(describing: model.evolutions)
        XCTAssertFalse(observable.contains(secret))
        XCTAssertTrue(observable.contains("REDACTED"))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("sessions.json")), rawSessionBytes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("memory.json")), rawMemoryBytes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("evolutions.json")), rawEvolutionBytes)
    }

    @MainActor
    func testInvalidCredentialRegistryFailsClosedForLedgerReadsAndMutations() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let registryURL = root.appendingPathComponent("services.json")
        try Data("not-json".utf8).write(to: registryURL)
        let registry = CustomCredentialServiceRegistry(fileURL: registryURL)
        XCTAssertEqual(registry.state(), .invalid)

        let memoryURL = root.appendingPathComponent("memory.json")
        let evolutionURL = root.appendingPathComponent("evolutions.json")
        let originalMemory = Data("preserve-memory-history".utf8)
        let originalEvolution = Data("preserve-evolution-history".utf8)
        try originalMemory.write(to: memoryURL)
        try originalEvolution.write(to: evolutionURL)
        let memoryArchive = MemoryArchive(fileURL: memoryURL, credentialRegistry: registry)
        let evolutionArchive = EvolutionArchive(fileURL: evolutionURL, credentialRegistry: registry)
        XCTAssertNil(memoryArchive.loadForMutation())
        XCTAssertNil(evolutionArchive.loadForMutation())
        XCTAssertFalse(memoryArchive.save([]))
        XCTAssertFalse(evolutionArchive.save([]))
        XCTAssertTrue(ActiveMemoryReader(fileURL: memoryURL, credentialRegistry: registry).eligibleMemory(for: nil).isEmpty)
        XCTAssertTrue(ActiveEvolutionReader(fileURL: evolutionURL, credentialRegistry: registry).activeSystemPromptAddenda().isEmpty)

        let model = AppModel(
            engine: LedgerMutationTestService(),
            memoryArchive: memoryArchive,
            evolutionArchive: evolutionArchive,
            credentialRegistry: registry,
            skipCredentialRefresh: true
        )
        model.addMemory(statement: "safe", source: "test", tags: "", scope: .project)
        XCTAssertTrue(model.memories.isEmpty)
        XCTAssertTrue(model.settingsMessage.contains("malformed or unsafe"))
        model.addEvolution(kind: .skill, name: "safe", source: "test", reason: "test", exactDiff: "+safe")
        XCTAssertTrue(model.evolutions.isEmpty)
        XCTAssertTrue(model.settingsMessage.contains("malformed or unsafe"))
        XCTAssertEqual(try Data(contentsOf: memoryURL), originalMemory)
        XCTAssertEqual(try Data(contentsOf: evolutionURL), originalEvolution)
    }

    func testOversizedSymlinkedAndUnreadableCredentialRegistriesAreInvalid() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("missing.json")).state(), .missing)

        let oversized = root.appendingPathComponent("oversized.json")
        try Data(repeating: 0x41, count: 32_769).write(to: oversized)
        XCTAssertEqual(CustomCredentialServiceRegistry(fileURL: oversized).state(), .invalid)

        let target = root.appendingPathComponent("target.json")
        try Data("[]".utf8).write(to: target)
        let link = root.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertEqual(CustomCredentialServiceRegistry(fileURL: link).state(), .invalid)

        let unreadable = root.appendingPathComponent("unreadable.json")
        try Data("[]".utf8).write(to: unreadable)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: unreadable.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: unreadable.path) }
        XCTAssertEqual(CustomCredentialServiceRegistry(fileURL: unreadable).state(), .invalid)
    }

    func testRegistryWriteFailureDoesNotCreateCredentialValueAndHostSwitchRetainsOnlyServiceIDs() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let blockedParent = root.appendingPathComponent("not-a-directory")
        try Data("block".utf8).write(to: blockedParent)
        let blocked = CustomCredentialServiceRegistry(fileURL: blockedParent.appendingPathComponent("services.json"))
        XCTAssertThrowsError(try blocked.register(profile: .preset(.custom)))

        let registry = CustomCredentialServiceRegistry(fileURL: root.appendingPathComponent("services.json"))
        var first = ProviderConfiguration.preset(.custom)
        first.id = "first"
        first.baseURL = "https://first.example.com/v1"
        var second = ProviderConfiguration.preset(.custom)
        second.id = "second"
        second.baseURL = "https://second.example.com/v1"
        XCTAssertTrue(try registry.register(profile: first))
        XCTAssertTrue(try registry.register(profile: second))
        guard case .valid(let services) = registry.state() else { return XCTFail("Expected valid registry") }
        XCTAssertEqual(services, [first.credentialService, second.credentialService])
        let persisted = try String(contentsOf: registry.fileURL, encoding: .utf8)
        XCTAssertFalse(persisted.contains("credential-value"))
        XCTAssertTrue(persisted.contains("first.example.com"))
        XCTAssertTrue(persisted.contains("second.example.com"))
    }

    func testEveryBuiltInPresetIsPiManagedAndOnlyCustomAllowsNativeConnectionTesting() {
        for preset in ProviderPreset.allCases where preset != .custom && preset != .selectionRequired {
            let profile = ProviderConfiguration.preset(preset)
            XCTAssertTrue(profile.usesPiAuthentication, "\(preset.rawValue) must be Pi-managed")
            XCTAssertFalse(profile.allowsNativeConnectionTesting)
        }
        XCTAssertTrue(ProviderConfiguration.preset(.custom).allowsNativeConnectionTesting)
        for provider in [CredentialProvider.cerebras, .groq, .fireworks] {
            XCTAssertThrowsError(try KeychainStore(account: "lightningloop-test").saveCredential("must-not-save", for: provider)) { error in
                XCTAssertTrue(error is KeychainStoreError)
            }
        }
    }

    @MainActor
    func testNoHarnessRuntimeDoesNotAdvertiseAutomaticResearch() {
        let blocked = AppModel(
            engine: LedgerMutationTestService(),
            credentialReader: { _ in nil },
            runtimeLabel: "Shared Pi harness unavailable · loop execution blocked",
            skipCredentialRefresh: true
        )
        let shared = AppModel(
            engine: LedgerMutationTestService(),
            credentialReader: { _ in nil },
            runtimeLabel: "Shared Pi harness",
            skipCredentialRefresh: true
        )

        XCTAssertFalse(blocked.supportsAutomaticResearch)
        XCTAssertFalse(blocked.hasAPIKey)
        XCTAssertTrue(shared.supportsAutomaticResearch)
    }
}

private final class DynamicCredentialStore: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func set(_ value: String, for service: String) {
        lock.withLock { values[service] = value }
    }

    func read(_ service: String) throws -> String? {
        lock.withLock { values[service] }
    }
}

private struct LedgerMutationTestService: LoopServicing {
    func clarify(goal: String, attachments: [ImageAttachment], runID: UUID?) async throws -> ClarificationResult { throw CancellationError() }
    func execute(goal: String, summary: String, questions: [ClarifyingQuestion], answers: [String: String], maxReviewCycles: Int, attachments: [ImageAttachment], researchProvider: String?, artifactWorkspace: String?, approveArtifactWrites: Bool, approveVerificationCommands: Bool, runID: UUID?, emit: @escaping @Sendable (LoopEngineEvent) async -> Void) async throws -> LoopExecutionResult { throw CancellationError() }
}
