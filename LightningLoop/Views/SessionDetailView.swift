import SwiftUI

struct SessionDetailView: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        Group {
            switch session.stage {
            case .draft:
                GoalComposerView(model: model, session: session)
            case .clarifying:
                WorkingView(session: session, cancel: model.cancelCurrentOperation)
            case .awaitingAnswers:
                ClarificationView(model: model, session: session)
            default:
                LoopWorkspaceView(model: model, session: session)
            }
        }
        .background {
            LinearGradient(
                colors: [LoopBrand.blue.opacity(0.035), LoopBrand.gold.opacity(0.025), .clear],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }
}

private struct WorkingView: View {
    let session: LoopSession
    let cancel: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            LoopLogo(size: 76)
            VStack(spacing: 7) {
                Text("Clarifying the outcome")
                    .font(.title2.bold())
                Text("LightningLoop is isolating the few decisions that can change the result before it writes a plan.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)
            }
            SurfaceCard {
                HStack(spacing: 14) {
                    ProgressView()
                        .controlSize(.large)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.statusMessage)
                            .font(.headline)
                        Text("No percentage is shown because model and review work is non-linear. You can cancel safely at any time.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: 620)
            }
            Button("Cancel Run", action: cancel)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("cancel.current.run")
        }
        .padding(36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
