import Foundation

enum ProviderClientError: LocalizedError, Equatable {
    case missingAPIKey(String)
    case invalidConfiguration
    case invalidResponse(String)
    case server(provider: String, status: Int, message: String)
    case emptyResponse
    case imageReadFailed(String)
    case piManagedProfile

    var errorDescription: String? {
        switch self {
        case .missingAPIKey(let provider): "Add a \(provider) API key in Settings."
        case .invalidConfiguration: "The active provider profile is invalid. Review it in Settings."
        case .invalidResponse(let provider): "\(provider) returned an unreadable response."
        case .server(let provider, let status, _): "\(provider) request failed (HTTP \(status)); provider response text was withheld."
        case .emptyResponse: "The model returned no text content."
        case .imageReadFailed(let name): "The image \(name) could not be read. Remove it and attach it again."
        case .piManagedProfile: "Built-in providers are managed by the LightningLoop runtime. Native direct requests are available only for GeneralCompute or an explicitly selected Custom profile."
        }
    }
}

final class SameOriginSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let original = task.originalRequest?.url,
              let destination = request.url,
              original.scheme == destination.scheme,
              original.host == destination.host,
              original.port == destination.port else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}

struct ProviderClient: AgentServing, Sendable {
    typealias CredentialReader = @Sendable (ProviderConfiguration) throws -> String?

    private let keychain: KeychainStore
    private let profileStore: ProviderConfigurationStore
    private let session: URLSession
    private let credentialReader: CredentialReader

    init(
        keychain: KeychainStore = .init(),
        profileStore: ProviderConfigurationStore = .init(),
        session: URLSession? = nil,
        credentialReader: CredentialReader? = nil
    ) {
        self.keychain = keychain
        self.profileStore = profileStore
        self.credentialReader = credentialReader ?? { try keychain.readCredential(for: $0) }
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = false
            configuration.timeoutIntervalForRequest = 180
            configuration.timeoutIntervalForResource = 190
            self.session = URLSession(configuration: configuration, delegate: SameOriginSessionDelegate(), delegateQueue: nil)
        }
    }

    func complete(_ request: AgentRequest) async throws -> AgentReply {
        let profile = try profileStore.loadValidated()
        guard profile.allowsNativeConnectionTesting else { throw ProviderClientError.piManagedProfile }
        guard let endpoint = profile.endpoint else { throw ProviderClientError.invalidConfiguration }
        guard let apiKey = try credentialReader(profile), !apiKey.isEmpty else {
            throw ProviderClientError.missingAPIKey(profile.displayName)
        }
        guard request.attachments.isEmpty || profile.supportsImages else {
            throw ProviderClientError.server(provider: profile.displayName, status: 0, message: "The selected model is configured as text-only. Choose an image-capable model or remove the attachments.")
        }

        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 180
        urlRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(
            RequestBody(
                model: profile.modelID,
                messages: try requestMessages(request.messages, attachments: request.attachments),
                temperature: request.temperature,
                maxCompletionTokens: min(request.maxCompletionTokens, profile.maxOutputTokens),
                responseFormat: request.jsonMode ? .init(type: "json_object") : nil
            )
        )

        let started = Date()
        let (data, response) = try await session.data(for: urlRequest)
        let elapsed = Date().timeIntervalSince(started)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ProviderClientError.invalidResponse(profile.displayName)
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw ProviderClientError.server(provider: profile.displayName, status: httpResponse.statusCode, message: "provider-response-withheld")
        }

        let redactedData = redactCredential(apiKey, in: data)
        guard let envelope = try? JSONDecoder().decode(ResponseEnvelope.self, from: redactedData) else {
            throw ProviderClientError.invalidResponse(profile.displayName)
        }
        guard let rawContent = envelope.choices.first?.message.content else { throw ProviderClientError.emptyResponse }
        let content = rawContent.replacingOccurrences(of: apiKey, with: "[REDACTED]")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else {
            throw ProviderClientError.emptyResponse
        }
        return AgentReply(
            content: content,
            metrics: .init(
                promptTokens: envelope.usage?.promptTokens ?? 0,
                completionTokens: envelope.usage?.completionTokens ?? 0,
                totalSeconds: envelope.timeInfo?.totalTime ?? elapsed,
                completionSeconds: envelope.timeInfo?.completionTime ?? elapsed
            ),
            model: (envelope.model ?? profile.modelID).replacingOccurrences(of: apiKey, with: "[REDACTED]")
        )
    }

    func listModels() async throws -> [String] {
        let profile = try profileStore.loadValidated()
        guard profile.allowsNativeConnectionTesting else { throw ProviderClientError.piManagedProfile }
        guard let endpoint = profile.modelsEndpoint else { throw ProviderClientError.invalidConfiguration }
        guard let apiKey = try credentialReader(profile), !apiKey.isEmpty else {
            throw ProviderClientError.missingAPIKey(profile.displayName)
        }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ProviderClientError.invalidResponse(profile.displayName) }
        guard (200..<300).contains(http.statusCode) else {
            throw ProviderClientError.server(provider: profile.displayName, status: http.statusCode, message: "provider-response-withheld")
        }
        guard let envelope = try? JSONDecoder().decode(ModelListEnvelope.self, from: data) else {
            throw ProviderClientError.invalidResponse(profile.displayName)
        }
        return Array(Set(envelope.data
            .map { $0.id.replacingOccurrences(of: apiKey, with: "[REDACTED]") }
            .filter { !$0.isEmpty })).sorted()
    }
}

