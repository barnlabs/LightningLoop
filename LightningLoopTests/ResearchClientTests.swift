import Foundation
import XCTest
@testable import LightningLoop

final class ResearchClientTests: XCTestCase {
    override func tearDown() {
        ResearchURLProtocol.handler = nil
        ResearchURLProtocol.chunkedHandler = nil
        super.tearDown()
    }

    func testBraveUsesFixedEndpointAndRedactsReflectedCredential() async throws {
        let recorder = URLRequestRecorder()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            recorder.record(request)
            let body = """
            {"web":{"results":[
              {"title":"Reflected test-search-secret", "url":"https://example.com/primary", "description":"Evidence test-search-secret"},
              {"title":"Unsafe", "url":"file:///tmp/private", "description":"drop me"}
            ]}}
            """
            return (jsonResponse(for: request), Data(body.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "test-search-secret" },
            credentialServiceCatalog: testCredentialServiceCatalog
        )

        let results = try await client.search(provider: "brave", query: "official provider docs", limit: 5)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].title, "Reflected [REDACTED]")
        XCTAssertEqual(results[0].snippet, "Evidence [REDACTED]")
        let request = try XCTUnwrap(recorder.request())
        XCTAssertEqual(request.url?.host, "api.search.brave.com")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Subscription-Token"), "test-search-secret")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "count" })?.value, "5")
    }

    func testRejectsOversizedQueryBeforeCredentialOrNetworkAccess() async {
        let client = ResearchClient(
            credentialReader: { _ in
                XCTFail("Credential lookup must not run for invalid input")
                return nil
            },
            credentialServiceCatalog: testCredentialServiceCatalog
        )
        await XCTAssertThrowsErrorAsync(try await client.search(provider: "exa", query: String(repeating: "x", count: 401), limit: 5)) {
            XCTAssertEqual($0 as? ResearchClientError, .invalidQuery)
        }
    }

    func testDropsRawAndRepeatedlyEncodedCredentialURLsAndSanitizesProviderFields() async throws {
        let credential = "synthetic-search-credential"
        let exactlyAtDecodeLimit = percentEncode(credential, layers: 16)
        let beyondDecodeLimit = percentEncode(credential, layers: 17)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            let body = """
            {"web":{"results":[
              {"title":"Raw key", "url":"https://example.com/?token=synthetic-search-credential", "description":"drop"},
              {"title":"At boundary", "url":"https://example.com/?token=\(exactlyAtDecodeLimit)", "description":"drop"},
              {"title":"Beyond boundary", "url":"https://example.com/?token=\(beyondDecodeLimit)", "description":"drop"},
              {"title":"encoded \(exactlyAtDecodeLimit)", "url":"https://example.com/safe?tracking=1#section", "description":"date \(beyondDecodeLimit)"}
            ]}}
            """
            return (jsonResponse(for: request), Data(body.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in credential },
            credentialServiceCatalog: testCredentialServiceCatalog
        )

        let results = try await client.search(provider: "brave", query: "provider safety", limit: 5)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].url, "https://example.com/safe")
        XCTAssertEqual(results[0].title, "[REDACTED]")
        XCTAssertEqual(results[0].snippet, "[REDACTED]")
        XCTAssertFalse(results.joinedDescription.contains(credential))
    }

    func testFiltersUnselectedCredentialReadAtRuntimeFromEveryProviderField() async throws {
        let selected = "selected-brave-runtime-credential"
        let unselected = "unselected-exa-runtime-credential"
        let credentials = ResearchCredentialState([
            CredentialProvider.brave.service: selected,
            CredentialProvider.exa.service: unselected
        ])
        let requests = ResearchRequestCounter()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            requests.increment()
            let reflected = credentials.value(for: CredentialProvider.exa.service) ?? "missing"
            let body = """
            {"web":{"results":[
              {"title":"runtime \(reflected)","url":"https://example.com/?token=\(reflected)","description":"drop"},
              {"title":"runtime \(reflected)","url":"https://example.com/safe","description":"runtime \(reflected)"}
            ]}}
            """
            return (jsonResponse(for: request), Data(body.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { credentials.value(for: $0) },
            credentialServiceCatalog: { [CredentialProvider.brave.service, CredentialProvider.exa.service] }
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "Never send \(unselected)", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .unsafeQuery)
        }
        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "Never send \(selected)", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .unsafeQuery)
        }
        XCTAssertEqual(requests.value, 0)
        let results = try await client.search(provider: "brave", query: "cross-provider runtime", limit: 5)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].url, "https://example.com/safe")
        XCTAssertEqual(results[0].title, "runtime [REDACTED]")
        XCTAssertEqual(results[0].snippet, "runtime [REDACTED]")
        XCTAssertFalse(results.joinedDescription.contains(unselected))
        XCTAssertEqual(requests.value, 1)

        let rotated = "rotated-exa-runtime-credential"
        credentials.set(rotated, for: CredentialProvider.exa.service)
        let rotatedResults = try await client.search(provider: "brave", query: "runtime rotation", limit: 5)
        XCTAssertEqual(rotatedResults.count, 1)
        XCTAssertFalse(rotatedResults.joinedDescription.contains(rotated))
        XCTAssertEqual(rotatedResults[0].title, "runtime [REDACTED]")
        XCTAssertEqual(requests.value, 2)
    }

    func testFiltersHistoricalCustomCredentialAndFailsClosedForInvalidRegistry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let historicalService = "com.barnlabs.LightningLoop.provider.custom.old-lab.inference.example.com.apiKey"
        let registryURL = root.appendingPathComponent("custom-credential-services.json")
        try JSONEncoder().encode([historicalService]).write(to: registryURL, options: .atomic)
        let registry = CustomCredentialServiceRegistry(fileURL: registryURL)
        let historical = "historical-native-custom-credential"
        let selected = "selected-native-firecrawl-credential"
        let requests = ResearchRequestCounter()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            requests.increment()
            let body = """
            {"id":"\(historical)","data":{"web":[
              {"title":"\(historical)","url":"https://example.com/safe","description":"\(historical)"},
              {"title":"drop","url":"https://example.com/?key=\(historical)","description":"drop"}
            ]}}
            """
            return (jsonResponse(for: request), Data(body.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { service in
                if service == CredentialProvider.firecrawl.service { return selected }
                if service == historicalService { return historical }
                return nil
            },
            credentialServiceCatalog: {
                try CredentialServiceCatalog.services(activeProfile: .onboarding, registry: registry)
            }
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "firecrawl", query: "Never send \(historical)", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .unsafeQuery)
        }
        await XCTAssertThrowsErrorAsync(try await client.search(provider: "firecrawl", query: "Never send \(selected)", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .unsafeQuery)
        }
        XCTAssertEqual(requests.value, 0)
        let results = try await client.search(provider: "firecrawl", query: "historical filtering", limit: 5)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].title, "[REDACTED]")
        XCTAssertEqual(results[0].snippet, "[REDACTED]")
        XCTAssertFalse(results.joinedDescription.contains(historical))
        XCTAssertEqual(requests.value, 1)

        try Data("not-json".utf8).write(to: registryURL, options: .atomic)
        let requestsBeforeFailure = ResearchRequestCounter()
        ResearchURLProtocol.handler = { request in
            requestsBeforeFailure.increment()
            return (jsonResponse(for: request), Data(#"{"data":{"web":[]}}"#.utf8))
        }
        await XCTAssertThrowsErrorAsync(try await client.search(provider: "firecrawl", query: "fail closed", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .credentialSafetyUnavailable)
        }
        XCTAssertEqual(requestsBeforeFailure.value, 0)
    }

    func testRejectsRecognizedSecretShapedQueriesWithoutRewritingOrSending() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        let requests = ResearchRequestCounter()
        ResearchURLProtocol.handler = { request in
            requests.increment()
            return (jsonResponse(for: request), Data(#"{"web":{"results":[]}}"#.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { service in
                service == CredentialProvider.brave.service ? "ordinary-selected-credential-778899" : nil
            },
            credentialServiceCatalog: testCredentialServiceCatalog
        )

        for query in [
            "api_key=abcdefghijklmnop",
            "Bearer abcdefghijklmnop",
            "csk-abcdefghijklmnop",
            "github_pat_abcdefghijklmnop",
            "brave: abcdefghijklmnop"
        ] {
            await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: query, limit: 1)) {
                XCTAssertEqual($0 as? ResearchClientError, .unsafeQuery, query)
            }
        }
        XCTAssertEqual(requests.value, 0)
    }

    func testRedactsRepeatedlyEncodedProviderDateBeforeContext() async throws {
        let credential = "synthetic-date-credential"
        let encoded = percentEncode(credential, layers: 17)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            let body = """
            {"results":[{"title":"Official", "url":"https://example.com/release", "highlights":["Verified"], "publishedDate":"2026-07-20 \(encoded)"}]}
            """
            return (jsonResponse(for: request), Data(body.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in credential },
            credentialServiceCatalog: testCredentialServiceCatalog
        )

        let results = try await client.search(provider: "exa", query: "release", limit: 1)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].publishedAt, "[REDACTED]")
        XCTAssertFalse(results.joinedDescription.contains(credential))
    }

    func testStreamingLimitAcceptsResponseExactlyAtBoundAcrossChunks() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        let body = Data(#"{"web":{"results":[]}}"#.utf8)
        ResearchURLProtocol.chunkedHandler = { request in
            let split = body.count / 2
            return (
                jsonResponse(for: request),
                [Data(body.prefix(split)), Data(body.suffix(body.count - split))]
            )
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "synthetic-boundary-credential" },
            credentialServiceCatalog: testCredentialServiceCatalog,
            maximumResponseBytes: body.count
        )

        let results = try await client.search(provider: "brave", query: "exact boundary", limit: 1)
        XCTAssertEqual(results, [])
    }

    func testStreamingLimitStopsAtFirstByteBeyondBoundAcrossChunks() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        let prefix = Data(#"{"web":{"results":[]}}"#.utf8)
        let limit = prefix.count + 4
        ResearchURLProtocol.chunkedHandler = { request in
            (
                jsonResponse(for: request),
                [prefix, Data(repeating: 0x20, count: 4), Data([0x20])]
            )
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "synthetic-stream-credential" },
            credentialServiceCatalog: testCredentialServiceCatalog,
            maximumResponseBytes: limit
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "bounded stream", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .responseTooLarge)
        }
    }

    func testRejectsDeclaredOversizeBeforeReadingBody() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "Content-Type": "application/json",
                    "Content-Length": "33"
                ]
            )!
            return (response, Data())
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "synthetic-length-credential" },
            credentialServiceCatalog: testCredentialServiceCatalog,
            maximumResponseBytes: 32
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "declared length", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .responseTooLarge)
        }
    }

    func testRejectsAmbiguousJSONMediaTypeBeforeDecoding() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json, text/html"]
            )!
            return (response, Data(#"{"web":{"results":[]}}"#.utf8))
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "synthetic-content-type-credential" },
            credentialServiceCatalog: testCredentialServiceCatalog
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "media type", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .invalidResponse("brave"))
        }
    }

    func testRejectsRedirectResponseWithoutFollowingLocation() async {
        let recorder = URLRequestRecorder()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchURLProtocol.self]
        ResearchURLProtocol.handler = { request in
            recorder.record(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 302,
                httpVersion: nil,
                headerFields: [
                    "Content-Type": "application/json",
                    "Location": "https://attacker.invalid/collect"
                ]
            )!
            return (response, Data())
        }
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "synthetic-redirect-credential" },
            credentialServiceCatalog: testCredentialServiceCatalog
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "redirect", limit: 1)) {
            XCTAssertEqual($0 as? ResearchClientError, .server(provider: "brave", status: 302))
        }
        XCTAssertEqual(recorder.request()?.url?.host, "api.search.brave.com")
    }

    func testAbsoluteDeadlineCancelsAStalledBody() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StallingResearchURLProtocol.self]
        let client = ResearchClient(
            session: URLSession(configuration: configuration),
            credentialReader: { _ in "synthetic-deadline-credential" },
            credentialServiceCatalog: testCredentialServiceCatalog,
            responseDeadlineNanoseconds: 20_000_000
        )

        await XCTAssertThrowsErrorAsync(try await client.search(provider: "brave", query: "deadline", limit: 1)) {
            XCTAssertEqual(($0 as? URLError)?.code, .timedOut)
        }
    }
}

