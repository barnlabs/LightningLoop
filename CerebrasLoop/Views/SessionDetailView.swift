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
        VStack(spacing: 18) {
            LoopLogo(size: 82)
            ProgressView()
                .controlSize(.large)
            Text(session.statusMessage)
                .font(.title3.weight(.semibold))
            Text("Gemma 4 31B is running on Cerebras. This usually moves quickly.")
                .foregroundStyle(.secondary)
            Button("Cancel", action: cancel)
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
