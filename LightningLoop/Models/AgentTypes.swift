import Foundation

enum AgentRole: String, Codable, Sendable {
    case orchestrator
    case reviewer
    case implementer

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
