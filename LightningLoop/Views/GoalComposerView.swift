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
                PipelineOverviewView()
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
                Text("Fast inference, disciplined into a gold-standard result.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
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
            if let readinessMessage = model.loopReadinessMessage {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "bolt.slash.fill")
                        .font(.title3)
                        .foregroundStyle(.orange)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Setup needed before this loop can run")
                            .font(.subheadline.weight(.semibold))
                        Text(readinessMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    SettingsLink {
                        Text("Open Settings")
                    }
                    .controlSize(.large)
                    .accessibilityIdentifier("open.settings.readiness")
                }
                .padding(12)
                .background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(.orange.opacity(0.22))
                }
            }

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

private struct PipelineOverviewView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("THE LOOP")
                .font(.caption.weight(.bold))
                .tracking(1.6)
                .foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 10) {
                    steps(showArrows: true)
                }
                VStack(spacing: 8) {
                    steps(showArrows: false)
                }
            }
        }
        .accessibilityIdentifier("pipeline.overview")
    }

    @ViewBuilder private func steps(showArrows: Bool) -> some View {
        PipelineStep(number: 1, title: "Clarify", detail: "Turn intent into criteria", role: .orchestrator)
        if showArrows { PipelineArrow() }
        PipelineStep(number: 2, title: "Challenge", detail: "Reject weak plans", role: .reviewer)
        if showArrows { PipelineArrow() }
        PipelineStep(number: 3, title: "Implement", detail: "Produce the artifact", role: .implementer)
        if showArrows { PipelineArrow() }
        PipelineStep(number: 4, title: "Loop", detail: "Fix until gold", role: .reviewer)
    }
}

private struct PipelineStep: View {
    let number: Int
    let title: String
    let detail: String
    let role: AgentRole

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(number)")
                    .font(.caption.bold())
                    .frame(width: 22, height: 22)
                    .background(LoopBrand.blue.opacity(0.14), in: Circle())
                Image(systemName: role.symbol)
                    .foregroundStyle(role == .reviewer ? LoopBrand.gold : LoopBrand.blue)
            }
            Text(title).font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 86, alignment: .topLeading)
        .padding(14)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct PipelineArrow: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .foregroundStyle(.tertiary)
            .padding(.top, 34)
    }
}
