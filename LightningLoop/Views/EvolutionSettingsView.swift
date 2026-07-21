import SwiftUI

struct EvolutionSettingsView: View {
    let model: AppModel
    @State private var kind: EvolutionKind = .skill
    @State private var name = ""
    @State private var source = "User-provided"
    @State private var reason = ""
    @State private var exactDiff = ""
    @State private var pendingDeletion: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            GroupBox("Propose an evolution") {
                VStack(spacing: 9) {
                    HStack {
                        Picker("Kind", selection: $kind) {
                            ForEach(EvolutionKind.allCases) { Text($0.label).tag($0) }
                        }
                        TextField("Name", text: $name)
                        TextField("Source URL, path, or user-provided", text: $source)
                    }
                    TextField("Why this improves LightningLoop", text: $reason)
                    TextField("Exact proposed change or diff", text: $exactDiff, axis: .vertical)
                        .lineLimit(2...5)
                        .font(.system(.body, design: .monospaced))
                    HStack {
                        Text("Creating a proposal grants no permission and activates nothing.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Create Draft") {
                            model.addEvolution(kind: kind, name: name, source: source, reason: reason, exactDiff: exactDiff)
                            name = ""
                            reason = ""
                            exactDiff = ""
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || exactDiff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(6)
            }

            HStack {
                Text("Evolution ledger").font(.headline)
                Spacer()
                Text("\(model.evolutions.filter { $0.state == .active }.count) active · \(model.evolutions.count) total")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            if model.evolutions.isEmpty {
                ContentUnavailableView("No evolution proposals", systemImage: "arrow.triangle.2.circlepath", description: Text("System prompts, skills, tools, MCPs, and memory policy enter here as inert drafts."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(model.evolutions) { proposal in
                    EvolutionProposalRow(model: model, proposal: proposal, requestDeletion: { pendingDeletion = proposal.id })
                        .id("\(proposal.id)-\(proposal.state.rawValue)-\(proposal.evaluationSummary ?? "")")
                }
            }

            Text("Activation sequence: source review → sandbox evaluation → adversarial review → explicit user approval → active. Reviewed system-prompt addenda apply on the next agent call. Skills become guidance only; tools and MCPs remain separately integrity- and permission-gated.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .confirmationDialog("Delete this inert draft?", isPresented: Binding(
            get: { pendingDeletion != nil },
            set: { if !$0 { pendingDeletion = nil } }
        )) {
            Button("Delete Draft", role: .destructive) {
                if let pendingDeletion { model.deleteEvolutionDraft(pendingDeletion) }
                pendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { pendingDeletion = nil }
        }
    }
}

private struct EvolutionProposalRow: View {
    let model: AppModel
    let proposal: EvolutionProposal
    let requestDeletion: () -> Void
    @State private var evaluationSuite: String
    @State private var evaluationSummary: String
    @State private var rollbackTarget: String
    @State private var permissions: String
    @State private var materialFinding: Bool
    @State private var confirmsActivation = false
    @State private var expanded = false

    init(model: AppModel, proposal: EvolutionProposal, requestDeletion: @escaping () -> Void) {
        self.model = model
        self.proposal = proposal
        self.requestDeletion = requestDeletion
        _evaluationSuite = State(initialValue: proposal.evaluationSuite)
        _evaluationSummary = State(initialValue: proposal.evaluationSummary ?? "")
        _rollbackTarget = State(initialValue: proposal.rollbackTarget ?? "")
        _permissions = State(initialValue: proposal.permissions.joined(separator: ", "))
        _materialFinding = State(initialValue: proposal.reviewerHasMaterialFinding)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 9) {
                LabeledContent("Source", value: proposal.source)
                Text(proposal.reason).font(.caption)
                Text(proposal.exactDiff)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))

                TextField("Evaluation suite or command", text: $evaluationSuite)
                TextField("Evaluation result and evidence", text: $evaluationSummary, axis: .vertical)
                    .lineLimit(2...4)
                TextField("Rollback target or prior version", text: $rollbackTarget)
                TextField("Requested permissions, comma separated", text: $permissions)
                Toggle("Reviewer still has a high or blocking finding", isOn: $materialFinding)

                HStack {
                    Button("Save Evidence") {
                        model.updateEvolutionEvidence(
                            proposal.id,
                            evaluationSuite: evaluationSuite,
                            evaluationSummary: evaluationSummary,
                            rollbackTarget: rollbackTarget,
                            permissions: permissions,
                            reviewerHasMaterialFinding: materialFinding
                        )
                    }
                    .disabled(proposal.state == .active || proposal.state == .superseded || proposal.state == .rolledBack)

                    Spacer()
                    if proposal.state == .draft {
                        Button("Delete Draft", role: .destructive, action: requestDeletion)
                    }
                    if proposal.state != .rolledBack {
                        Button("Roll Back", role: .destructive) { model.rollBackEvolution(proposal.id) }
                    }
                    if let next = proposal.state.next {
                        Button(nextLabel(next)) {
                            if next == .active { confirmsActivation = true }
                            else { model.advanceEvolution(proposal.id) }
                        }
                        .buttonStyle(.bordered)
                        .tint(next == .active ? LoopBrand.mint : nil)
                    }
                }
                .controlSize(.small)
            }
            .padding(.top, 8)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(proposal.name).font(.headline)
                        Text(proposal.kind.label).font(.caption)
                    }
                    Text(proposal.reason.isEmpty ? "No rationale recorded" : proposal.reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(proposal.state.label)
                    .font(.caption.bold())
                    .foregroundStyle(proposal.state == .active ? LoopBrand.mint : .secondary)
            }
        }
        .padding(.vertical, 4)
        .confirmationDialog("Activate \(proposal.name)?", isPresented: $confirmsActivation) {
            Button("Activate Reviewed Evolution") { model.advanceEvolution(proposal.id) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(proposal.kind == .systemPrompt
                 ? "This reviewed addendum will affect future agent system prompts. Deterministic Gold and capability gates remain outside the prompt."
                 : "This records the proposal as active, but executable tools and MCPs still require their separate integrity and permission checks.")
        }
    }

    private func nextLabel(_ state: EvolutionState) -> String {
        switch state {
        case .sourceReviewed: "Mark Source Reviewed"
        case .sandboxTested: "Record Sandbox Pass"
        case .adversariallyReviewed: "Pass Adversarial Review"
        case .userApproved: "Approve as User"
        case .active: "Activate"
        case .superseded: "Supersede"
        default: state.label
        }
    }
}
