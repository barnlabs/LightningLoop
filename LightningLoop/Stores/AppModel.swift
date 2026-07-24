import AppKit
import CryptoKit
import Foundation
import Observation
import UniformTypeIdentifiers

@Observable
@MainActor
final class AppModel {
    var sessions: [LoopSession]
    var memories: [MemoryRecord]
    var evolutions: [EvolutionProposal]
    var selectedSessionID: UUID?
    var isRunning = false
    var settingsMessage = ""
    var connectionMetrics: InferenceMetrics?
    var providerProfile: ProviderConfiguration
    /// Custom-provider discovery results (OpenAI-compatible `/models` IDs).
    var availableModels: [String] = []
    /// Richer view of custom discovery (display name defaults to the model ID).
    var discoveredCustomModels: [ProviderModelOption] = []
    var runtimeModels: [ProviderModelOption] = []
    private(set) var runtimeModelCatalogProviderID: String?
    private(set) var runtimeModelCatalogScope = ""
    let runtimeLabel: String
    private(set) var credentialStates: [CredentialProvider: Bool] = [:]
    private(set) var activeInferenceCredentialConfigured = false

    static let autoTitleLLMPreferenceKey = "autoTitleLLMEnabled"

    private let engine: any LoopServicing
    private let keychain: KeychainStore
    private let archive: SessionArchive
    private let memoryArchive: MemoryArchive
    private let evolutionArchive: EvolutionArchive
    private let providerStore: ProviderConfigurationStore
    private let credentialRegistry: CustomCredentialServiceRegistry
    private let credentialReader: @Sendable (String) throws -> String?
    private let attachmentStore: ImageAttachmentStore
    private let artifactOpenURL: (URL) -> Bool
    private let notificationSend: @Sendable (String, String) async -> Void
    private var operation: Task<Void, Never>?
    private var artifactBrowserSession: ArtifactBrowserSession?
    private var artifactOpenSnapshots: [URL] = []
    /// Monotonic per-session token so stale optional LLM title completions cannot clobber newer titles.
    private var titleGenerations: [UUID: UInt64] = [:]
    private var titleTasks: [UUID: Task<Void, Never>] = [:]

