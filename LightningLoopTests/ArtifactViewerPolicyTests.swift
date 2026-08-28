import XCTest
@testable import LightningLoop

final class ArtifactViewerPolicyTests: XCTestCase {
    func testClassifiesImageAndMeshExtensionsWithoutTrustingBytes() {
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "proof/preview.png"), .image)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "shot.JPEG"), .image)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "mesh/model.obj"), .sceneKitModel)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "asset.usdz"), .sceneKitModel)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "out/model.glb"), .glbOrGltf)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "out/model.gltf"), .glbOrGltf)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "notes.md"), .none)
        XCTAssertEqual(ArtifactViewerPolicy.kind(forRelativePath: "binary.stl"), .none)
    }

    func testOnlyVerifiedEvidenceMayRender() {
        XCTAssertTrue(ArtifactViewerPolicy.canRender(.verified))
        for state: ArtifactCurrentEvidenceState in [.failed, .unavailable, .tampered, .unreadable] {
            XCTAssertFalse(ArtifactViewerPolicy.canRender(state), "\(state) must not render")
            XCTAssertTrue(ArtifactViewerPolicy.refusal(for: state).localizedCaseInsensitiveContains("withheld")
                || ArtifactViewerPolicy.refusal(for: state).localizedCaseInsensitiveContains("decoded"))
        }
    }
}

final class DesignedCopyTests: XCTestCase {
    func testBrandAndHonestyCopyStayProductFirst() {
        XCTAssertEqual(DesignedCopy.tagline, "Fast models. Strict evidence.")
        XCTAssertEqual(DesignedCopy.productName, "LightningLoop")
        XCTAssertTrue(DesignedCopy.unverifiedBytes.localizedCaseInsensitiveContains("never shown"))
        XCTAssertTrue(DesignedCopy.keyNeverEchoed.localizedCaseInsensitiveContains("never shown"))
        XCTAssertTrue(DesignedCopy.keyNeverEchoed.contains("provider.json"))
        XCTAssertTrue(DesignedCopy.justFreeDetail.localizedCaseInsensitiveContains("never invents"))
        for sample in [
            DesignedCopy.noLoopSelectedTitle,
            DesignedCopy.emptyLoopsTitle,
            DesignedCopy.browserEmptyTitle,
            DesignedCopy.emptyReviewsDetail
        ] {
            XCTAssertNil(sample.range(of: "\\bpi\\b", options: [.regularExpression, .caseInsensitive]))
        }
    }

    func testLongHistoryFilterIsCaseInsensitiveAndEmptyQueryShowsAll() {
        let alpha = LoopSession(goal: "Alpha launch brief")
        let beta = LoopSession(goal: "Beta review packet")
        XCTAssertEqual(LoopHistoryFilter.visible(sessions: [alpha, beta], query: "").map(\.title), [alpha.title, beta.title])
        XCTAssertEqual(LoopHistoryFilter.visible(sessions: [alpha, beta], query: "  ALPHA  ").map(\.title), [alpha.title])
        XCTAssertTrue(LoopHistoryFilter.visible(sessions: [alpha, beta], query: "zzz").isEmpty)
    }
}
