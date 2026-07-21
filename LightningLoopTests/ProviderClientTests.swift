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

    func testEveryBuiltInIsRejectedBeforeCredentialLookupOrNetwork() async throws {
        for preset in ProviderPreset.allCases where preset != .custom && preset != .selectionRequired {
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
            }
            await XCTAssertProviderThrowsAsync(try await client.listModels()) { error in
                XCTAssertEqual(error as? ProviderClientError, .piManagedProfile)
            }
            XCTAssertEqual(credentialReads.value, 0, "\(preset.rawValue) reached native credential lookup")
            XCTAssertEqual(networkRequests.value, 0, "\(preset.rawValue) reached native networking")
        }
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
