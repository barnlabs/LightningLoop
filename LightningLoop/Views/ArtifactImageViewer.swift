import AppKit
import SwiftUI

struct ArtifactImageViewer: View {
    let title: String
    let evidence: ArtifactCurrentEvidence
    var compare: ArtifactCurrentEvidence? = nil

    @State private var scale: CGFloat = 1
    @State private var showsCompare = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(title, systemImage: "photo")
                    .font(.headline)
                Spacer()
                if ArtifactViewerPolicy.canRender(evidence.state), compare.map({ ArtifactViewerPolicy.canRender($0.state) }) == true {
                    Toggle("Compare", isOn: $showsCompare)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .accessibilityIdentifier("evidence.image.compare")
                }
            }
            if ArtifactViewerPolicy.canRender(evidence.state),
               let data = evidence.data,
               let image = NSImage(data: data) {
                if showsCompare, let compare, let compareData = compare.data, let before = NSImage(data: compareData) {
                    HStack(spacing: 10) {
                        zoomable(before, caption: "Before")
                        zoomable(image, caption: "After")
                    }
                } else {
                    zoomable(image, caption: nil)
                }
            } else {
                Label(ArtifactViewerPolicy.refusal(for: evidence.state), systemImage: "eye.slash")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("evidence.image.withheld")
            }
        }
        .accessibilityIdentifier("evidence.image.viewer")
    }

    private func zoomable(_ image: NSImage, caption: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let caption {
                Text(caption).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .frame(maxWidth: .infinity, maxHeight: 520)
                    .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .gesture(
                        MagnificationGesture().onChanged { value in
                            scale = min(4, max(1, value))
                        }
                    )
            }
            .frame(minHeight: 180, maxHeight: 540)
            HStack {
                Text("Zoom \(String(format: "%.1f", Double(scale)))×")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Reset") { scale = 1 }
                    .controlSize(.small)
            }
        }
    }
}
