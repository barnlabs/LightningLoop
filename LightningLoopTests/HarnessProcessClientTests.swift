import XCTest
@testable import LightningLoop

final class HarnessProcessClientTests: XCTestCase {
    func testNormalAppLaunchSearchesTheUserLocalTUIInstall() {
        let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
        XCTAssertEqual(
            HarnessProcessClient.installedHarnessRoot(homeDirectory: home).path,
            "/Users/example/.local/lib/node_modules/@barnlabs/lightningloop-harness"
        )
    }

    func testNormalAppLaunchUsesDeterministicFinderLaunchableNodeCandidates() {
        let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
        XCTAssertEqual(
            HarnessProcessClient.nodeCandidates(environment: [:], homeDirectory: home).map(\.path),
            [
                "/Users/example/.local/node/bin/node",
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node"
            ]
        )
        XCTAssertEqual(
            HarnessProcessClient.nodeCandidates(
                environment: ["LIGHTNINGLOOP_NODE_PATH": "/tmp/development-node"],
                homeDirectory: home
            ).first?.path,
            "/tmp/development-node"
        )
    }

    func testHarnessDiscoveryRequiresLockedPackageShape() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("dist/cli", isDirectory: true), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("node_modules/@earendil-works/pi-coding-agent", isDirectory: true), withIntermediateDirectories: true)
        try Data("{\"name\":\"@barnlabs/lightningloop-harness\",\"private\":true}".utf8)
            .write(to: root.appendingPathComponent("package.json"))
        try Data("process.exit(0);".utf8).write(to: root.appendingPathComponent("dist/cli/index.js"))
        let client = try XCTUnwrap(
            HarnessProcessClient.discover(environment: [:], rootCandidates: [root]),
            "A private package with the locked harness shape should be discoverable."
        )
        _ = client

        try Data("{\"name\":\"untrusted\",\"private\":true}".utf8)
            .write(to: root.appendingPathComponent("package.json"))
        XCTAssertNil(HarnessProcessClient.discover(environment: [:], rootCandidates: [root]))
    }

    func testArtifactReportAndLegacySessionFieldsDecodeWithoutWeakeningDefaults() throws {
        let reportJSON = """
        {"enabled":true,"passed":true,"summary":"Verified","files":[{"path":"app.js","bytes":4,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"commands":[],"workspaceAudit":{"passed":true,"files":1,"bytes":4,"message":"Confined"}}
        """
        let report = try JSONDecoder().decode(ArtifactExecutionReport.self, from: Data(reportJSON.utf8))
        XCTAssertTrue(report.passed)
        XCTAssertEqual(report.files.first?.path, "app.js")

        let legacy = LoopSession()
        let encoded = try JSONEncoder().encode(legacy)
        let decoded = try JSONDecoder().decode(LoopSession.self, from: encoded)
        XCTAssertNil(decoded.artifactWorkspacePath)
        XCTAssertNil(decoded.artifactVerificationCommands)
        XCTAssertNil(decoded.artifactReport)
    }
}
