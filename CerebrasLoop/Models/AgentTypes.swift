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

struct AgentRequest: Sendable {
    let messages: [AgentMessage]
    let temperature: Double
    let maxCompletionTokens: Int
    let jsonMode: Bool

    init(
        messages: [AgentMessage],
        temperature: Double = 0.2,
        maxCompletionTokens: Int = 4_096,
        jsonMode: Bool = true
    ) {
        self.messages = messages
        self.temperature = temperature
        self.maxCompletionTokens = maxCompletionTokens
        self.jsonMode = jsonMode
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

    var estimatedCostUSD: Double {
        (Double(promptTokens) * 0.00000099) + (Double(completionTokens) * 0.00000149)
    }

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