    init(
        engine: any LoopServicing,
        keychain: KeychainStore = .init(),
        archive: SessionArchive? = nil,
        memoryArchive: MemoryArchive? = nil,
        evolutionArchive: EvolutionArchive? = nil,
        providerStore: ProviderConfigurationStore = .init(),
        credentialRegistry: CustomCredentialServiceRegistry = .init(),
        credentialReader: (@Sendable (String) throws -> String?)? = nil,
        attachmentStore: ImageAttachmentStore = .init(),
        runtimeLabel: String = "Native direct engine",
        skipCredentialRefresh: Bool = false,
        artifactOpenURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) },
        notificationSend: @escaping @Sendable (String, String) async -> Void = { title, body in
            await LoopNotificationService.send(title: title, body: body)
        }
    ) {
        self.engine = engine
        self.runtimeLabel = runtimeLabel
        self.keychain = keychain
        let resolvedArchive = archive ?? .init()
        self.archive = resolvedArchive
        self.memoryArchive = memoryArchive ?? .init(credentialRegistry: credentialRegistry)
        self.evolutionArchive = evolutionArchive ?? .init(credentialRegistry: credentialRegistry)
        self.providerStore = providerStore
        self.credentialRegistry = credentialRegistry
        self.credentialReader = credentialReader ?? { service in try keychain.readCredential(service: service) }
        self.attachmentStore = attachmentStore
        self.artifactOpenURL = artifactOpenURL
        self.notificationSend = notificationSend
        self.providerProfile = providerStore.load()
        let loaded = resolvedArchive.load().map { session in
            var migrated = session
            let legacy = SessionTitle.collapseWhitespace(session.goal)
            // Migrate pre-title-system archives that stored a raw goal prefix.
            if !legacy.isEmpty,
               session.titleSource == .provisional,
               !session.titleLocked,
               (session.title == String(legacy.prefix(52))
                || session.title == String(legacy.prefix(91)) + "…"
                || session.title == legacy) {
                migrated.title = SessionTitle.provisional(from: legacy)
                migrated.titleSource = .provisional
            }
            return migrated
        }
        self.sessions = loaded.isEmpty ? [LoopSession()] : loaded
        self.memories = self.memoryArchive.load()
        self.evolutions = self.evolutionArchive.load()
        self.selectedSessionID = self.sessions.first?.id
        let initialSanitize = makeTextSanitizer()
        self.sessions = self.sessions.map { sanitizedSession($0, using: initialSanitize) }
        self.memories = self.memories.map { sanitizedMemory($0, using: initialSanitize) }
        self.evolutions = self.evolutions.map { sanitizedEvolution($0, using: initialSanitize) }
        if skipCredentialRefresh {
            credentialStates = [:]
            activeInferenceCredentialConfigured = false
        } else {
            refreshCredentialState()
        }
    }

    static func live() -> AppModel {
        let keychain = KeychainStore()
        if NSClassFromString("XCTestCase") != nil || ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_TESTING"] == "1" {
            let fixtureRoot = FileManager.default.temporaryDirectory
                .appendingPathComponent("LightningLoopTests-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
            let credentialRegistry = CustomCredentialServiceRegistry(
                fileURL: fixtureRoot.appendingPathComponent("custom-credential-services.json")
            )
            let providerStore = ProviderConfigurationStore(fileURL: fixtureRoot.appendingPathComponent("provider.json"))
            let model = AppModel(
                engine: LoopEngine(agent: ProviderClient(
                    keychain: keychain,
                    profileStore: providerStore,
                    credentialReader: { _ in nil }
                )),
                keychain: keychain,
                archive: SessionArchive(fileURL: fixtureRoot.appendingPathComponent("sessions.json")),
                memoryArchive: MemoryArchive(
                    fileURL: fixtureRoot.appendingPathComponent("memory.json"),
                    credentialRegistry: credentialRegistry
                ),
                evolutionArchive: EvolutionArchive(
                    fileURL: fixtureRoot.appendingPathComponent("evolutions.json"),
                    credentialRegistry: credentialRegistry
                ),
                providerStore: providerStore,
                credentialRegistry: credentialRegistry,
                credentialReader: { _ in nil },
                attachmentStore: ImageAttachmentStore(rootURL: fixtureRoot.appendingPathComponent("attachments", isDirectory: true)),
                runtimeLabel: "Native test engine",
                skipCredentialRefresh: ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_TESTING"] == "1"
            )
            model.activeInferenceCredentialConfigured = false
            model.credentialStates = [:]
            if let root = ProcessInfo.processInfo.environment["LIGHTNINGLOOP_EVIDENCE_DEMO_ROOT"] {
                model.installEvidenceDemo(rootPath: root)
            }
#if DEBUG
            if let scenario = ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_SCENARIO"] {
                model.installUITestScenario(scenario)
            }
#endif
            return model
        }
        let providerStore = ProviderConfigurationStore()
        if let harness = HarnessProcessClient.discover() {
            let model = AppModel(engine: harness, keychain: keychain, providerStore: providerStore, runtimeLabel: "Shared LightningLoop runtime")
            Task { await model.refreshRuntimeModelCatalog() }
            return model
        }
        return AppModel(
            engine: NativeFallbackBlockedService(),
            keychain: keychain,
            providerStore: providerStore,
            runtimeLabel: "Shared LightningLoop runtime unavailable · loop execution blocked"
        )
    }

    var selectedSession: LoopSession? {
        guard let selectedSessionID else { return nil }
        return sessions.first(where: { $0.id == selectedSessionID })
    }

    var hasAPIKey: Bool {
        runtimeLabel == "Shared LightningLoop runtime"
            && !providerProfile.requiresProviderSelection
            && (activeInferenceCredentialConfigured || providerProfile.usesPiAuthentication)
            && activeRuntimeModelSelectionBlocker == nil
    }
    var supportsAutomaticResearch: Bool { runtimeLabel == "Shared LightningLoop runtime" }
    var supportsWorkspaceArtifacts: Bool { runtimeLabel == "Shared LightningLoop runtime" }

    var loopReadinessMessage: String? {
        guard runtimeLabel == "Shared LightningLoop runtime" else {
            return "The shared LightningLoop runtime is unavailable. You can draft a goal, but running the loop is blocked."
        }
        if providerProfile.requiresProviderSelection {
            return "Choose an inference provider and model before running this loop."
        }
        if let activeRuntimeModelSelectionBlocker {
            return activeRuntimeModelSelectionBlocker
        }
        guard hasAPIKey else {
            return "Provider access is not ready. Use the provider's official sign-in flow before running this loop."
        }
        return nil
    }

    var selectedRuntimeModelCatalogued: Bool? {
        guard runtimeModelCatalogProviderID == providerProfile.id else { return nil }
        return runtimeModels.contains(where: { $0.modelID == providerProfile.modelID })
    }

    private var activeRuntimeModelSelectionBlocker: String? {
        guard providerProfile.usesPiAuthentication else { return nil }
        if providerProfile.requiresRuntimeModelVerification, selectedRuntimeModelCatalogued != true {
            return providerProfile.runtimeModelSelectionNotice
                ?? "Gemma 4 31B is a public-preview preference. Refresh the installed runtime catalog and choose a listed model if it is absent."
        }
        if runtimeModelCatalogProviderID != providerProfile.id {
            return "Refresh the installed LightningLoop runtime catalog before running a loop. Catalogued means the pinned runtime lists the model ID — not provider sign-in."
        }
        guard selectedRuntimeModelCatalogued == true else {
            return "\(providerProfile.modelName) is not catalogued by the installed LightningLoop runtime. Choose a listed model from the runtime catalog."
        }
        return nil
    }

    private var expectedModelSelection: ExpectedModelSelection? {
        if providerProfile.usesPiAuthentication {
            guard runtimeModelCatalogProviderID == providerProfile.id,
                  let model = runtimeModels.first(where: { $0.modelID == providerProfile.modelID }) else { return nil }
            return ExpectedModelSelection(
                providerID: providerProfile.id,
                modelID: model.modelID,
                supportsImages: model.supportsImages,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxOutputTokens
            )
        }
        return ExpectedModelSelection(
            providerID: providerProfile.id,
            modelID: providerProfile.modelID,
            supportsImages: providerProfile.supportsImages,
            contextWindow: providerProfile.contextWindow,
            maxOutputTokens: providerProfile.maxOutputTokens
        )
    }

    func hasCredential(_ provider: CredentialProvider) -> Bool {
        credentialStates[provider] == true
    }

    func hasCredential(_ profile: ProviderConfiguration) -> Bool {
        profile.credentialService == providerProfile.credentialService && activeInferenceCredentialConfigured
    }

    var allQuestionsAnswered: Bool {
        guard let session = selectedSession, !session.questions.isEmpty else { return false }
        return session.questions.allSatisfy {
            !(session.answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func installEvidenceDemo(rootPath: String) {
        let root = URL(fileURLWithPath: rootPath, isDirectory: true).standardizedFileURL
        let htmlPath = "Examples/GoldLanding/index.html"
        let cssPath = "Examples/GoldLanding/styles.css"
        let sourcePath = "Harness/core/loop-engine.ts"
        let previewPath = "docs/screenshots/lightningloop-landing-1280.png"
        let relativePaths = [htmlPath, cssPath, sourcePath, previewPath]
        let evidence = relativePaths.compactMap { path -> ArtifactFileEvidence? in
            let url = root.appendingPathComponent(path)
            guard let data = try? Data(contentsOf: url) else { return nil }
            return .init(path: path, bytes: data.count, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
        }
        guard evidence.count == relativePaths.count,
              let html = try? Data(contentsOf: root.appendingPathComponent(htmlPath)),
              evidence.contains(where: { $0.path == previewPath }) else { return }
        var session = LoopSession(goal: "UI test fixture: static responsive BarnLabs layout")
        session.title = "UI TEST FIXTURE · Evidence Lab"
        session.criteria = [
            .init(id: "C1", title: "Rendered experience", detail: "The site must render as a complete desktop composition.", evidence: "Harness-produced PNG and localhost HTTP 200 proof."),
            .init(id: "C2", title: "Inspectable implementation", detail: "Source and test evidence must remain visible.", evidence: "In-app source viewer and sandboxed runner output.")
        ]
        session.plan = [.init(id: "P1", title: "Build, serve, render, challenge", detail: "Create the site, run checks, serve it on loopback, and capture the rendered result.", proof: "Evidence Lab report")]
        session.implementation = "# UI TEST FIXTURE\n\nStatic layout data for UI automation; it is not a current verification result."
        session.implementationNotes = ["UI TEST FIXTURE — NOT CURRENT VERIFICATION. The checked-in files only make this interface deterministic for UI tests."]
        session.stage = .paused
        session.statusMessage = "UI TEST FIXTURE — NOT CURRENT VERIFICATION."
        session.artifactWorkspacePath = root.path
        session.artifactVerificationCommands = true
        session.artifactReport = .init(
            enabled: true,
            passed: false,
            summary: "UI TEST FIXTURE — NOT CURRENT VERIFICATION.",
            files: evidence,
            commands: [],
            previews: [.init(
                kind: "html",
                title: "index.html static picture evidence",
                sourcePath: htmlPath,
                previewPath: previewPath,
                mimeType: "image/png",
                passed: false,
                message: "UI TEST FIXTURE — NOT CURRENT VERIFICATION.",
                width: 1280,
                height: 1000,
                loopback: .init(
                    scheme: "http",
                    host: "127.0.0.1",
                    status: 200,
                    contentType: "text/html; charset=utf-8",
                    bytes: html.count,
                    sha256: SHA256.hash(data: html).map { String(format: "%02x", $0) }.joined()
                )
            )],
            workspaceAudit: .init(passed: false, files: evidence.count, bytes: evidence.reduce(0) { $0 + $1.bytes }, message: "UI TEST FIXTURE — NOT CURRENT VERIFICATION.")
        )
        sessions = [session]
        selectedSessionID = session.id
    }

    /// Deterministic, credential-free visual states for DEBUG screenshot and UI
    /// test evidence. Production launches cannot reach this path without the
    /// separate LIGHTNINGLOOP_UI_TESTING guard in `live()`.
#if DEBUG
    private func installUITestScenario(_ scenario: String) {
        switch scenario {
        case "new-loop":
            providerProfile = .onboarding
            let session = LoopSession()
            sessions = [session]
            selectedSessionID = session.id
        case "settings-model", "settings-update":
            providerProfile = .preset(.cerebras)
            runtimeModels = [
                ProviderConfiguration.cerebrasGemma4_31B,
                .init(
                    modelID: "gpt-oss-120b",
                    modelName: "GPT-OSS 120B",
                    supportsImages: false,
                    contextWindow: 131_072,
                    maxOutputTokens: 32_768
                )
            ]
            runtimeModelCatalogProviderID = providerProfile.id
            runtimeModelCatalogScope = "Installed runtime catalog · credential-free metadata"
            settingsMessage = "Gemma 4 31B is catalogued by the installed LightningLoop runtime. Provider sign-in is checked only when a run starts."
        case "working":
            var session = LoopSession(goal: "Prepare a launch brief with source-backed claims")
            session.title = "Prepare a source-backed launch brief"
            session.stage = .clarifying
            session.statusMessage = "Orchestrator is isolating the decisions that matter…"
            session.updatedAt = Date()
            sessions = [session]
            selectedSessionID = session.id
            isRunning = true
        case "blocked-history":
            var blocked = LoopSession(goal: "Audit a release candidate")
            blocked.title = "Audit the release candidate"
            blocked.stage = .paused
            blocked.statusMessage = "Paused: the selected model is no longer present in the installed runtime catalog."
            blocked.questions = [
                .init(id: "Q1", question: "Which release candidate should be audited?", whyItMatters: "The evidence must bind to one exact build.")
            ]
            blocked.answers = ["Q1": "Current local candidate"]
            blocked.updatedAt = Date()

            var failed = LoopSession(goal: "Verify installer rollback")
            failed.title = "Verify installer rollback"
            failed.stage = .failed
            failed.statusMessage = "Stopped safely: the rollback fixture returned an incomplete byte-state match."
            failed.updatedAt = Date().addingTimeInterval(-1_800)

            var completed = LoopSession(goal: "Write a concise project brief")
            completed.title = "Write a concise project brief"
            completed.stage = .completed
            completed.statusMessage = "Gold after two review rounds."
            completed.implementation = "# Project brief\n\nA bounded, reviewed deliverable with criterion-linked evidence."
            completed.updatedAt = Date().addingTimeInterval(-7_200)

            sessions = [blocked, failed, completed]
            selectedSessionID = blocked.id
        default:
            break
        }
    }
#endif

    func newSession() {
        let session = LoopSession()
        sessions.insert(session, at: 0)
        selectedSessionID = session.id
        persist()
    }

    func deleteSelectedSession() {
        guard let id = selectedSessionID else { return }
        sessions.removeAll { $0.id == id }
        if sessions.isEmpty { sessions = [LoopSession()] }
        selectedSessionID = sessions.first?.id
        persist()
    }

    func updateGoal(_ goal: String) {
        guard let sanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Goal editing is blocked because the credential catalog is unavailable. Existing history was not changed."
            return
        }
        let safeGoal = sanitizer.sanitize(goal)
        mutateSelected { session in
            session.goal = safeGoal
            if SessionTitle.shouldAutoUpdate(source: session.titleSource, locked: session.titleLocked),
               session.titleSource == .provisional {
                session.title = SessionTitle.provisional(from: safeGoal)
            }
            session.updatedAt = Date()
        }
        persist()
    }

    /// User rename locks auto-title until unlocked.
    func renameSelectedSession(to rawTitle: String) {
        guard !isRunning else { return }
        guard let sanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Rename is blocked because the credential catalog is unavailable."
            return
        }
        let cleaned = SessionTitle.collapseWhitespace(sanitizer.sanitize(rawTitle))
        guard !cleaned.isEmpty else { return }
        let title = SessionTitle.truncate(cleaned, maxLength: SessionTitle.maxLength)
        guard let sessionID = selectedSessionID else { return }
        // Invalidate any in-flight optional LLM title for this session.
        invalidateTitleGeneration(for: sessionID)
        mutateSelected { session in
            session.title = title
            session.titleSource = .manual
            session.titleLocked = true
            session.updatedAt = Date()
        }
        persist()
    }

    func unlockSelectedSessionTitle() {
        guard !isRunning else { return }
        guard let sessionID = selectedSessionID else { return }
        invalidateTitleGeneration(for: sessionID)
        mutateSelected { session in
            session.titleLocked = false
            if session.titleSource == .manual {
                let resolved = SessionTitle.resolved(
                    goal: session.goal,
                    clarifiedSummary: session.clarifiedSummary,
                    criteria: session.criteria,
                    plan: session.plan
                )
                session.title = resolved.title
                session.titleSource = resolved.source
            }
            session.updatedAt = Date()
        }
        persist()
    }

    private static func sessionTitle(for goal: String) -> String {
        SessionTitle.provisional(from: goal)
    }

    private func applyAutoTitle(to session: inout LoopSession, preferLLM: Bool) {
        guard SessionTitle.shouldAutoUpdate(source: session.titleSource, locked: session.titleLocked) else { return }
        let resolved = SessionTitle.resolved(
            goal: session.goal,
            clarifiedSummary: session.clarifiedSummary,
            criteria: session.criteria,
            plan: session.plan
        )
        session.title = resolved.title
        session.titleSource = resolved.source
        if preferLLM {
            // LLM path is async; structured/provisional title stays until a matching generation returns.
            scheduleLLMTitleIfEnabled(for: session.id)
        }
    }

    var autoTitleLLMEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.autoTitleLLMPreferenceKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.autoTitleLLMPreferenceKey) }
    }

    private func invalidateTitleGeneration(for sessionID: UUID) {
        titleTasks[sessionID]?.cancel()
        titleTasks[sessionID] = nil
        titleGenerations[sessionID, default: 0] &+= 1
    }

    private func scheduleLLMTitleIfEnabled(for sessionID: UUID) {
        guard autoTitleLLMEnabled else { return }
        // Built-in providers keep credentials in the runtime; only custom Keychain profiles can run a local title complete.
        guard providerProfile.allowsNativeConnectionTesting else { return }
        guard hasCredential(providerProfile) else { return }
        titleTasks[sessionID]?.cancel()
        titleGenerations[sessionID, default: 0] &+= 1
        let generation = titleGenerations[sessionID, default: 0]
        let task = Task { [weak self] in
            guard let self else { return }
            await self.generateLLMTitle(for: sessionID, generation: generation)
        }
        titleTasks[sessionID] = task
    }

    private func generateLLMTitle(for sessionID: UUID, generation: UInt64) async {
        guard !Task.isCancelled else { return }
        guard titleGenerations[sessionID] == generation else { return }
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        let session = sessions[index]
        guard SessionTitle.shouldAutoUpdate(source: session.titleSource, locked: session.titleLocked) else { return }
        guard providerProfile.allowsNativeConnectionTesting else { return }
        do {
            let client = ProviderClient(keychain: keychain, profileStore: providerStore)
            let request = LoopPrompts.sessionTitle(
                goal: session.goal,
                clarifiedSummary: session.clarifiedSummary,
                planTitles: session.plan.map(\.title),
                criterionTitles: session.criteria.map(\.title)
            )
            let reply = try await client.complete(request)
            guard !Task.isCancelled else { return }
            guard titleGenerations[sessionID] == generation else { return }
            let sanitize = makeTextSanitizer()
            guard let parsed = SessionTitle.parseLLMTitle(sanitize(reply.content)) else { return }
            applyLLMTitleResult(sessionID: sessionID, generation: generation, title: parsed)
        } catch is CancellationError {
            return
        } catch {
            // Fail soft for Gold/pause — do not clobber operational settingsMessage.
            return
        }
    }

    /// Testable application path for LLM titles (generation must still match).
    func applyLLMTitleResult(sessionID: UUID, generation: UInt64, title: String) {
        guard titleGenerations[sessionID] == generation else { return }
        mutateSession(sessionID) { current in
            guard SessionTitle.shouldAutoUpdate(source: current.titleSource, locked: current.titleLocked) else { return }
            current.title = title
            current.titleSource = .llm
            current.updatedAt = Date()
        }
        persist()
    }

    /// Exposes the current title generation for unit tests.
    func titleGeneration(for sessionID: UUID) -> UInt64 {
        titleGenerations[sessionID, default: 0]
    }

    func updateAnswer(questionID: String, value: String) {
        guard let sanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Answer editing is blocked because the credential catalog is unavailable. Existing history was not changed."
            return
        }
        let safeQuestionID = sanitizer.sanitize(questionID)
        let safeValue = sanitizer.sanitize(value)
        mutateSelected { session in
            session.answers[safeQuestionID] = safeValue
            session.updatedAt = Date()
        }
    }

    func startClarification() {
        guard !isRunning, let session = selectedSession else { return }
        guard runtimeLabel == "Shared LightningLoop runtime" else {
            mutateSession(session.id) {
                $0.stage = .paused
                $0.statusMessage = "Paused: clarification and completion require the shared LightningLoop harness. Native provider connection testing remains available in Settings."
                $0.updatedAt = Date()
            }
            persist()
            return
        }
        if let blocker = activeRuntimeModelSelectionBlocker {
            mutateSession(session.id) {
                $0.stage = .paused
                $0.statusMessage = "Paused: \(blocker)"
                $0.updatedAt = Date()
            }
            persist()
            return
        }
        guard let expectedModelSelection else {
            settingsMessage = "The exact runtime model snapshot is unavailable. Refresh the catalog before starting clarification."
            return
        }
        guard let inputSanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Clarification is blocked because the credential catalog is unavailable. Existing history was not changed."
            return
        }
        let safeSession = sanitizedSession(session, using: inputSanitizer.sanitize)
        mutateSession(session.id) { $0 = safeSession }
        let sessionID = session.id
        operation?.cancel()
        isRunning = true
        mutateSession(sessionID) {
            $0.stage = .clarifying
            $0.statusMessage = "Orchestrator is finding the decisions that matter…"
        }
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                guard let boundarySanitizer = self.currentCredentialSanitizer() else {
                    self.settingsMessage = "Clarification is blocked because the credential catalog is unavailable. Existing history was not changed."
                    self.isRunning = false
                    return
                }
                let boundarySession = self.sanitizedSession(safeSession, using: boundarySanitizer.sanitize)
                let result = try await self.engine.clarify(
                    goal: boundarySession.goal,
                    attachments: boundarySession.attachments,
                    expectedModelSelection: expectedModelSelection,
                    runID: sessionID
                )
                let sanitize = self.makeTextSanitizer()
                let safeSummary = sanitize(result.summary)
                let safeQuestions = result.questions.enumerated().map { index, question in
                    ClarifyingQuestion(
                        id: "Q\(index + 1)",
                        question: sanitize(question.question),
                        whyItMatters: sanitize(question.whyItMatters)
                    )
                }
                let safeTimeline = self.sanitizedTimeline(result.timeline, using: sanitize)
                self.mutateSession(sessionID) { current in
                    current.clarifiedSummary = safeSummary
                    current.questions = safeQuestions
                    current.answers = Dictionary(uniqueKeysWithValues: safeQuestions.map { ($0.id, current.answers[$0.id] ?? "") })
                    current.timeline.append(safeTimeline)
                    current.metrics = current.metrics + safeTimeline.metrics
                    current.stage = .awaitingAnswers
                    current.statusMessage = "Answer the questions, then start the strict loop."
                    self.applyAutoTitle(to: &current, preferLLM: true)
                    current.updatedAt = Date()
                }
                let notificationTitle = sanitize("LightningLoop needs input")
                let titled = self.sessions.first(where: { $0.id == sessionID })?.title
                    ?? Self.sessionTitle(for: boundarySession.goal)
                let notificationBody = sanitize("Clarifying questions are ready for \(titled).")
                await self.notificationSend(notificationTitle, notificationBody)
            } catch is CancellationError {
                self.markCancelled(sessionID)
            } catch {
                self.markFailed(error, sessionID: sessionID)
                let sanitize = self.makeTextSanitizer()
                let notificationTitle = sanitize("LightningLoop hit a blocker")
                let notificationBody = sanitize(error.localizedDescription)
                await self.notificationSend(notificationTitle, notificationBody)
            }
            self.isRunning = false
            self.persist()
        }
    }

    func startLoop() {
        guard !isRunning, allQuestionsAnswered, let session = selectedSession else { return }
        guard runtimeLabel == "Shared LightningLoop runtime" else {
            mutateSession(session.id) {
                $0.stage = .paused
                $0.statusMessage = "Paused: reaching Gold requires the shared LightningLoop harness. Native provider connection testing remains available in Settings."
                $0.updatedAt = Date()
            }
            persist()
            return
        }
        if let blocker = activeRuntimeModelSelectionBlocker {
            mutateSession(session.id) {
                $0.stage = .paused
                $0.statusMessage = "Paused: \(blocker)"
                $0.updatedAt = Date()
            }
            persist()
            return
        }
        guard let expectedModelSelection else {
            settingsMessage = "The exact runtime model snapshot is unavailable. Refresh the catalog before starting the loop."
            return
        }
        guard let inputSanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Loop execution is blocked because the credential catalog is unavailable. Existing history was not changed."
            return
        }
        let safeSession = sanitizedSession(session, using: inputSanitizer.sanitize)
        mutateSession(session.id) { $0 = safeSession }
        let sessionID = session.id
        operation?.cancel()
        isRunning = true
        let cycleLimit = configuredReviewCycles
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                guard let boundarySanitizer = self.currentCredentialSanitizer() else {
                    self.settingsMessage = "Loop execution is blocked because the credential catalog is unavailable. Existing history was not changed."
                    self.isRunning = false
                    return
                }
                let boundarySession = self.sanitizedSession(safeSession, using: boundarySanitizer.sanitize)
                let result = try await self.engine.execute(
                    goal: boundarySession.goal,
                    summary: boundarySession.clarifiedSummary,
                    questions: boundarySession.questions,
                    answers: boundarySession.answers,
                    maxReviewCycles: cycleLimit,
                    attachments: boundarySession.attachments,
                    researchProvider: self.configuredResearchProvider,
                    artifactWorkspace: boundarySession.artifactWorkspacePath,
                    approveArtifactWrites: boundarySession.artifactWorkspacePath != nil,
                    approveVerificationCommands: boundarySession.artifactWorkspacePath != nil && boundarySession.artifactVerificationCommands == true,
                    expectedModelSelection: expectedModelSelection,
                    runID: sessionID
                ) { [weak self] event in
                    await self?.apply(event, to: sessionID)
                }
                let sanitize = self.makeTextSanitizer()
                let safePlanning = self.sanitizedPlanning(result.planning, using: sanitize)
                let safeImplementation = self.sanitizedImplementation(result.implementation, using: sanitize)
                let safeArtifactReport = result.artifactReport.map { self.sanitizedArtifactReport($0, using: sanitize) }
                let safeFinalMessage = sanitize(result.finalMessage)
                self.mutateSession(sessionID) { current in
                    current.criteria = safePlanning.criteria
                    current.plan = safePlanning.plan
                    current.risks = safePlanning.risks
                    current.acceptanceTest = safePlanning.acceptanceTest
                    current.implementation = safeImplementation.deliverable
                    current.implementationNotes = safeImplementation.notes
                    current.artifactReport = safeArtifactReport
                    current.stage = result.completed ? .completed : .paused
                    current.statusMessage = safeFinalMessage
                    self.applyAutoTitle(to: &current, preferLLM: true)
                    current.updatedAt = Date()
                }
                let notificationTitle = sanitize(result.completed ? "LightningLoop reached Gold" : "LightningLoop paused")
                let titled = self.sessions.first(where: { $0.id == sessionID })?.title
                    ?? Self.sessionTitle(for: boundarySession.goal)
                let notificationBody = sanitize(result.completed ? titled : result.finalMessage)
                await self.notificationSend(notificationTitle, notificationBody)
            } catch is CancellationError {
                self.markCancelled(sessionID)
            } catch {
                self.markFailed(error, sessionID: sessionID)
                let sanitize = self.makeTextSanitizer()
                let notificationTitle = sanitize("LightningLoop hit a blocker")
                let notificationBody = sanitize(error.localizedDescription)
                await self.notificationSend(notificationTitle, notificationBody)
            }
            self.isRunning = false
            self.persist()
        }
    }

    func cancelCurrentOperation() {
        operation?.cancel()
        operation = nil
    }

    func saveCredential(_ value: String, for provider: CredentialProvider) {
        do {
            try keychain.saveCredential(value, for: provider)
            credentialStates[provider] = true
            let scrubbed = scrubHistoricalStateWithCurrentCredentials()
            settingsMessage = scrubbed
                ? "\(provider.label) credential saved in macOS Keychain. Historical state was rechecked and sanitized."
                : "\(provider.label) credential saved, but protected history could not be rewritten; it remains sanitized in the current view."
        } catch {
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    func saveCredential(_ value: String, for profile: ProviderConfiguration) {
        guard profile.allowsNativeConnectionTesting else {
            settingsMessage = "\(profile.displayName) is managed by the LightningLoop runtime. Start the shared runtime and use its official provider sign-in."
            return
        }
        do {
            let inserted = try credentialRegistry.register(profile: profile)
            do {
                try keychain.saveCredential(value, for: profile)
            } catch {
                if inserted {
                    do {
                        try credentialRegistry.rollBackRegistration(profile: profile)
                    } catch {
                        settingsMessage = "The Keychain save failed and LightningLoop could not roll back its service-identifier registry. No credential value was written to the registry."
                        return
                    }
                }
                throw error
            }
            if profile.credentialService == providerProfile.credentialService { activeInferenceCredentialConfigured = true }
            let scrubbed = scrubHistoricalStateWithCurrentCredentials()
            settingsMessage = scrubbed
                ? "\(profile.displayName) credential saved in macOS Keychain. Historical state was rechecked and sanitized."
                : "\(profile.displayName) credential saved, but protected history could not be rewritten; it remains sanitized in the current view."
        } catch {
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    func removeCredential(for provider: CredentialProvider) {
        do {
            guard let sanitizer = currentCredentialSanitizer(), scrubHistoricalState(using: sanitizer) else {
                settingsMessage = "Credential removal was blocked because protected history could not be sanitized first. Nothing was deleted from Keychain."
                return
            }
            try keychain.deleteCredential(for: provider)
            credentialStates[provider] = false
            settingsMessage = "\(provider.label) credential removed from macOS Keychain."
            if CredentialProvider.inferenceCases.contains(provider) { connectionMetrics = nil }
        } catch {
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    func removeCredential(for profile: ProviderConfiguration) {
        guard profile.allowsNativeConnectionTesting else {
            settingsMessage = "\(profile.displayName) is managed by the LightningLoop runtime; LightningLoop has no direct credential to remove."
            return
        }
        do {
            guard let sanitizer = currentCredentialSanitizer(), scrubHistoricalState(using: sanitizer) else {
                settingsMessage = "Credential removal was blocked because protected history could not be sanitized first. Nothing was deleted from Keychain."
                return
            }
            try keychain.deleteCredential(for: profile)
            if profile.credentialService == providerProfile.credentialService { activeInferenceCredentialConfigured = false }
            connectionMetrics = nil
            settingsMessage = "\(profile.displayName) credential removed from macOS Keychain."
        } catch {
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    func testConnection() async {
        guard providerProfile.allowsNativeConnectionTesting else {
            await refreshRuntimeModelCatalog()
            return
        }
        settingsMessage = "Discovering \(providerProfile.displayName) models and testing \(providerProfile.modelName)…"
        do {
            let client = ProviderClient(keychain: keychain, profileStore: providerStore)
            let ids = try await client.listModels()
            availableModels = ids
            discoveredCustomModels = ids.map {
                ProviderModelOption(
                    modelID: $0,
                    modelName: $0,
                    supportsImages: providerProfile.supportsImages,
                    contextWindow: providerProfile.contextWindow,
                    maxOutputTokens: providerProfile.maxOutputTokens
                )
            }
            guard availableModels.contains(providerProfile.modelID) else {
                throw ProviderClientError.server(
                    provider: providerProfile.displayName,
                    status: 0,
                    message: "Model \(providerProfile.modelID) was not returned by /models. Pick a discovered model, then retest."
                )
            }
            let reply = try await client.complete(LoopPrompts.connectionProbe())
            connectionMetrics = reply.metrics
            settingsMessage = "Connected to \(reply.model). Discovered \(availableModels.count) model\(availableModels.count == 1 ? "" : "s") from the provider /models list (account-visible IDs, not a marketing catalog)."
        } catch {
            connectionMetrics = nil
            availableModels = []
            discoveredCustomModels = []
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    /// Apply a discovered custom model ID into a draft profile (display name defaults to the ID).
    func applyDiscoveredCustomModel(_ modelID: String, to profile: inout ProviderConfiguration) {
        guard availableModels.contains(modelID) else { return }
        if let option = discoveredCustomModels.first(where: { $0.modelID == modelID }) {
            profile = profile.applyingRuntimeModel(option)
        } else {
            profile.modelID = modelID
            profile.modelName = modelID
        }
    }

    func refreshRuntimeModelCatalog() async {
        guard providerProfile.usesPiAuthentication else {
            settingsMessage = "Custom model discovery is available only through the user-triggered connection test."
            return
        }
        guard let harness = engine as? HarnessProcessClient else {
            settingsMessage = "Model selection requires the shared LightningLoop runtime. Start it, complete provider sign-in, and then refresh its model catalog."
            return
        }
        let requestedProviderID = providerProfile.id
        let requestedModelID = providerProfile.modelID
        settingsMessage = "Refreshing the LightningLoop runtime model catalog for \(providerProfile.displayName)…"
        do {
            let catalog = try await harness.runtimeModelCatalog()
            applyRuntimeModelCatalog(catalog, requestedProviderID: requestedProviderID, requestedModelID: requestedModelID)
        } catch {
            runtimeModels = []
            runtimeModelCatalogProviderID = nil
            runtimeModelCatalogScope = ""
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    func applyRuntimeModelCatalog(
        _ catalog: HarnessRuntimeModelCatalog,
        requestedProviderID: String,
        requestedModelID: String
    ) {
        guard catalog.providerID == requestedProviderID,
              catalog.selectedModelID == requestedModelID,
              providerProfile.id == requestedProviderID,
              providerProfile.modelID == requestedModelID else {
            runtimeModels = []
            runtimeModelCatalogProviderID = nil
            runtimeModelCatalogScope = ""
            settingsMessage = "The provider or model changed while its runtime catalog was loading. Refresh the current selection again."
            return
        }
        let selectedModelCatalogued = catalog.models.contains { $0.modelID == requestedModelID }
        guard catalog.selectedModelCatalogued == selectedModelCatalogued else {
            runtimeModels = []
            runtimeModelCatalogProviderID = nil
            runtimeModelCatalogScope = ""
            settingsMessage = "The LightningLoop runtime returned inconsistent model-selection metadata. Refresh before running a loop."
            return
        }
        runtimeModels = catalog.models
        runtimeModelCatalogProviderID = catalog.providerID
        runtimeModelCatalogScope = catalog.catalogScope
        if selectedModelCatalogued {
            settingsMessage = "Runtime catalog refreshed: \(providerProfile.modelName) is catalogued by the installed LightningLoop runtime."
        } else if let notice = catalog.selectionNotice {
            settingsMessage = "\(notice) Choose a model listed by the LightningLoop runtime before running a loop."
        } else {
            settingsMessage = "\(providerProfile.modelName) is not catalogued by the installed LightningLoop runtime. Choose a listed model before running a loop."
        }
    }

    func canSaveProviderConfiguration(_ profile: ProviderConfiguration) -> Bool {
        // Custom profiles do not use the runtime catalog save gate.
        guard profile.usesPiAuthentication else { return true }
        // When a catalog is bound for this provider, only catalogued model IDs may be saved.
        if runtimeModelCatalogProviderID == profile.id {
            return runtimeModels.contains { $0.modelID == profile.modelID }
        }
        // Catalog not yet bound: allow selecting a built-in preset so onboarding can proceed.
        // Execution remains fail-closed via activeRuntimeModelSelectionBlocker until refresh succeeds.
        return profile.preset != .selectionRequired
    }

    func runtimeModelSelectionMessage(for profile: ProviderConfiguration) -> String? {
        guard profile.usesPiAuthentication else { return nil }
        guard runtimeModelCatalogProviderID == profile.id else {
            return profile.runtimeModelSelectionNotice
                ?? "Refresh the installed LightningLoop runtime catalog before saving. Catalogued is not sign-in or entitlement."
        }
        if let model = runtimeModels.first(where: { $0.modelID == profile.modelID }) {
            return "\(model.modelName) is catalogued by the installed LightningLoop runtime. Catalogued is not account entitlement."
        }
        return profile.runtimeModelSelectionNotice
            ?? "\(profile.modelName) is not catalogued by the installed LightningLoop runtime. Choose a listed model."
    }

    func selectProviderPreset(_ preset: ProviderPreset) {
        let candidate = ProviderConfiguration.preset(preset)
        saveProviderConfiguration(candidate)
    }

    func manageHarness(_ action: String, approveReset: Bool = false, approveRestore: Bool = false) {
        settingsMessage = "Running managed harness \(action)…"
        Task { [weak self] in
            guard let self else { return }
            guard let harness = HarnessProcessClient.discover() else {
                settingsMessage = HarnessProcessError.unavailable.localizedDescription
                return
            }
            do {
                var arguments = [action]
                if approveReset { arguments.append("--approve-reset") }
                if approveRestore { arguments.append("--approve-restore") }
                settingsMessage = self.sanitizeSensitiveText(try await harness.runManagedHarnessCommand(arguments))
            } catch {
                settingsMessage = self.sanitizeSensitiveText(error.localizedDescription)
            }
        }
    }

    func saveProviderConfiguration(_ profile: ProviderConfiguration) {
        guard canSaveProviderConfiguration(profile) else {
            settingsMessage = runtimeModelSelectionMessage(for: profile)
                ?? "Choose a model listed by the LightningLoop runtime before saving this provider."
            return
        }
        do {
            try providerStore.save(profile)
            providerProfile = providerStore.load()
            availableModels = []
            discoveredCustomModels = []
            runtimeModels = []
            runtimeModelCatalogProviderID = nil
            runtimeModelCatalogScope = ""
            connectionMetrics = nil
            let scrubbed = scrubHistoricalStateWithCurrentCredentials()
            let savedMessage = scrubbed
                ? "Active provider saved: \(providerProfile.displayName) · \(providerProfile.modelID). Historical state was rechecked."
                : "Active provider saved, but protected history could not be rewritten; it remains hidden or sanitized."
            settingsMessage = providerProfile.runtimeModelSelectionNotice.map { "\(savedMessage) \($0)" } ?? savedMessage
            refreshCredentialState()
            if providerProfile.usesPiAuthentication {
                Task { await refreshRuntimeModelCatalog() }
            }
        } catch {
            settingsMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    func chooseImages() {
        guard let session = selectedSession else { return }
        let panel = NSOpenPanel()
        panel.title = "Attach source images"
        panel.prompt = "Attach"
        panel.allowedContentTypes = [.png, .jpeg, .webP, .gif]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        var currentCount = session.attachments.count
        for url in panel.urls {
            do {
                let attachment = try attachmentStore.importImage(from: url, sessionID: session.id, existingCount: currentCount)
                mutateSession(session.id) { $0.attachments.append(attachment); $0.updatedAt = Date() }
                currentCount += 1
            } catch {
                settingsMessage = sanitizeSensitiveText(error.localizedDescription)
                break
            }
        }
        persist()
    }

    func removeAttachment(_ id: UUID) {
        guard let session = selectedSession,
              let attachment = session.attachments.first(where: { $0.id == id }) else { return }
        attachmentStore.remove(attachment)
        mutateSession(session.id) { $0.attachments.removeAll { $0.id == id }; $0.updatedAt = Date() }
        persist()
    }

    func chooseArtifactWorkspace() {
        guard supportsWorkspaceArtifacts, let session = selectedSession else {
            settingsMessage = "Workspace artifacts require the shared LightningLoop harness."
            return
        }
        let panel = NSOpenPanel()
        panel.title = "Choose an empty artifact output directory"
        panel.message = "LightningLoop will create and revise only run-owned files here. Existing content is never overwritten."
        panel.prompt = "Use Empty Directory"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let selected = url.standardizedFileURL.resolvingSymlinksInPath()
        guard selected.path != "/", selected.path != FileManager.default.homeDirectoryForCurrentUser.path else {
            settingsMessage = "Choose a dedicated empty directory, not the filesystem root or your home directory."
            return
        }
        do {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                settingsMessage = "Artifact output must be a real directory, not a link."
                return
            }
            let entries = try FileManager.default.contentsOfDirectory(atPath: selected.path)
            guard entries.isEmpty else {
                settingsMessage = "Artifact output must be empty so LightningLoop cannot overwrite existing work."
                return
            }
            mutateSession(session.id) {
                $0.artifactWorkspacePath = selected.path
                $0.artifactVerificationCommands = false
                $0.artifactReport = nil
                $0.updatedAt = Date()
            }
            settingsMessage = "Artifact output selected. Script execution and static picture capture remain off."
            persist()
        } catch {
            settingsMessage = "Artifact output was not selected: \(sanitizeSensitiveText(error.localizedDescription))"
        }
    }

    func setArtifactVerificationCommands(_ enabled: Bool) {
        guard supportsWorkspaceArtifacts, let session = selectedSession, session.artifactWorkspacePath != nil else { return }
        if enabled {
            let alert = NSAlert()
            alert.messageText = "Enable the confined Evidence Lab?"
            alert.informativeText = "LightningLoop may execute generated code through structured allowlisted commands, select bounded default checks, serve HTML briefly on 127.0.0.1, and render local screenshot evidence. External network, home-directory reads, ambient credentials, and outside writes are denied, with hard time, output, file, and byte limits. The macOS sandbox is not a virtual machine."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Enable Evidence Lab")
            alert.addButton(withTitle: "Keep Execution Off")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        mutateSession(session.id) {
            $0.artifactVerificationCommands = enabled
            $0.updatedAt = Date()
        }
        persist()
    }

    func clearArtifactWorkspace() {
        guard let session = selectedSession else { return }
        mutateSession(session.id) {
            $0.artifactWorkspacePath = nil
            $0.artifactVerificationCommands = nil
            $0.artifactReport = nil
            $0.updatedAt = Date()
        }
        persist()
    }

    func revealArtifactWorkspace() {
        guard let path = selectedSession?.artifactWorkspacePath else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path, isDirectory: true)])
    }

    func openArtifactInDefaultApp(relativePath: String, expectedSHA256: String) {
        guard selectedSession?.artifactWorkspacePath != nil else {
            settingsMessage = "Artifact workspace is unavailable."
            return
        }
        guard let reviewed = reviewedArtifactBytes(relativePath: relativePath, maximumBytes: 128 * 1_048_576),
              !reviewed.data.isEmpty,
              SHA256.hash(data: reviewed.data).map({ String(format: "%02x", $0) }).joined() == expectedSHA256 else {
            settingsMessage = "Artifact bytes no longer match the reviewed evidence; opening was blocked."
            return
        }

        if reviewed.url.pathExtension.lowercased() != "html" {
            let extensionValue = reviewed.url.pathExtension.lowercased()
            let safeExtension = extensionValue.range(of: "^[a-z0-9]{1,16}$", options: .regularExpression) == nil ? "artifact" : extensionValue
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("LightningLoop-Reviewed-Artifacts", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            let snapshot = directory.appendingPathComponent("reviewed.\(safeExtension)")
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try reviewed.data.write(to: snapshot, options: [.atomic])
                try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: snapshot.path)
                guard let attributes = try? FileManager.default.attributesOfItem(atPath: snapshot.path),
                      let permissions = attributes[.posixPermissions] as? NSNumber,
                      permissions.intValue & 0o222 == 0,
                      let snapshotData = try? Data(contentsOf: snapshot),
                      snapshotData == reviewed.data,
                      SHA256.hash(data: snapshotData).map({ String(format: "%02x", $0) }).joined() == expectedSHA256 else {
                    throw HarnessProcessError.launchFailed("the immutable handoff snapshot failed verification")
                }
            } catch {
                settingsMessage = sanitizeSensitiveText(error.localizedDescription)
                return
            }
            artifactOpenSnapshots.append(directory)
            while artifactOpenSnapshots.count > 10 {
                let retired = artifactOpenSnapshots.removeFirst()
                try? FileManager.default.removeItem(at: retired)
            }
            guard artifactOpenURL(snapshot) else {
                settingsMessage = "No default application accepted this artifact."
                return
            }
            settingsMessage = "Opened \(relativePath) from an immutable reviewed snapshot in its default application."
            return
        }

        artifactBrowserSession?.close()
        artifactBrowserSession = nil
        Task { @MainActor in
            do {
                guard let harness = HarnessProcessClient.discover() else { throw HarnessProcessError.unavailable }
                let files = selectedSession?.artifactReport?.files ?? []
                let session = try await harness.startArtifactBrowser(workspace: reviewed.root, sourcePath: relativePath, sha256: expectedSHA256, files: files)
                guard artifactOpenURL(session.url) else {
                    session.close()
                    throw HarnessProcessError.launchFailed("the default browser rejected the artifact URL")
                }
                artifactBrowserSession = session
                settingsMessage = "Opened reviewed HTML in the default browser. The private loopback link expires automatically."
            } catch {
                settingsMessage = sanitizeSensitiveText(error.localizedDescription)
            }
        }
    }

    private func reviewedArtifactBytes(relativePath: String, maximumBytes: Int) -> (root: URL, url: URL, data: Data)? {
        guard let workspacePath = selectedSession?.artifactWorkspacePath,
              !relativePath.isEmpty, relativePath.count <= 240, !relativePath.hasPrefix("/"),
              !relativePath.split(separator: "/").contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        let root = URL(fileURLWithPath: workspacePath, isDirectory: true).standardizedFileURL
        guard let rootValues = try? root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
              rootValues.isDirectory == true, rootValues.isSymbolicLink != true else { return nil }
        var candidate = root
        for component in relativePath.split(separator: "/") {
            candidate.appendPathComponent(String(component))
            guard let values = try? candidate.resourceValues(forKeys: [.isSymbolicLinkKey]), values.isSymbolicLink != true else { return nil }
        }
        candidate = candidate.standardizedFileURL
        guard candidate.path.hasPrefix(root.path + "/"),
              let values = try? candidate.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, let size = values.fileSize, size > 0, size <= maximumBytes,
              let data = try? Data(contentsOf: candidate, options: [.mappedIfSafe]), data.count == size else { return nil }
        return (root, candidate, data)
    }

    func addMemory(statement: String, source: String, tags: String, scope: MemoryScope) {
        guard let credentialSanitizer = refreshMemoryForMutation() else { return }
        let cleanStatement = statement.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanSource = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanStatement.isEmpty,
              !containsSecretShape(cleanStatement),
              !containsSecretShape(cleanSource),
              !credentialSanitizer.containsCredential(in: [cleanStatement, cleanSource, tags]) else {
            settingsMessage = "Memory rejected: empty or secret-like content is prohibited."
            return
        }
        let parsedTags = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let record = MemoryRecord(
            scope: scope,
            statement: String(cleanStatement.prefix(10_000)),
            tags: parsedTags,
            sourceArtifact: cleanSource.isEmpty ? "User-provided note" : String(cleanSource.prefix(200)),
            sourceRunID: scope == .run ? selectedSessionID : nil,
            promotionApprovedByUser: scope == .run
        )
        memories.insert(record, at: 0)
        if !memoryArchive.save(memories) {
            memories.removeAll { $0.id == record.id }
            settingsMessage = "Memory was not added because protected local storage failed."
        }
    }

    func approveMemoryPromotion(_ id: UUID) {
        guard refreshMemoryForMutation() != nil else { return }
        guard let index = memories.firstIndex(where: { $0.id == id }), memories[index].scope != .run else { return }
        let prior = memories[index]
        memories[index].promotionApprovedByUser = true
        memories[index].reviewedAt = Date()
        if !memoryArchive.save(memories) {
            memories[index] = prior
            settingsMessage = "Memory promotion was not saved and remains inactive."
        }
    }

    func deleteMemory(_ id: UUID) {
        guard refreshMemoryForMutation() != nil else { return }
        let prior = memories
        memories.removeAll { $0.id == id }
        if !memoryArchive.save(memories) {
            memories = prior
            settingsMessage = "Memory deletion was not saved. No entry was removed."
        }
    }

    func addEvolution(kind: EvolutionKind, name: String, source: String, reason: String, exactDiff: String) {
        guard let credentialSanitizer = refreshEvolutionsForMutation() else { return }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDiff = exactDiff.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty,
              !cleanDiff.isEmpty,
              !containsSecretShape(cleanDiff),
              !credentialSanitizer.containsCredential(in: [cleanName, source, reason, cleanDiff]) else {
            settingsMessage = "Evolution rejected: a name, non-secret diff, and source are required."
            return
        }
        let proposal = EvolutionProposal(
            kind: kind,
            name: cleanName,
            source: source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "User-provided" : source,
            reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
            exactDiff: cleanDiff
        )
        evolutions.insert(proposal, at: 0)
        if !evolutionArchive.save(evolutions) {
            evolutions.removeAll { $0.id == proposal.id }
            settingsMessage = "Evolution was not proposed because protected local storage failed."
        }
    }

    func deleteEvolutionDraft(_ id: UUID) {
        guard refreshEvolutionsForMutation() != nil else { return }
        let prior = evolutions
        evolutions.removeAll { $0.id == id && $0.state == .draft }
        if !evolutionArchive.save(evolutions) {
            evolutions = prior
            settingsMessage = "Evolution deletion was not saved. No draft was removed."
        }
    }

    func updateEvolutionEvidence(
        _ id: UUID,
        evaluationSuite: String,
        evaluationSummary: String,
        rollbackTarget: String,
        permissions: String,
        reviewerHasMaterialFinding: Bool
    ) {
        guard let credentialSanitizer = refreshEvolutionsForMutation() else { return }
        guard let index = evolutions.firstIndex(where: { $0.id == id }), evolutions[index].state != .active else { return }
        let prior = evolutions[index]
        evolutions[index].evaluationSuite = String(evaluationSuite.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2_000))
        let summary = evaluationSummary.trimmingCharacters(in: .whitespacesAndNewlines)
        evolutions[index].evaluationSummary = summary.isEmpty ? nil : String(summary.prefix(4_000))
        let rollback = rollbackTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        evolutions[index].rollbackTarget = rollback.isEmpty ? nil : String(rollback.prefix(1_000))
        evolutions[index].permissions = permissions.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { String($0.prefix(120)) }
        evolutions[index].reviewerHasMaterialFinding = reviewerHasMaterialFinding
        guard !containsSecretShape(evolutions[index].evaluationSummary ?? ""),
              !containsSecretShape(evolutions[index].rollbackTarget ?? ""),
              !credentialSanitizer.containsCredential(in: [
                evolutions[index].evaluationSuite,
                evolutions[index].evaluationSummary ?? "",
                evolutions[index].rollbackTarget ?? "",
                evolutions[index].permissions.joined(separator: ",")
              ]) else {
            evolutions[index] = prior
            settingsMessage = "Evolution evidence rejected because secret-like content is prohibited."
            return
        }
        if !evolutionArchive.save(evolutions) {
            evolutions[index] = prior
            settingsMessage = "Evolution evidence was not saved."
        } else {
            settingsMessage = "Evolution evidence saved locally."
        }
    }

    func advanceEvolution(_ id: UUID) {
        guard refreshEvolutionsForMutation() != nil else { return }
        guard let index = evolutions.firstIndex(where: { $0.id == id }), let next = evolutions[index].state.next else { return }
        let proposal = evolutions[index]
        switch next {
        case .sandboxTested where !proposal.canRecordSandboxPass:
            settingsMessage = "Record a named evaluation suite and passing summary before marking sandbox-tested."
            return
        case .adversariallyReviewed where !proposal.canRecordAdversarialReview:
            settingsMessage = "Resolve every material reviewer finding before adversarial review can pass."
            return
        case .userApproved where proposal.reviewerHasMaterialFinding:
            settingsMessage = "User approval is blocked while a material finding remains."
            return
        case .active where !proposal.canActivate:
            settingsMessage = "Activation requires user approval, evaluation evidence, a rollback target, and no material finding."
            return
        default:
            break
        }
        let prior = evolutions
        evolutions[index].state = next
        if next == .active { evolutions[index].activatedAt = Date() }
        if !evolutionArchive.save(evolutions) {
            evolutions = prior
            settingsMessage = "Evolution transition was not saved; its prior state was restored."
        } else {
            settingsMessage = next == .active
                ? "Evolution activated. Reviewed system-prompt changes apply on the next agent call; tools and MCPs remain separately permission-gated."
                : "Evolution moved to \(next.label)."
        }
    }

    func rollBackEvolution(_ id: UUID) {
        guard refreshEvolutionsForMutation() != nil else { return }
        guard let index = evolutions.firstIndex(where: { $0.id == id }), evolutions[index].state != .rolledBack else { return }
        let prior = evolutions
        evolutions[index].state = .rolledBack
        if !evolutionArchive.save(evolutions) {
            evolutions = prior
            settingsMessage = "Rollback was not saved; the prior state was restored."
        } else {
            settingsMessage = "Evolution rolled back. It is no longer eligible for active use."
        }
    }

    func copyImplementation() {
        guard let implementation = selectedSession?.implementation, !implementation.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(implementation, forType: .string)
    }

    func exportImplementation() {
        guard let session = selectedSession, !session.implementation.isEmpty else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "\(sanitizedFilename(session.title)).md"
        panel.title = "Export Gold Deliverable"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? session.implementation.write(to: url, atomically: true, encoding: .utf8)
    }

    var configuredReviewCycles: Int {
        let stored = UserDefaults.standard.integer(forKey: "maxReviewCycles")
        return stored == 0 ? 4 : min(max(stored, 1), 8)
    }

    var configuredResearchProvider: String? {
        guard supportsAutomaticResearch, UserDefaults.standard.bool(forKey: "researchEnabled") else { return nil }
        let value = UserDefaults.standard.string(forKey: "researchProvider") ?? "brave"
        return ["exa", "brave", "firecrawl"].contains(value) ? value : "brave"
    }

    private func apply(_ event: LoopEngineEvent, to sessionID: UUID) {
        let sanitize = makeTextSanitizer()
        mutateSession(sessionID) { session in
            switch event {
            case .phase(let stage, let message):
                session.stage = stage
                session.statusMessage = sanitize(message)
            case .timeline(let entry):
                session.timeline.append(sanitizedTimeline(entry, using: sanitize))
                session.metrics = session.metrics + entry.metrics
            case .planning(let draft):
                let safe = sanitizedPlanning(draft, using: sanitize)
                session.criteria = safe.criteria
                session.plan = safe.plan
                session.risks = safe.risks
                session.acceptanceTest = safe.acceptanceTest
                applyAutoTitle(to: &session, preferLLM: true)
            case .review(let record):
                session.reviews.append(sanitizedReview(record, using: sanitize))
            case .implementation(let draft):
                let safe = sanitizedImplementation(draft, using: sanitize)
                session.implementation = safe.deliverable
                session.implementationNotes = safe.notes
            }
            session.updatedAt = Date()
        }
        persist()
    }

    private func mutateSelected(_ update: (inout LoopSession) -> Void) {
        guard let id = selectedSessionID, let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        update(&sessions[index])
    }

    private func mutateSession(_ id: UUID, _ update: (inout LoopSession) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        update(&sessions[index])
    }

    private func markCancelled(_ sessionID: UUID) {
        mutateSession(sessionID) {
            $0.stage = .paused
            $0.statusMessage = "Loop cancelled. All completed work is preserved."
        }
    }

    private func markFailed(_ error: Error, sessionID: UUID) {
        mutateSession(sessionID) {
            $0.stage = .failed
            $0.statusMessage = sanitizeSensitiveText(error.localizedDescription)
        }
    }

    private func persist() {
        guard let sanitizer = currentCredentialSanitizer() else {
            sessions = sessions.map { sanitizedSession($0, using: CredentialTextSanitizer.failClosed) }
            return
        }
        let sanitize = sanitizer.sanitize
        sessions = sessions.map { sanitizedSession($0, using: sanitize) }
        archive.save(sessions)
    }

    private func scrubHistoricalStateWithCurrentCredentials() -> Bool {
        guard let sanitizer = currentCredentialSanitizer() else {
            sessions = sessions.map { sanitizedSession($0, using: CredentialTextSanitizer.failClosed) }
            memories = []
            evolutions = []
            return false
        }
        return scrubHistoricalState(using: sanitizer)
    }

    private func scrubHistoricalState(using sanitizer: CredentialTextSanitizer) -> Bool {
        let cleanVisibleSessions = sessions.map { sanitizedSession($0, using: sanitizer.sanitize) }
        let cleanVisibleMemories = memories.map { sanitizedMemory($0, using: sanitizer.sanitize) }
        let cleanVisibleEvolutions = evolutions.map { sanitizedEvolution($0, using: sanitizer.sanitize) }
        sessions = cleanVisibleSessions
        memories = cleanVisibleMemories
        evolutions = cleanVisibleEvolutions

        guard let storedMemories = memoryArchive.loadForMutation(),
              let storedEvolutions = evolutionArchive.loadForMutation() else { return false }
        let cleanMemories = storedMemories.map { sanitizedMemory($0, using: sanitizer.sanitize) }
        let cleanEvolutions = storedEvolutions.map { sanitizedEvolution($0, using: sanitizer.sanitize) }
        guard archive.save(cleanVisibleSessions),
              memoryArchive.save(cleanMemories),
              evolutionArchive.save(cleanEvolutions) else { return false }
        memories = cleanMemories
        evolutions = cleanEvolutions
        return true
    }

    func refreshManagedLedgers() {
        guard let sanitizer = currentCredentialSanitizer() else {
            memories = []
            evolutions = []
            settingsMessage = "Credential catalog is malformed or unsafe. Persisted history was preserved and hidden until the catalog is repaired."
            return
        }
        if let current = memoryArchive.loadForMutation() { memories = current.map { sanitizedMemory($0, using: sanitizer.sanitize) } }
        if let current = evolutionArchive.loadForMutation() { evolutions = current.map { sanitizedEvolution($0, using: sanitizer.sanitize) } }
    }

    private func refreshMemoryForMutation() -> CredentialTextSanitizer? {
        guard let sanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Credential enumeration or reading failed. Memory was not changed in memory or on disk."
            return nil
        }
        guard let current = memoryArchive.loadForMutation() else {
            settingsMessage = "Memory storage is malformed or unsafe. Nothing was overwritten; restore or repair the protected ledger first."
            return nil
        }
        memories = current.map { sanitizedMemory($0, using: sanitizer.sanitize) }
        return sanitizer
    }

    private func refreshEvolutionsForMutation() -> CredentialTextSanitizer? {
        guard let sanitizer = currentCredentialSanitizer() else {
            settingsMessage = "Credential enumeration or reading failed. Evolution history was not changed in memory or on disk."
            return nil
        }
        guard let current = evolutionArchive.loadForMutation() else {
            settingsMessage = "Evolution storage is malformed or unsafe. Nothing was overwritten; restore or repair the protected ledger first."
            return nil
        }
        evolutions = current.map { sanitizedEvolution($0, using: sanitizer.sanitize) }
        return sanitizer
    }

    private func refreshCredentialState() {
        let keychain = self.keychain
        let activeProfile = providerProfile
        Task { [weak self] in
            let result = await Task.detached { () -> ([CredentialProvider: Bool], Bool) in
                let states = Dictionary(uniqueKeysWithValues: CredentialProvider.allCases.map { provider in
                    let present = (try? keychain.hasCredential(for: provider)) == true
                    return (provider, present)
                })
                let active = (try? keychain.hasCredential(for: activeProfile)) == true
                return (states, active)
            }.value
            self?.credentialStates = result.0
            self?.activeInferenceCredentialConfigured = result.1
        }
    }

    private func sanitizedFilename(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let mapped = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "-" }
        let compact = String(mapped).replacingOccurrences(of: "--", with: "-")
        return compact.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private func containsSecretShape(_ value: String) -> Bool {
        let patterns = [
            #"\bcsk-[A-Za-z0-9_-]{12,}\b"#,
            #"\bfc-[A-Za-z0-9_-]{12,}\b"#,
            #"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"#,
            #"(?i)\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}"#
        ]
        return patterns.contains { value.range(of: $0, options: .regularExpression) != nil }
    }

    private func containsConfiguredCredential(_ values: [String]) -> Bool {
        guard let sanitizer = currentCredentialSanitizer() else { return true }
        return sanitizer.containsCredential(in: values)
    }

    private func sanitizeSensitiveText(_ value: String) -> String {
        makeTextSanitizer()(value)
    }

    private func makeTextSanitizer() -> (String) -> String {
        guard let sanitizer = currentCredentialSanitizer() else { return CredentialTextSanitizer.failClosed }
        return sanitizer.sanitize
    }

    private func currentCredentialSanitizer() -> CredentialTextSanitizer? {
        try? CredentialTextSanitizer(
            activeProfile: providerProfile,
            registry: credentialRegistry,
            credentialReader: credentialReader
        )
    }

    private func sanitizedPlanning(_ draft: PlanningDraft, using sanitize: (String) -> String) -> PlanningDraft {
        PlanningDraft(
            criteria: draft.criteria.map {
                Criterion(id: sanitize($0.id), title: sanitize($0.title), detail: sanitize($0.detail), evidence: sanitize($0.evidence))
            },
            plan: draft.plan.map {
                PlanStep(id: sanitize($0.id), title: sanitize($0.title), detail: sanitize($0.detail), proof: sanitize($0.proof))
            },
            risks: draft.risks.map(sanitize),
            acceptanceTest: sanitize(draft.acceptanceTest)
        )
    }

    private func sanitizedImplementation(_ draft: ImplementationDraft, using sanitize: (String) -> String) -> ImplementationDraft {
        ImplementationDraft(
            deliverable: sanitize(draft.deliverable),
            notes: draft.notes.map(sanitize),
            files: draft.files?.map { ArtifactFileDraft(path: sanitize($0.path), content: sanitize($0.content)) },
            verificationCommands: draft.verificationCommands?.map {
                VerificationCommandDraft(
                    executable: sanitize($0.executable),
                    arguments: $0.arguments.map(sanitize),
                    purpose: sanitize($0.purpose)
                )
            }
        )
    }

    private func sanitizedTimeline(_ entry: TimelineEntry, using sanitize: (String) -> String) -> TimelineEntry {
        TimelineEntry(
            id: entry.id,
            date: entry.date,
            role: entry.role,
            title: sanitize(entry.title),
            summary: sanitize(entry.summary),
            metrics: entry.metrics
        )
    }

    private func sanitizedReview(_ review: ReviewRecord, using sanitize: (String) -> String) -> ReviewRecord {
        ReviewRecord(
            id: review.id,
            target: sanitize(review.target),
            round: review.round,
            score: review.score,
            passed: review.passed,
            summary: sanitize(review.summary),
            findings: review.findings.map {
                ReviewFinding(
                    id: $0.id,
                    severity: sanitize($0.severity),
                    criterionID: $0.criterionID.map(sanitize),
                    issue: sanitize($0.issue),
                    requiredChange: sanitize($0.requiredChange)
                )
            },
            requiredChanges: review.requiredChanges.map(sanitize),
            criterionAssessments: review.criterionAssessments?.map {
                CriterionAssessment(
                    criterionID: sanitize($0.criterionID),
                    status: sanitize($0.status),
                    evidence: sanitize($0.evidence),
                    evidenceRefs: $0.evidenceRefs?.map(sanitize)
                )
            }
        )
    }

    private func sanitizedArtifactReport(_ report: ArtifactExecutionReport, using sanitize: (String) -> String) -> ArtifactExecutionReport {
        ArtifactExecutionReport(
            enabled: report.enabled,
            passed: report.passed,
            summary: sanitize(report.summary),
            files: report.files.map { ArtifactFileEvidence(path: sanitize($0.path), bytes: $0.bytes, sha256: sanitize($0.sha256)) },
            commands: report.commands.map {
                VerificationCommandEvidence(
                    executable: sanitize($0.executable), arguments: $0.arguments.map(sanitize), purpose: sanitize($0.purpose),
                    exitCode: $0.exitCode, output: sanitize($0.output), passed: $0.passed,
                    origin: $0.origin.map(sanitize), durationMs: $0.durationMs
                )
            },
            previews: report.previews?.map {
                ArtifactPreviewEvidence(
                    kind: sanitize($0.kind), title: sanitize($0.title), sourcePath: sanitize($0.sourcePath),
                    previewPath: sanitize($0.previewPath), mimeType: sanitize($0.mimeType), passed: $0.passed,
                    message: sanitize($0.message), width: $0.width, height: $0.height,
                    loopback: $0.loopback.map {
                        ArtifactLoopbackEvidence(
                            scheme: sanitize($0.scheme), host: sanitize($0.host), status: $0.status,
                            contentType: sanitize($0.contentType), bytes: $0.bytes, sha256: sanitize($0.sha256)
                        )
                    }
                )
            },
            workspaceAudit: ArtifactWorkspaceAudit(
                passed: report.workspaceAudit.passed, files: report.workspaceAudit.files, bytes: report.workspaceAudit.bytes,
                message: sanitize(report.workspaceAudit.message)
            )
        )
    }

    private func sanitizedMemory(_ original: MemoryRecord, using sanitize: (String) -> String) -> MemoryRecord {
        var record = original
        record.statement = sanitize(record.statement)
        record.tags = record.tags.map(sanitize)
        record.sourceArtifact = sanitize(record.sourceArtifact)
        return record
    }

    private func sanitizedEvolution(_ original: EvolutionProposal, using sanitize: (String) -> String) -> EvolutionProposal {
        var proposal = original
        proposal.name = sanitize(proposal.name)
        proposal.version = sanitize(proposal.version)
        proposal.source = sanitize(proposal.source)
        proposal.reason = sanitize(proposal.reason)
        proposal.exactDiff = sanitize(proposal.exactDiff)
        proposal.permissions = proposal.permissions.map(sanitize)
        proposal.evaluationSuite = sanitize(proposal.evaluationSuite)
        proposal.evaluationSummary = proposal.evaluationSummary.map(sanitize)
        proposal.rollbackTarget = proposal.rollbackTarget.map(sanitize)
        return proposal
    }

    private func sanitizedSession(_ original: LoopSession, using sanitize: (String) -> String) -> LoopSession {
        var session = original
        session.title = sanitize(session.title)
        // titleSource / titleLocked are structural, not free text.
        session.goal = sanitize(session.goal)
        session.clarifiedSummary = sanitize(session.clarifiedSummary)
        session.questions = session.questions.map {
            ClarifyingQuestion(id: sanitize($0.id), question: sanitize($0.question), whyItMatters: sanitize($0.whyItMatters))
        }
        var answers: [String: String] = [:]
        for (index, pair) in session.answers.sorted(by: { $0.key < $1.key }).enumerated() {
            let key = sanitize(pair.key)
            answers[answers[key] == nil ? key : "\(key)-\(index)"] = sanitize(pair.value)
        }
        session.answers = answers
        session.criteria = session.criteria.map {
            Criterion(id: sanitize($0.id), title: sanitize($0.title), detail: sanitize($0.detail), evidence: sanitize($0.evidence))
        }
        session.plan = session.plan.map {
            PlanStep(id: sanitize($0.id), title: sanitize($0.title), detail: sanitize($0.detail), proof: sanitize($0.proof))
        }
        session.risks = session.risks.map(sanitize)
        session.acceptanceTest = sanitize(session.acceptanceTest)
        session.implementation = sanitize(session.implementation)
        session.implementationNotes = session.implementationNotes.map(sanitize)
        session.reviews = session.reviews.map { review in
            ReviewRecord(
                id: review.id,
                target: sanitize(review.target),
                round: review.round,
                score: review.score,
                passed: review.passed,
                summary: sanitize(review.summary),
                findings: review.findings.map {
                    ReviewFinding(id: $0.id, severity: sanitize($0.severity), criterionID: $0.criterionID.map(sanitize), issue: sanitize($0.issue), requiredChange: sanitize($0.requiredChange))
                },
                requiredChanges: review.requiredChanges.map(sanitize),
                criterionAssessments: review.criterionAssessments?.map {
                    CriterionAssessment(criterionID: sanitize($0.criterionID), status: sanitize($0.status), evidence: sanitize($0.evidence), evidenceRefs: $0.evidenceRefs?.map(sanitize))
                }
            )
        }
        session.timeline = session.timeline.map {
            TimelineEntry(id: $0.id, date: $0.date, role: $0.role, title: sanitize($0.title), summary: sanitize($0.summary), metrics: $0.metrics)
        }
        session.statusMessage = sanitize(session.statusMessage)
        session.attachments = session.attachments.map {
            ImageAttachment(id: $0.id, fileURL: $0.fileURL, displayName: sanitize($0.displayName), mimeType: sanitize($0.mimeType), byteCount: $0.byteCount)
        }
        if let report = session.artifactReport {
            session.artifactReport = ArtifactExecutionReport(
                enabled: report.enabled,
                passed: report.passed,
                summary: sanitize(report.summary),
                files: report.files.map { ArtifactFileEvidence(path: sanitize($0.path), bytes: $0.bytes, sha256: sanitize($0.sha256)) },
                commands: report.commands.map {
                    VerificationCommandEvidence(
                        executable: sanitize($0.executable), arguments: $0.arguments.map(sanitize), purpose: sanitize($0.purpose),
                        exitCode: $0.exitCode, output: sanitize($0.output), passed: $0.passed,
                        origin: $0.origin.map(sanitize), durationMs: $0.durationMs
                    )
                },
                previews: report.previews?.map {
                    ArtifactPreviewEvidence(
                        kind: sanitize($0.kind), title: sanitize($0.title), sourcePath: sanitize($0.sourcePath),
                        previewPath: sanitize($0.previewPath), mimeType: sanitize($0.mimeType), passed: $0.passed,
                        message: sanitize($0.message), width: $0.width, height: $0.height,
                        loopback: $0.loopback.map {
                            ArtifactLoopbackEvidence(
                                scheme: sanitize($0.scheme), host: sanitize($0.host), status: $0.status,
                                contentType: sanitize($0.contentType), bytes: $0.bytes, sha256: sanitize($0.sha256)
                            )
                        }
                    )
                },
                workspaceAudit: ArtifactWorkspaceAudit(
                    passed: report.workspaceAudit.passed, files: report.workspaceAudit.files, bytes: report.workspaceAudit.bytes,
                    message: sanitize(report.workspaceAudit.message)
                )
            )
        }
        return session
    }
}

private struct NativeFallbackBlockedService: LoopServicing {
    private func unavailable() -> Error {
        NSError(domain: "LightningLoop", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Clarification and completion require the shared LightningLoop harness. Direct custom-provider access is limited to explicit connection testing in Settings."
        ])
    }

    func clarify(goal: String, attachments: [ImageAttachment], expectedModelSelection: ExpectedModelSelection, runID: UUID?) async throws -> ClarificationResult {
        throw unavailable()
    }

    func execute(goal: String, summary: String, questions: [ClarifyingQuestion], answers: [String: String], maxReviewCycles: Int, attachments: [ImageAttachment], researchProvider: String?, artifactWorkspace: String?, approveArtifactWrites: Bool, approveVerificationCommands: Bool, expectedModelSelection: ExpectedModelSelection, runID: UUID?, emit: @escaping @Sendable (LoopEngineEvent) async -> Void) async throws -> LoopExecutionResult {
        throw unavailable()
    }
}