private extension ProviderClient {
    func redactCredential(_ credential: String, in data: Data) -> Data {
        guard !credential.isEmpty, let text = String(data: data, encoding: .utf8) else { return data }
        return Data(text.replacingOccurrences(of: credential, with: "[REDACTED]").utf8)
    }

    enum MessageContent: Encodable {
        case text(String)
        case parts([ContentPart])

        func encode(to encoder: Encoder) throws {
            switch self {
            case .text(let value): try value.encode(to: encoder)
            case .parts(let value): try value.encode(to: encoder)
            }
        }
    }

    struct ContentPart: Encodable {
        let type: String
        let text: String?
        let imageURL: ImageURL?

        struct ImageURL: Encodable { let url: String }
        enum CodingKeys: String, CodingKey { case type, text; case imageURL = "image_url" }

        static func text(_ value: String) -> ContentPart { .init(type: "text", text: value, imageURL: nil) }
        static func image(_ value: String) -> ContentPart { .init(type: "image_url", text: nil, imageURL: .init(url: value)) }
    }

    struct RequestMessage: Encodable {
        let role: String
        let content: MessageContent
    }

    func requestMessages(_ messages: [AgentMessage], attachments: [ImageAttachment]) throws -> [RequestMessage] {
        let finalUserIndex = messages.lastIndex { $0.role == .user }
        return try messages.enumerated().map { index, message in
            guard index == finalUserIndex, !attachments.isEmpty else {
                return RequestMessage(role: message.role.rawValue, content: .text(message.content))
            }
            var parts: [ContentPart] = [.text(message.content)]
            for attachment in attachments {
                guard let data = try? Data(contentsOf: attachment.fileURL, options: .mappedIfSafe) else {
                    throw ProviderClientError.imageReadFailed(attachment.displayName)
                }
                parts.append(.image("data:\(attachment.mimeType);base64,\(data.base64EncodedString())"))
            }
            return RequestMessage(role: message.role.rawValue, content: .parts(parts))
        }
    }

    struct RequestBody: Encodable {
        let model: String
        let messages: [RequestMessage]
        let temperature: Double
        let maxCompletionTokens: Int
        let responseFormat: ResponseFormat?
        enum CodingKeys: String, CodingKey {
            case model, messages, temperature
            case maxCompletionTokens = "max_completion_tokens"
            case responseFormat = "response_format"
        }
    }

    struct ResponseFormat: Encodable { let type: String }
    struct ResponseEnvelope: Decodable {
        struct Choice: Decodable { struct Message: Decodable { let content: String? }; let message: Message }
        let model: String?
        let choices: [Choice]
        let usage: Usage?
        let timeInfo: TimeInfo?
        enum CodingKeys: String, CodingKey { case model, choices, usage; case timeInfo = "time_info" }
    }
    struct Usage: Decodable {
        let promptTokens: Int
        let completionTokens: Int
        enum CodingKeys: String, CodingKey { case promptTokens = "prompt_tokens"; case completionTokens = "completion_tokens" }
    }
    struct TimeInfo: Decodable {
        let totalTime: Double
        let completionTime: Double
        enum CodingKeys: String, CodingKey { case totalTime = "total_time"; case completionTime = "completion_time" }
    }
    struct ModelListEnvelope: Decodable { struct Model: Decodable { let id: String }; let data: [Model] }
}
