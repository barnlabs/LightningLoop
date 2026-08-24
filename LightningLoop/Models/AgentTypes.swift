import Foundation

enum LoopAgent: String, Codable, CaseIterable, Identifiable, Sendable {
    case researcher
    case engineer
    case verifier

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .researcher: "Researcher"
        case .engineer: "Engineer"
        case .verifier: "Verifier"
        }
    }

    var duty: String {
        switch self {
        case .researcher: "Find current facts from reputable primary sources."
        case .engineer: "Implement the approved contract."
        case .verifier: "Falsify the work. Default to revise."
        }
    }
}

enum SourceTrust {
    static let documentationHosts: Set<String> = [
        "developer.mozilla.org", "www.rfc-editor.org", "rfc-editor.org",
        "www.w3.org", "w3.org", "datatracker.ietf.org", "www.ietf.org",
        "spec.whatwg.org", "nodejs.org", "www.typescriptlang.org", "typescriptlang.org",
        "doc.rust-lang.org", "www.rust-lang.org", "go.dev", "pkg.go.dev",
        "docs.python.org", "www.python.org", "kubernetes.io", "learn.microsoft.com",
        "developer.apple.com", "docs.oracle.com", "openjdk.org",
        "www.unicode.org", "unicode.org", "crates.io", "docs.rs",
    ]

    static func isLoopbackArtifact(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1"
    }

    static func isReputable(_ url: URL) -> Bool {
        if isLoopbackArtifact(url) { return true }
        guard url.scheme == "https", url.user == nil, url.password == nil else { return false }
        let host = (url.host ?? "").lowercased()
        if documentationHosts.contains(host) { return true }
        return host.hasSuffix(".gov") || host.hasSuffix(".edu") || host.hasSuffix(".mil") || host.hasSuffix(".int")
    }
}

struct LoopAgentRoster: Codable, Sendable {
    var schemaVersion: Int = 1
    var agents: [String: LoopAgentAssignment] = [
        LoopAgent.researcher.rawValue: LoopAgentAssignment(),
        LoopAgent.engineer.rawValue: LoopAgentAssignment(),
        LoopAgent.verifier.rawValue: LoopAgentAssignment(),
    ]

    static var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LightningLoop", isDirectory: true)
            .appendingPathComponent("agents.json")
    }

    static func load() -> LoopAgentRoster {
        guard let data = try? Data(contentsOf: fileURL) else { return LoopAgentRoster() }
        return (try? JSONDecoder().decode(LoopAgentRoster.self, from: data)) ?? LoopAgentRoster()
    }

    func save() throws {
        let directory = Self.fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: Self.fileURL, options: .atomic)
    }

    func modelID(for agent: LoopAgent) -> String {
        agents[agent.rawValue]?.modelID ?? ""
    }

    mutating func setModelID(_ modelID: String, for agent: LoopAgent) {
        agents[agent.rawValue] = LoopAgentAssignment(modelID: modelID)
    }
}

struct LoopAgentAssignment: Codable, Sendable {
    var modelID: String = ""
}

enum AgentRole: String, Codable, Sendable {
    case orchestrator
    case reviewer
    case implementer

    var loopAgent: LoopAgent {
        switch self {
        case .orchestrator: .researcher
        case .implementer: .engineer
        case .reviewer: .verifier
        }
    }

    var displayName: String {
        switch self {
        case .orchestrator: "Orchestrator"
        case .reviewer: "Gold Reviewer"
        case .implementer: "Implementer"
        }
    }

    var symbol: String {
        switch self {
        case .orchestrator: "point.3.connected.trianglepath.dotted"
        case .reviewer: "checkmark.seal"
        case .implementer: "hammer"
        }
    }
}

enum MessageRole: String, Codable, Sendable {
    case system
    case user
    case assistant
}

struct AgentMessage: Codable, Hashable, Sendable {
    let role: MessageRole
    let content: String
}

struct ImageAttachment: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let fileURL: URL
    let displayName: String
    let mimeType: String
    let byteCount: Int

    init(id: UUID = UUID(), fileURL: URL, displayName: String, mimeType: String, byteCount: Int) {
        self.id = id
        self.fileURL = fileURL
        self.displayName = displayName
        self.mimeType = mimeType
        self.byteCount = byteCount
    }
}

struct AgentRequest: Sendable {
    let messages: [AgentMessage]
    let temperature: Double
    let maxCompletionTokens: Int
    let jsonMode: Bool
    let attachments: [ImageAttachment]

    init(
        messages: [AgentMessage],
        temperature: Double = 0.2,
        maxCompletionTokens: Int = 4_096,
        jsonMode: Bool = true,
        attachments: [ImageAttachment] = []
    ) {
        self.messages = messages
        self.temperature = temperature
        self.maxCompletionTokens = maxCompletionTokens
        self.jsonMode = jsonMode
        self.attachments = attachments
    }
}

struct InferenceMetrics: Codable, Hashable, Sendable {
    var promptTokens: Int = 0
    var completionTokens: Int = 0
    var totalSeconds: Double = 0
    var completionSeconds: Double = 0

    var tokensPerSecond: Double? {
        guard completionSeconds > 0 else { return nil }
        return Double(completionTokens) / completionSeconds
    }

    var estimatedCostUSD: Double? { nil }

    static func + (lhs: Self, rhs: Self) -> Self {
        .init(
            promptTokens: lhs.promptTokens + rhs.promptTokens,
            completionTokens: lhs.completionTokens + rhs.completionTokens,
            totalSeconds: lhs.totalSeconds + rhs.totalSeconds,
            completionSeconds: lhs.completionSeconds + rhs.completionSeconds
        )
    }
}

struct AgentReply: Sendable {
    let content: String
    let metrics: InferenceMetrics
    let model: String
}

protocol AgentServing: Sendable {
    func complete(_ request: AgentRequest) async throws -> AgentReply
}
