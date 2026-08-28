import XCTest
@testable import LightningLoop

final class KeychainStoreTests: XCTestCase {
    func testRuntimeManagedProfileErrorUsesProductLanguage() {
        let description = KeychainStoreError.piManagedProfile.errorDescription ?? ""

        XCTAssertTrue(description.contains("managed by the LightningLoop runtime"))
        XCTAssertTrue(description.contains("provider sign-in"))
        XCTAssertNil(description.range(of: "\\bpi\\b", options: [.regularExpression, .caseInsensitive]))
    }

    func testPresenceAndReadQueriesFailClosedInsteadOfPrompting() {
        let query = KeychainStore.nonInteractiveQuery(
            service: "com.barnlabs.LightningLoop.search.firecrawl",
            account: "lightningloop-test",
            returnData: false
        )
        XCTAssertEqual(query[kSecUseAuthenticationUI as String] as? String, kSecUseAuthenticationUIFail as String)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "com.barnlabs.LightningLoop.search.firecrawl")
        XCTAssertNil(query[kSecReturnData as String])

        let read = KeychainStore.nonInteractiveQuery(
            service: "com.barnlabs.LightningLoop.search.exa",
            account: "lightningloop-test",
            returnData: true
        )
        XCTAssertEqual(read[kSecUseAuthenticationUI as String] as? String, kSecUseAuthenticationUIFail as String)
        XCTAssertEqual(read[kSecReturnData as String] as? Bool, true)

        XCTAssertTrue(KeychainStore.isNonInteractiveDenial(errSecInteractionNotAllowed))
        XCTAssertFalse(KeychainStore.isNonInteractiveDenial(errSecSuccess))
    }
}
