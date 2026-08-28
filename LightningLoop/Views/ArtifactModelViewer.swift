import SceneKit
import SceneKit.ModelIO
import SwiftUI

struct ArtifactModelViewer: View {
    let title: String
    let relativePath: String
    let evidence: ArtifactCurrentEvidence
    let fileURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: "cube.transparent")
                .font(.headline)
            Text(relativePath)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if ArtifactViewerPolicy.canRender(evidence.state), let fileURL {
                ArtifactSceneView(url: fileURL, kind: ArtifactViewerPolicy.kind(forRelativePath: relativePath))
                    .frame(minHeight: 280, maxHeight: 480)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityIdentifier("evidence.model.viewer")
            } else {
                Label(ArtifactViewerPolicy.refusal(for: evidence.state), systemImage: "eye.slash")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("evidence.model.withheld")
            }
            Text(DesignedCopy.unverifiedBytes)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ArtifactSceneView: NSViewRepresentable {
    let url: URL
    let kind: ArtifactViewerKind

    func makeNSView(context: Context) -> SCNView {
        let view = SCNView()
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.backgroundColor = NSColor.black.withAlphaComponent(0.18)
        view.scene = loadScene()
        return view
    }

    func updateNSView(_ view: SCNView, context: Context) {
        if view.scene == nil {
            view.scene = loadScene()
        }
    }

    private func loadScene() -> SCNScene {
        if let scene = try? SCNScene(url: url, options: nil) {
            return scene
        }
        let asset = MDLAsset(url: url)
        if asset.count > 0 {
            return SCNScene(mdlAsset: asset)
        }
        let placeholder = SCNScene()
        let text = SCNText(string: kind == .glbOrGltf
            ? "Bytes verified. Interactive GLB needs SceneKit/ModelIO on this Mac."
            : "Bytes verified. This mesh could not be loaded.", extrusionDepth: 0.4)
        text.font = NSFont.systemFont(ofSize: 2.2, weight: .medium)
        let node = SCNNode(geometry: text)
        node.position = SCNVector3(-8, 0, 0)
        placeholder.rootNode.addChildNode(node)
        return placeholder
    }
}
