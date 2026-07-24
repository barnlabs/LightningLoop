import XCTest
@testable import LightningLoop

final class KeychainStoreTests: XCTestCase {
    func testRuntimeManagedProfileErrorUsesProductLanguage() {
        let description = KeychainStoreError.piManagedProfile.errorDescription ?? ""

        XCTAssertTrue(description.contains("managed by the LightningLoop runtime"))
        XCTAssertTrue(description.contains("provider sign-in"))
        XCTAssertNil(description.range(of: "\\bpi\\b", options: [.regularExpression, .caseInsensitive]))
    }
}
