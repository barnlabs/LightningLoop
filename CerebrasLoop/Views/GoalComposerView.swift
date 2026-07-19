import SwiftUI

struct GoalComposerView: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                GoalHeroView()
                GoalInputCard(model: model, session: session)
                PipelineOverviewView()
            }
            .frame(maxWidth: 880)
            .padding(.horizontal, 36)
            .padding(.bottom, 36)
            .padding(.top, 76)
            .frame(maxWidth: .infinity)
        }
    }
}

private struct GoalHeroView: View {
    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            LoopLogo(size: 72)
            VStack(alignment: .leading, spacing: 5) {
                Text("CerebrasLoop")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                Text("Small-model speed, disciplined into a gold-standard result.")
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
        .scrollContentBackground(.hidden)
        .frame(minHeight: 150)
        .padding(10)
        .background(.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .topLeading) {
            if session.goal.isEmpty {
                Text("Describe a result, request, or artifact. Include context you already know; the orchestrator will ask only what matters.")
                    .foregroundStyle(.tertiary)
                    .padding(16)
                    .allowsHitTesting(false)
            }
        }
    }

    private var actions: some View {
        HStack {
            if !model.hasAPIKey {
                Label("API key required", systemImage: "key")
                    .font(.caption)
                    .foregroundStyle(.orange)
                SettingsLink { Text("Open Settings") }
            }
            Spacer()
            Button {
                model.startClarification()
            } label: {
                Label("Ask Clarifying Questions", systemImage: "arrow.right")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(goalIsEmpty || !model.hasAPIKey)
        }
    }

    private var goalIsEmpty: Bool {
        session.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct PipelineOverviewView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("THE LOOP")
                .font(.caption.weight(.bold))
                .tracking(1.6)
                .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 10) {
                PipelineStep(number: 1, title: "Clarify", detail: "Turn intent into criteria", role: .orchestrator)
                PipelineArrow()
                PipelineStep(number: 2, title: "Challenge", detail: "Reject weak plans", role: .reviewer)
                PipelineArrow()
                PipelineStep(number: 3, title: "Implement", detail: "Produce the artifact", role: .implementer)
                PipelineArrow()
                PipelineStep(number: 4, title: "Loop", detail: "Fix until gold", role: .reviewer)
            }
        }
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
