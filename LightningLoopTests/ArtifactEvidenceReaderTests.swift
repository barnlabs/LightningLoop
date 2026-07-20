import CryptoKit
import Foundation
import XCTest
@testable import LightningLoop

final class ArtifactEvidenceReaderTests: XCTestCase {
    func testPassedReportDowngradesForChangedSTLAndMissingBlendManifestFiles() throws {
        let workspace = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let stlPath = "model.stl"
        let blendPath = "scene.blend"
        let stlURL = workspace.appendingPathComponent(stlPath)
        let blendURL = workspace.appendingPathComponent(blendPath)
        let reviewedSTL = Data("solid reviewed\nendsolid reviewed\n".utf8)
        let reviewedBlend = Data([0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52, 0x2d, 0x76, 0x31])
        try reviewedSTL.write(to: stlURL)
        try reviewedBlend.write(to: blendURL)
        let report = ArtifactExecutionReport(
            enabled: true,
            passed: true,
            summary: "Persisted report passed",
            files: [
                .init(path: stlPath, bytes: reviewedSTL.count, sha256: sha256(reviewedSTL)),
                .init(path: blendPath, bytes: reviewedBlend.count, sha256: sha256(reviewedBlend))
            ],
            commands: [],
            previews: [],
            workspaceAudit: .init(
                passed: true,
                files: 2,
                bytes: reviewedSTL.count + reviewedBlend.count,
                message: "Passed"
            )
        )
        let reader = ArtifactEvidenceReader(workspacePath: workspace.path)

        XCTAssertEqual(reader.reportState(report, sourcePaths: []), .verified)

        var changedSTL = reviewedSTL
        changedSTL[changedSTL.startIndex] ^= 0x01
        try changedSTL.write(to: stlURL)
        XCTAssertEqual(
            reader.reportState(report, sourcePaths: []),
            .tampered,
            "A changed non-preview STL must revoke the report's current VERIFIED state."
        )

        try reviewedSTL.write(to: stlURL)
        try FileManager.default.removeItem(at: blendURL)
        XCTAssertEqual(
            reader.reportState(report, sourcePaths: []),
            .unavailable,
            "A missing non-preview Blender file must revoke the report's current VERIFIED state."
        )
    }

    func testPassedPictureEvidenceBecomesTamperedThenUnavailableWhenWorkspaceBytesChange() throws {
        let workspace = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let path = "proof.png"
        let url = workspace.appendingPathComponent(path)
        let reviewedPNG = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        try reviewedPNG.write(to: url)
        let reader = ArtifactEvidenceReader(workspacePath: workspace.path)
        let report = ArtifactExecutionReport(
            enabled: true,
            passed: true,
            summary: "Persisted report passed",
            files: [.init(path: path, bytes: reviewedPNG.count, sha256: sha256(reviewedPNG))],
            commands: [],
            previews: [.init(
                kind: "html",
                title: "Proof",
                sourcePath: "index.html",
                previewPath: path,
                mimeType: "image/png",
                passed: true,
                message: "Persisted preview passed",
                width: 1,
                height: 1,
                loopback: nil
            )],
            workspaceAudit: .init(passed: true, files: 1, bytes: reviewedPNG.count, message: "Passed")
        )

        XCTAssertEqual(reader.reportState(report, sourcePaths: []), .verified)

        try Data("replaced after the report passed".utf8).write(to: url)
        XCTAssertEqual(reader.reportState(report, sourcePaths: []), .tampered)

        try FileManager.default.removeItem(at: url)
        XCTAssertEqual(reader.reportState(report, sourcePaths: []), .unavailable)
    }

    func testHashMatchingUndecodablePictureIsNeverVerifiedForDisplay() throws {
        let workspace = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let bytes = Data("not an image".utf8)
        try bytes.write(to: workspace.appendingPathComponent("proof.png"))

        let result = ArtifactEvidenceReader(workspacePath: workspace.path).inspect(
            relativePath: "proof.png",
            expectedSHA256: sha256(bytes),
            requireDecodableImage: true
        )
        XCTAssertEqual(result.state, .unreadable)
        XCTAssertNil(result.data)
    }

    func testSourceInspectionWithholdsPostReviewMutation() throws {
        let workspace = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let path = "main.ts"
        let url = workspace.appendingPathComponent(path)
        let reviewed = Data("export const reviewed = true;\n".utf8)
        try reviewed.write(to: url)
        let reader = ArtifactEvidenceReader(workspacePath: workspace.path)
        let report = ArtifactExecutionReport(
            enabled: true,
            passed: true,
            summary: "Persisted report passed",
            files: [.init(path: path, bytes: reviewed.count, sha256: sha256(reviewed))],
            commands: [],
            previews: [],
            workspaceAudit: .init(passed: true, files: 1, bytes: reviewed.count, message: "Passed")
        )

        let verified = reader.inspect(
            relativePath: path,
            expectedSHA256: sha256(reviewed),
            maximumBytes: 524_288,
            requireUTF8Text: true
        )
        XCTAssertEqual(verified.state, .verified)
        XCTAssertEqual(verified.data, reviewed)
        XCTAssertEqual(reader.reportState(report, sourcePaths: [path]), .verified)

        try Data("export const injected = true;\n".utf8).write(to: url)
        let stale = reader.inspect(
            relativePath: path,
            expectedSHA256: sha256(reviewed),
            maximumBytes: 524_288,
            requireUTF8Text: true
        )
        XCTAssertEqual(stale.state, .tampered)
        XCTAssertNil(stale.data, "Post-review source bytes must not be returned for display.")
        XCTAssertEqual(reader.reportState(report, sourcePaths: [path]), .tampered)
    }

    private func makeWorkspace() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
