import AppKit
import SwiftUI

struct GoalComposerView: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                GoalHeroView()
                GoalInputCard(model: model, session: session)
                ArtifactModeCard(model: model, session: session)
            }
            .frame(maxWidth: 880)
            .padding(.horizontal, 36)
            .padding(.bottom, 36)
            .padding(.top, 34)
            .frame(maxWidth: .infinity)
        }
    }
}

private struct GoalHeroView: View {
    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            LoopLogo(size: 72)
            VStack(alignment: .leading, spacing: 5) {
                Text("LightningLoop")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .accessibilityIdentifier("lightningloop.hero.title")
                Text(DesignedCopy.tagline)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("lightningloop.hero.tagline")
                BarnLabsWordmark()
                    .padding(.top, 3)
            }
        }
    }
}

private struct GoalInputCard: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("What should the loop accomplish?")
                    .font(.title3.weight(.semibold))
                editor
                AttachmentStrip(model: model, session: session)
                actions
            }
        }
    }

    private var editor: some View {
        TextEditor(text: Binding<String>(
            get: { session.goal },
            set: { value in model.updateGoal(value) }
        ))
        .font(.body)
        .accessibilityLabel("Goal")
        .accessibilityIdentifier("goal.editor")
        .scrollContentBackground(.hidden)
        .frame(minHeight: 150)
        .padding(10)
        .background(.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .topLeading) {
            if session.goal.isEmpty {
                Text("Describe a result, request, or artifact. Include context you already know; the orchestrator will ask only what matters.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .padding(16)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("goal.editor.guidance")
            }
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            ProviderStatusBanner(model: model)

            HStack {
                if !session.attachments.isEmpty && !model.providerProfile.supportsImages {
                    Label("Selected model is text-only", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Spacer()
                Button {
                    model.startClarification()
                } label: {
                    Label("Ask Clarifying Questions", systemImage: "arrow.right")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("start.clarification")
                .disabled(goalIsEmpty || !model.hasAPIKey || (!session.attachments.isEmpty && !model.providerProfile.supportsImages))
            }
        }
    }

    private var goalIsEmpty: Bool {
        session.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct AttachmentStrip: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label("Source images", systemImage: "photo.on.rectangle.angled")
                    .font(.subheadline.weight(.semibold))
                Text("\(session.attachments.count)/4")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Button { model.chooseImages() } label: { Label("Attach Images", systemImage: "plus") }
                    .disabled(session.attachments.count >= 4)
                    .accessibilityIdentifier("attach.images")
            }
            if session.attachments.isEmpty {
                Text("Optional. PNG, JPEG, WebP, or GIF · 10 MB each. Every agent sees the same visual evidence.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(session.attachments) { attachment in
                            AttachmentChip(attachment: attachment) { model.removeAttachment(attachment.id) }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
        .padding(12)
        .background(LoopBrand.mint.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ArtifactModeCard: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Output mode", systemImage: "folder.badge.gearshape")
                        .font(.headline)
                    Spacer()
                    Text(session.artifactWorkspacePath == nil ? "TEXT ONLY" : "WORKSPACE ARTIFACTS")
                        .font(.caption2.bold())
                        .tracking(0.8)
                        .foregroundStyle(session.artifactWorkspacePath == nil ? .secondary : LoopBrand.mint)
                }

                if let path = session.artifactWorkspacePath {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(URL(fileURLWithPath: path).lastPathComponent, systemImage: "folder.fill")
                            .font(.subheadline.weight(.semibold))
                        Text(path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(2)
                        Toggle("Run tests, scripts, and static picture capture in the confined evidence lab", isOn: Binding(
                            get: { session.artifactVerificationCommands == true },
                            set: { model.setArtifactVerificationCommands($0) }
                        ))
                        .accessibilityIdentifier("artifact.verification.toggle")
                        Text(session.artifactVerificationCommands == true
                             ? "The harness may run bounded checks, serve HTML briefly on 127.0.0.1, and capture preview evidence. Home reads, external network, ambient credentials, and outside writes remain denied."
                             : "The implementer may create and revise bounded UTF-8 files. Code execution and HTML rendering remain off.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("Choose Different Directory", action: model.chooseArtifactWorkspace)
                            Button("Return to Text Only", role: .destructive, action: model.clearArtifactWorkspace)
                        }
                    }
                } else {
                    Text(model.supportsWorkspaceArtifacts
                         ? "Default: return reviewed text or Markdown. Choose a dedicated empty directory to let the same strict loop create real files without touching existing work."
                         : "Workspace artifacts require the shared local harness. This runtime remains safely text-only.")
                        .foregroundStyle(.secondary)
                    Button(action: model.chooseArtifactWorkspace) {
                        Label("Choose Empty Output Directory", systemImage: "folder.badge.plus")
                    }
                    .disabled(!model.supportsWorkspaceArtifacts)
                    .accessibilityIdentifier("artifact.workspace.choose")
                }
            }
        }
    }
}

private struct AttachmentChip: View {
    let attachment: ImageAttachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if let image = NSImage(contentsOf: attachment.fileURL) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 42, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.displayName).lineLimit(1).frame(maxWidth: 150, alignment: .leading)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Remove app copy; the original image is unchanged")
        }
        .padding(7)
        .background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
    }
}
