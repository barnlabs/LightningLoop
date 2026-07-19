import Foundation

enum CerebrasClientError: LocalizedError, Equatable {
    case missingAPIKey
    case invalidResponse
    case server(status: Int, message: String)
    case emptyResponse

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            "Add a Cerebras API key in Settings."
        case .invalidResponse:
            "Cerebras returned an unreadable response."
        case .server(let status, let message):
            "Cerebras request failed (HTTP \(status)): \(message)"
        case .emptyResponse:
            "The model returned no content."
        }
    }
}

struct CerebrasClient: AgentServing {
    static let model = "gemma-4-31b"
    static let endpoint = URL(string: "https://api.cerebras.ai/v1/chat/completions")!

    private let keychain: KeychainStore
    private let session: URLSession

    init(keychain: KeychainStore = .init(), session: URLSession = .shared) {
        self.keychain = keychain
        self.session = session
    }

    func complete(_ request: AgentRequest) async throws -> AgentReply {
        guard let apiKey = try keychain.readAPIKey(), !apiKey.isEmpty else {
            throw CerebrasClientError.missingAPIKey
        }

        var urlRequest = URLRequest(url: Self.endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 180
        urlRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("2", forHTTPHeaderField: "X-Cerebras-Version-Patch")
        urlRequest.httpBody = try JSONEncoder().encode(
            RequestBody(
                model: Self.model,
                messages: request.messages,
                temperature: request.temperature,
                maxCompletionTokens: request.maxCompletionTokens,
                responseFormat: request.jsonMode ? .init(type: "json_object") : nil
            )
        )

        let (data, response) = try await session.data(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CerebrasClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorEnvelope.self, from: data).error.message)
                ?? HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
            throw CerebrasClientError.server(status: httpResponse.statusCode, message: message)
        }

        let envelope = try JSONDecoder().decode(ResponseEnvelope.self, from: data)
        guard let content = envelope.choices.first?.message.content, !content.isEmpty else {
            throw CerebrasClientError.emptyResponse
        }
        let usage = envelope.usage
        let timing = envelope.timeInfo
        return AgentReply(
            content: content,
            metrics: .init(
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: usage?.completionTokens ?? 0,
                totalSeconds: timing?.totalTime ?? 0,
                completionSeconds: timing?.completionTime ?? 0
            ),
            model: envelope.model ?? Self.model
        )
    }
}

private extension CerebrasClient {
    struct RequestBody: Encodable {
        let model: String
        let messages: [AgentMessage]
        let temperature: Double
        let maxCompletionTokens: Int
        let responseFormat: ResponseFormat?

        enum CodingKeys: String, CodingKey {
            case model, messages, temperature
            case maxCompletionTokens = "max_completion_tokens"
            case responseFormat = "response_format"
        }
    }

    struct ResponseFormat: Encodable {
        let type: String
    }

    struct ResponseEnvelope: Decodable {
        struct Choice: Decodable {
            struct Message: Decodable { let content: String? }
            let message: Message
        }
        let model: String?
        let choices: [Choice]
        let usage: Usage?
        let timeInfo: TimeInfo?

        enum CodingKeys: String, CodingKey {
            case model, choices, usage
            case timeInfo = "time_info"
        }
    }

    struct Usage: Decodable {
        let promptTokens: Int
        let completionTokens: Int

        enum CodingKeys: String, CodingKey {
            case promptTokens = "prompt_tokens"
            case completionTokens = "completion_tokens"
        }
    }

    struct TimeInfo: Decodable {
        let totalTime: Double
        let completionTime: Double

        enum CodingKeys: String, CodingKey {
            case totalTime = "total_time"
            case completionTime = "completion_time"
        }
    }

    struct APIErrorEnvelope: Decodable {
        struct APIError: Decodable { let message: String }
        let error: APIError
    }
}
