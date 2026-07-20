import Foundation

struct ResearchSource: Codable, Hashable, Sendable {
    let provider: String
    let query: String
    let title: String
    let url: String
    let snippet: String
    let publishedAt: String?
}

enum ResearchClientError: LocalizedError, Equatable {
    case unsupportedProvider
    case invalidQuery
    case missingCredential(String)
    case invalidResponse(String)
    case server(provider: String, status: Int)
    case responseTooLarge
    case credentialSafetyUnavailable
    case unsafeQuery

    var errorDescription: String? {
        switch self {
        case .unsupportedProvider: "Choose Exa, Brave, or Firecrawl for research."
        case .invalidQuery: "Research queries must contain 1 through 400 characters."
        case .missingCredential(let provider): "Add a \(provider) credential in Settings before enabling research."
        case .invalidResponse(let provider): "\(provider) returned an unreadable search response."
        case .server(let provider, let status): "\(provider) search failed (HTTP \(status)); provider response text was withheld."
        case .responseTooLarge: "The search response exceeded LightningLoop’s 2 MB safety limit."
        case .credentialSafetyUnavailable: "LightningLoop could not safely load its credential-filter catalog, so research was stopped."
        case .unsafeQuery: "The research query contains credential or secret-like content and was not sent."
        }
    }
}

protocol ResearchServing: Sendable {
    func search(provider: String, query: String, limit: Int) async throws -> [ResearchSource]
}

struct ResearchClient: ResearchServing, Sendable {
    typealias CredentialReader = @Sendable (String) throws -> String?
    typealias CredentialServiceCatalogReader = @Sendable () throws -> [String]

    private let session: URLSession
    private let credentialReader: CredentialReader
    private let credentialServiceCatalog: CredentialServiceCatalogReader
    private let responseDeadlineNanoseconds: UInt64
    private let maximumResponseBytes: Int

    private static let defaultMaximumResponseBytes = 2 * 1_048_576

    init(
        keychain: KeychainStore = .init(),
        session: URLSession? = nil,
        credentialReader: CredentialReader? = nil,
        credentialServiceCatalog: CredentialServiceCatalogReader? = nil,
        responseDeadlineNanoseconds: UInt64 = 35_000_000_000,
        maximumResponseBytes: Int = ResearchClient.defaultMaximumResponseBytes
    ) {
        self.credentialReader = credentialReader ?? { try keychain.readCredential(service: $0) }
        self.credentialServiceCatalog = credentialServiceCatalog ?? {
            try CredentialServiceCatalog.services(activeProfile: .onboarding)
        }
        self.responseDeadlineNanoseconds = responseDeadlineNanoseconds
        self.maximumResponseBytes = min(max(maximumResponseBytes, 1), Self.defaultMaximumResponseBytes)
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = false
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 35
            self.session = URLSession(configuration: configuration)
        }
    }

    func search(provider: String, query: String, limit: Int = 5) async throws -> [ResearchSource] {
        let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...400).contains(cleanQuery.count) else { throw ResearchClientError.invalidQuery }
        let cleanLimit = min(max(limit, 1), 20)
        guard let credentialProvider = Self.credentialProvider(for: provider) else {
            throw ResearchClientError.unsupportedProvider
        }
        var credentials = try credentialFilterSet()
        guard let credential = try credentialReader(credentialProvider.service)?.trimmingCharacters(in: .whitespacesAndNewlines), !credential.isEmpty else {
            throw ResearchClientError.missingCredential(credentialProvider.label)
        }
        guard credential.utf8.count <= 16_384 else { throw ResearchClientError.credentialSafetyUnavailable }
        credentials.insert(credential)
        guard !containsCredential(cleanQuery, credentials: credentials),
              !containsRecognizedSecretShape(cleanQuery) else {
            throw ResearchClientError.unsafeQuery
        }

        let request = try makeRequest(provider: provider, query: cleanQuery, limit: cleanLimit, credential: credential)
        let data = try await loadBounded(request, provider: provider)
        let sources = try decode(provider: provider, query: cleanQuery, data: data, credentials: credentials)
        return Array(sources.prefix(cleanLimit))
    }
}

