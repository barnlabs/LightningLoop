import Foundation
import XCTest
@testable import LightningLoop

final class ProviderClientTests: XCTestCase {
    func testProviderErrorResponseNeverEchoesCredential() async throws {
        let credential = "synthetic-provider-credential"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try store.save(.preset(.custom))

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderURLProtocol.self]
        ProviderURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
            let body = "{\"error\":{\"message\":\"reflected \(credential)\"}}"
            return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let client = ProviderClient(
            profileStore: store,
            session: URLSession(configuration: configuration),
            credentialReader: { _ in credential }
        )

        await XCTAssertProviderThrowsAsync(try await client.complete(.init(messages: [.init(role: .user, content: "hello")])) ) { error in
            let description = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            XCTAssertFalse(description.contains(credential))
            XCTAssertTrue(description.contains("HTTP 401"))
            XCTAssertTrue(description.contains("withheld"))
        }
    }

    func testEveryPiManagedBuiltInIsRejectedBeforeCredentialLookupOrNetwork() async throws {
        for preset in ProviderPreset.allCases
        where preset != .custom && preset != .generalcompute && preset != .openrouter && preset != .selectionRequired {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
            try store.save(.preset(preset))
            let credentialReads = LockedCounter()
            let networkRequests = LockedCounter()
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [ProviderURLProtocol.self]
            ProviderURLProtocol.handler = { request in
                networkRequests.increment()
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
            }
            let client = ProviderClient(
                profileStore: store,
                session: URLSession(configuration: configuration),
                credentialReader: { _ in credentialReads.increment(); return "must-not-be-read" }
            )

            await XCTAssertProviderThrowsAsync(try await client.complete(.init(messages: [.init(role: .user, content: "hello")]))) { error in
                XCTAssertEqual(error as? ProviderClientError, .piManagedProfile)
                let description = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                XCTAssertTrue(description.contains("managed by the LightningLoop runtime"))
                XCTAssertNil(description.range(of: "\\bpi\\b", options: [.regularExpression, .caseInsensitive]))
            }
            await XCTAssertProviderThrowsAsync(try await client.listModels()) { error in
                XCTAssertEqual(error as? ProviderClientError, .piManagedProfile)
                let description = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                XCTAssertTrue(description.contains("managed by the LightningLoop runtime"))
                XCTAssertNil(description.range(of: "\\bpi\\b", options: [.regularExpression, .caseInsensitive]))
            }
            XCTAssertEqual(credentialReads.value, 0, "\(preset.rawValue) reached native credential lookup")
            XCTAssertEqual(networkRequests.value, 0, "\(preset.rawValue) reached native networking")
        }
    }

    func testGeneralComputeNativeListModelsIsAllowedWithFixedEndpoint() async throws {
        let credential = "synthetic-generalcompute-credential"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try store.save(.preset(.generalcompute))
        XCTAssertTrue(ProviderConfiguration.preset(.generalcompute).allowsNativeConnectionTesting)
        XCTAssertFalse(ProviderConfiguration.preset(.generalcompute).usesPiAuthentication)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderURLProtocol.self]
        ProviderURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://api.generalcompute.com/v1/models")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
            let body = #"{"object":"list","data":[{"id":"minimax-m2.7","object":"model"}]}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let client = ProviderClient(
            profileStore: store,
            session: URLSession(configuration: configuration),
            credentialReader: { _ in credential }
        )
        let models = try await client.listModels()
        XCTAssertEqual(models, ["minimax-m2.7"])
    }

    func testOpenRouterNativeListModelsIsAllowedWithFixedEndpoint() async throws {
        let credentialReads = LockedCounter()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try store.save(.preset(.openrouter))
        XCTAssertTrue(ProviderConfiguration.preset(.openrouter).allowsNativeConnectionTesting)
        XCTAssertFalse(ProviderConfiguration.preset(.openrouter).usesPiAuthentication)
        XCTAssertEqual(ProviderConfiguration.preset(.openrouter).freeOnly, true)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderURLProtocol.self]
        ProviderURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://openrouter.ai/api/v1/models")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body = #"{"object":"list","data":[{"id":"deepseek/deepseek-chat-v3-0324:free","object":"model"}]}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let client = ProviderClient(
            profileStore: store,
            session: URLSession(configuration: configuration),
            credentialReader: { _ in
                credentialReads.increment()
                return "must-not-be-read"
            }
        )
        let models = try await client.listModels()
        XCTAssertEqual(models, ["deepseek/deepseek-chat-v3-0324:free"])
        XCTAssertEqual(credentialReads.value, 0, "OpenRouter catalog load must not read a credential")
    }

    func testOpenRouterPublicCatalogDoesNotRequireAKey() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try store.save(.preset(.openrouter))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderURLProtocol.self]
        ProviderURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://openrouter.ai/api/v1/models")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body = #"{"object":"list","data":[{"id":"openrouter/free","object":"model"}]}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let client = ProviderClient(
            profileStore: store,
            session: URLSession(configuration: configuration),
            credentialReader: { _ in nil }
        )
        let models = try await client.listModels()
        XCTAssertEqual(models, ["openrouter/free"])
    }

    func testCustomSuccessRedactsExactCredentialBeforeReplyLeavesProviderClient() async throws {
        let credential = "plain-reflected-credential-without-a-known-prefix"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        try store.save(.preset(.custom))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderURLProtocol.self]
        ProviderURLProtocol.handler = { request in
            let body = #"{"model":"fixture \#(credential)","choices":[{"message":{"content":"before \#(credential) after"}}]}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let client = ProviderClient(
            profileStore: store,
            session: URLSession(configuration: configuration),
            credentialReader: { _ in credential }
        )

        let reply = try await client.complete(.init(messages: [.init(role: .user, content: "hello")]))
        XCTAssertEqual(reply.content, "before [REDACTED] after")
        XCTAssertFalse(reply.content.contains(credential))
        XCTAssertEqual(reply.model, "fixture [REDACTED]")

        ProviderURLProtocol.handler = { request in
            let body = #"{"data":[{"id":"model-\#(credential)"}]}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let models = try await client.listModels()
        XCTAssertEqual(models, ["model-[REDACTED]"])
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var value: Int { lock.withLock { storage } }
    @discardableResult func increment() -> Int { lock.withLock { storage += 1; return storage } }
}

private final class ProviderURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
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

private func XCTAssertProviderThrowsAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in },
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
