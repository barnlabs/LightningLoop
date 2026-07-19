import AppKit
import Foundation
import Observation

@Observable
@MainActor
final class AppModel {
    var sessions: [LoopSession]
    var selectedSessionID: UUID?
    var isRunning = false
    var settingsMessage = ""
    var connectionMetrics: InferenceMetrics?
    private(set) var hasAPIKey = false

    private let engine: LoopEngine
    private let keychain: KeychainStore
    private let archive: SessionArchive
    private var operation: Task<Void, Never>?

    init(
        engine: LoopEngine,
        keychain: KeychainStore = .init(),
        archive: SessionArchive = .init()
    ) {
        self.engine = engine
        self.keychain = keychain
        self.archive = archive
        let loaded = archive.load()
        self.sessions = loaded.isEmpty ? [LoopSession()] : loaded
        self.selectedSessionID = self.sessions.first?.id
        refreshCredentialState()
    }

    static func live() -> AppModel {
        let keychain = KeychainStore()
        return AppModel(engine: LoopEngine(agent: CerebrasClient(keychain: keychain)), keychain: keychain)
    }

    var selectedSession: LoopSession? {
        guard let selectedSessionID else { return nil }
        return sessions.first(where: { $0.id == selectedSessionID })
    }

    var allQuestionsAnswered: Bool {
        guard let session = selectedSession, !session.questions.isEmpty else { return false }
        return session.questions.allSatisfy {
            !(session.answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

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
        mutateSelected { session in
            session.goal = goal
            let singleLine = goal.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            session.title = singleLine.isEmpty ? "New loop" : String(singleLine.prefix(52))
            session.updatedAt = Date()
        }
    }

    func updateAnswer(questionID: String, value: String) {
        mutateSelected { session in
            session.answers[questionID] = value
            session.updatedAt = Date()
        }
    }

    func startClarification() {
        guard !isRunning, let session = selectedSession else { return }
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
                let result = try await self.engine.clarify(goal: session.goal)
                self.mutateSession(sessionID) { current in
                    current.clarifiedSummary = result.summary
                    current.questions = result.questions
                    current.answers = Dictionary(uniqueKeysWithValues: result.questions.map { ($0.id, current.answers[$0.id] ?? "") })
                    current.timeline.append(result.timeline)
                    current.metrics = current.metrics + result.timeline.metrics
                    current.stage = .awaitingAnswers
                    current.statusMessage = "Answer the questions, then start the strict loop."
                    current.updatedAt = Date()
                }
            } catch is CancellationError {
                self.markCancelled(sessionID)
            } catch {
                self.markFailed(error, sessionID: sessionID)
            }
            self.isRunning = false
            self.persist()
        }
    }

    func startLoop() {
        guard !isRunning, allQuestionsAnswered, let session = selectedSession else { return }
        let sessionID = session.id
        operation?.cancel()
        isRunning = true
        let cycleLimit = configuredReviewCycles
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.engine.execute(
                    goal: session.goal,
                    summary: session.clarifiedSummary,
                    answers: session.answers,
                    maxReviewCycles: cycleLimit
                ) { [weak self] event in
                    await self?.apply(event, to: sessionID)
                }
                self.mutateSession(sessionID) { current in
                    current.criteria = result.planning.criteria
                    current.plan = result.planning.plan
                    current.risks = result.planning.risks
                    current.acceptanceTest = result.planning.acceptanceTest
                    current.implementation = result.implementation.deliverable
                    current.implementationNotes = result.implementation.notes
                    current.stage = result.completed ? .completed : .paused
                    current.statusMessage = result.finalMessage
                    current.updatedAt = Date()
                }
            } catch is CancellationError {
                self.markCancelled(sessionID)
            } catch {
                self.markFailed(error, sessionID: sessionID)
            }
            self.isRunning = false
            self.persist()
        }
    }

    func cancelCurrentOperation() {
        operation?.cancel()
        operation = nil
    }

    func saveAPIKey(_ value: String) {
        do {
            try keychain.saveAPIKey(value)
            hasAPIKey = true
            settingsMessage = "API key saved in macOS Keychain."
        } catch {
            settingsMessage = error.localizedDescription
        }
    }

    func removeAPIKey() {
        do {
            try keychain.deleteAPIKey()
            hasAPIKey = false
            settingsMessage = "API key removed from macOS Keychain."
            connectionMetrics = nil
        } catch {
            settingsMessage = error.localizedDescription
        }
    }

    func testConnection() async {
        settingsMessage = "Testing Gemma 4 31B…"
        do {
            let reply = try await CerebrasClient(keychain: keychain).complete(LoopPrompts.connectionProbe())
            connectionMetrics = reply.metrics
            settingsMessage = "Connected to \(reply.model)."
        } catch {
            connectionMetrics = nil
            settingsMessage = error.localizedDescription
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

    private func apply(_ event: LoopEngineEvent, to sessionID: UUID) {
        mutateSession(sessionID) { session in
            switch event {
            case .phase(let stage, let message):
                session.stage = stage
                session.statusMessage = message
            case .timeline(let entry):
                session.timeline.append(entry)
                session.metrics = session.metrics + entry.metrics
            case .planning(let draft):
                session.criteria = draft.criteria
                session.plan = draft.plan
                session.risks = draft.risks
                session.acceptanceTest = draft.acceptanceTest
            case .review(let record):
                session.reviews.append(record)
            case .implementation(let draft):
                session.implementation = draft.deliverable
                session.implementationNotes = draft.notes
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
            $0.statusMessage = error.localizedDescription
        }
    }

    private func persist() {
        archive.save(sessions)
    }

    private func refreshCredentialState() {
        let keychain = self.keychain
        Task { [weak self] in
            let configured = await Task.detached {
                ((try? keychain.readAPIKey()) ?? nil)?.isEmpty == false
            }.value
            self?.hasAPIKey = configured
        }
    }

    private func sanitizedFilename(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let mapped = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "-" }
        let compact = String(mapped).replacingOccurrences(of: "--", with: "-")
        return compact.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