private extension ResearchClient {
    /// Re-read every bounded LightningLoop-owned service on each search. This
    /// includes selected and unselected research keys, fixed legacy services,
    /// and registered historical custom services. The catalog intentionally
    /// never includes Pi-managed services or enumerates Keychain globally.
    func credentialFilterSet() throws -> Set<String> {
        let services: [String]
        do {
            services = try credentialServiceCatalog()
        } catch {
            throw ResearchClientError.credentialSafetyUnavailable
        }
        guard services.count <= 256,
              Set(services).count == services.count,
              services.allSatisfy({ $0.count <= 512 && $0.hasPrefix("com.barnlabs.LightningLoop.") }) else {
            throw ResearchClientError.credentialSafetyUnavailable
        }
        var values = Set<String>()
        do {
            for service in services {
                if let value = try credentialReader(service)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                    guard value.utf8.count <= 16_384 else { throw ResearchClientError.credentialSafetyUnavailable }
                    values.insert(value)
                }
            }
        } catch {
            throw ResearchClientError.credentialSafetyUnavailable
        }
        return values
    }

    func loadBounded(_ request: URLRequest, provider: String) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                let redirectDelegate = RejectResearchRedirectDelegate()
                let (bytes, response) = try await session.bytes(for: request, delegate: redirectDelegate)
                guard let http = response as? HTTPURLResponse,
                      http.url == request.url else {
                    throw ResearchClientError.invalidResponse(provider)
                }
                guard (200..<300).contains(http.statusCode) else {
                    throw ResearchClientError.server(provider: provider, status: http.statusCode)
                }
                guard let contentType = http.value(forHTTPHeaderField: "Content-Type"),
                      isExpectedJSONContentType(contentType) else {
                    throw ResearchClientError.invalidResponse(provider)
                }
                if http.expectedContentLength > maximumResponseBytes {
                    throw ResearchClientError.responseTooLarge
                }

                var data = Data()
                data.reserveCapacity(min(max(Int(http.expectedContentLength), 0), maximumResponseBytes))
                for try await byte in bytes {
                    guard data.count < maximumResponseBytes else {
                        throw ResearchClientError.responseTooLarge
                    }
                    data.append(byte)
                }
                return data
            }
            group.addTask {
                try await Task.sleep(nanoseconds: responseDeadlineNanoseconds)
                throw URLError(.timedOut)
            }

            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw ResearchClientError.invalidResponse(provider)
            }
            return result
        }
    }

    func isExpectedJSONContentType(_ value: String) -> Bool {
        guard !value.contains(",") else { return false }
        let components = value.split(separator: ";", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard components.first?.lowercased() == "application/json" else { return false }
        var sawCharset = false
        for parameter in components.dropFirst() {
            let pair = parameter.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            guard pair.count == 2,
                  pair[0].lowercased() == "charset",
                  !sawCharset else { return false }
            let charset = pair[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            guard charset.lowercased() == "utf-8" else { return false }
            sawCharset = true
        }
        return true
    }

    static func credentialProvider(for provider: String) -> CredentialProvider? {
        switch provider.lowercased() {
        case "exa": .exa
        case "brave": .brave
        case "firecrawl": .firecrawl
        default: nil
        }
    }

    func makeRequest(provider: String, query: String, limit: Int, credential: String) throws -> URLRequest {
        switch provider.lowercased() {
        case "exa":
            var request = URLRequest(url: URL(string: "https://api.exa.ai/search")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(credential, forHTTPHeaderField: "x-api-key")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "query": query,
                "numResults": limit,
                "type": "auto",
                "moderation": true,
                "contents": ["highlights": true]
            ])
            return request
        case "brave":
            var components = URLComponents(string: "https://api.search.brave.com/res/v1/web/search")!
            components.queryItems = [
                .init(name: "q", value: query),
                .init(name: "count", value: String(limit)),
                .init(name: "safesearch", value: "moderate")
            ]
            var request = URLRequest(url: components.url!)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(credential, forHTTPHeaderField: "X-Subscription-Token")
            return request
        case "firecrawl":
            var request = URLRequest(url: URL(string: "https://api.firecrawl.dev/v2/search")!)
            request.httpMethod = "POST"
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "query": query,
                "limit": limit,
                "sources": ["web"],
                "country": "US",
                "timeout": 25_000
            ])
            return request
        default:
            throw ResearchClientError.unsupportedProvider
        }
    }

    func decode(provider: String, query: String, data: Data, credentials: Set<String>) throws -> [ResearchSource] {
        let decoder = JSONDecoder()
        switch provider.lowercased() {
        case "exa":
            guard let envelope = try? decoder.decode(ExaEnvelope.self, from: data) else {
                throw ResearchClientError.invalidResponse(provider)
            }
            return envelope.results.compactMap { item in
                source(
                    provider: provider,
                    query: query,
                    title: item.title,
                    url: item.url,
                    snippet: item.highlights?.joined(separator: " ") ?? item.summary ?? item.text ?? "",
                    publishedAt: item.publishedDate,
                    credentials: credentials
                )
            }
        case "brave":
            guard let envelope = try? decoder.decode(BraveEnvelope.self, from: data) else {
                throw ResearchClientError.invalidResponse(provider)
            }
            return envelope.web?.results.compactMap { item in
                source(provider: provider, query: query, title: item.title, url: item.url, snippet: item.description ?? "", publishedAt: nil, credentials: credentials)
            } ?? []
        case "firecrawl":
            guard let envelope = try? decoder.decode(FirecrawlEnvelope.self, from: data) else {
                throw ResearchClientError.invalidResponse(provider)
            }
            return envelope.data?.web.compactMap { item in
                source(provider: provider, query: query, title: item.title, url: item.url, snippet: item.description ?? item.markdown ?? "", publishedAt: nil, credentials: credentials)
            } ?? []
        default:
            throw ResearchClientError.unsupportedProvider
        }
    }

    func source(
        provider: String,
        query: String,
        title: String?,
        url: String?,
        snippet: String,
        publishedAt: String?,
        credentials: Set<String>
    ) -> ResearchSource? {
        guard let rawURL = url, !containsCredential(rawURL, credentials: credentials),
              var components = URLComponents(string: rawURL),
              components.scheme == "https" || components.scheme == "http",
              components.host?.isEmpty == false else { return nil }
        components.query = nil
        components.fragment = nil
        guard let safeURL = components.url?.absoluteString, !containsCredential(safeURL, credentials: credentials) else { return nil }
        return ResearchSource(
            provider: provider,
            query: query,
            title: clipped(redacted(title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? title! : safeURL, credentials: credentials), limit: 500),
            url: safeURL,
            snippet: clipped(redacted(snippet, credentials: credentials), limit: 1_200),
            publishedAt: publishedAt.map { clipped(redacted($0, credentials: credentials), limit: 100) }
        )
    }

    func redacted(_ value: String, credentials: Set<String>) -> String {
        var result = value
        for credential in credentials.filter({ !$0.isEmpty }).sorted(by: { $0.count > $1.count }) {
            result = result.replacingOccurrences(of: credential, with: "[REDACTED]")
        }
        return containsCredential(result, credentials: credentials) ? "[REDACTED]" : result
    }

    /// Search providers control these fields. Repeated decoding catches a key reflected
    /// through percent-encoding passes before it reaches model context. After the
    /// bounded decode budget, an unresolved percent escape is treated as unsafe rather
    /// than assumed benign.
    func containsCredential(_ value: String, credentials: Set<String>) -> Bool {
        guard !credentials.isEmpty else { return false }
        var candidate = value
        for _ in 0..<16 {
            if credentials.contains(where: { !$0.isEmpty && candidate.contains($0) }) { return true }
            guard candidate.contains("%") else { return false }
            guard let decoded = candidate.removingPercentEncoding, decoded != candidate else {
                return true
            }
            candidate = decoded
        }
        if credentials.contains(where: { !$0.isEmpty && candidate.contains($0) }) { return true }
        // One probe beyond the decoding budget: another escape could conceal a
        // credential, and malformed escapes also fail closed.
        return candidate.contains("%")
    }

    func containsRecognizedSecretShape(_ value: String) -> Bool {
        let patterns = [
            #"\bcsk-[A-Za-z0-9_-]{12,}\b"#,
            #"\bgsk_[A-Za-z0-9_-]{12,}\b"#,
            #"\bfc-[A-Za-z0-9_-]{12,}\b"#,
            #"\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b"#,
            #"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,4096}"#,
            #"(?i)\b(?:exa|brave|api[_ -]?key|token|secret|password)\s*[:=]\s*\S{12,4096}"#
        ]
        return patterns.contains {
            value.range(of: $0, options: .regularExpression) != nil
        }
    }

    func clipped(_ value: String, limit: Int) -> String {
        String(value.prefix(limit))
    }

    struct ExaEnvelope: Decodable {
        struct Result: Decodable {
            let title: String?
            let url: String?
            let highlights: [String]?
            let summary: String?
            let text: String?
            let publishedDate: String?
        }
        let results: [Result]
    }

    struct BraveEnvelope: Decodable {
        struct Web: Decodable {
            struct Result: Decodable { let title: String?; let url: String?; let description: String? }
            let results: [Result]
        }
        let web: Web?
    }

    struct FirecrawlEnvelope: Decodable {
        struct DataEnvelope: Decodable {
            struct Result: Decodable { let title: String?; let url: String?; let description: String?; let markdown: String? }
            let web: [Result]
        }
        let data: DataEnvelope?
    }
}

private final class RejectResearchRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