private let testCredentialServiceCatalog: @Sendable () throws -> [String] = {
    CredentialProvider.allCases.map(\.service)
}

private extension Array where Element == ResearchSource {
    var joinedDescription: String {
        map { "\($0.title) \($0.url) \($0.snippet) \($0.publishedAt ?? "")" }.joined(separator: "\n")
    }
}

private func percentEncode(_ value: String, layers: Int) -> String {
    (0..<layers).reduce(value) { encoded, _ in
        encoded.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
    }
}

private final class URLRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: URLRequest?

    func record(_ request: URLRequest) { lock.withLock { stored = request } }
    func request() -> URLRequest? { lock.withLock { stored } }
}

private final class ResearchCredentialState: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    init(_ values: [String: String]) { self.values = values }
    func value(for service: String) -> String? { lock.withLock { values[service] } }
    func set(_ value: String, for service: String) { lock.withLock { values[service] = value } }
}

private final class ResearchRequestCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

private final class ResearchURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var chunkedHandler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, [Data]))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            if let chunkedHandler = Self.chunkedHandler {
                let (response, chunks) = try chunkedHandler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                for chunk in chunks {
                    client?.urlProtocol(self, didLoad: chunk)
                }
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class StallingResearchURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didReceive: jsonResponse(for: request), cacheStoragePolicy: .notAllowed)
    }

    override func stopLoading() {}
}

private func jsonResponse(for request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json; charset=utf-8"]
    )!
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in },
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected expression to throw", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
