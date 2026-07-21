import SwiftUI

struct MemorySettingsView: View {
    let model: AppModel
    @State private var statement = ""
    @State private var source = "User-provided note"
    @State private var tags = ""
    @State private var scope: MemoryScope = .run
    @State private var pendingDeletion: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            GroupBox("Add explicit memory") {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Statement", text: $statement, axis: .vertical)
                        .lineLimit(2...4)
                    HStack {
                        TextField("Source or artifact", text: $source)
                        TextField("Tags, comma separated", text: $tags)
                        Picker("Scope", selection: $scope) {
                            ForEach(MemoryScope.allCases) { Text($0.label).tag($0) }
                        }
                        .frame(width: 140)
                    }
                    HStack {
                        Text(scope == .run ? "Run memory is immediately eligible. Project and user memory require explicit promotion after creation." : "This entry starts inactive until you approve its promotion.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Add Memory") {
                            model.addMemory(statement: statement, source: source, tags: tags, scope: scope)
                            statement = ""
                            tags = ""
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(6)
            }

            HStack {
                Text("Memory ledger").font(.headline)
                Spacer()
                Text("\(model.memories.filter { $0.isEligible(for: model.selectedSessionID) }.count) eligible · \(model.memories.count) total")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            if model.memories.isEmpty {
                ContentUnavailableView("No memory entries", systemImage: "brain", description: Text("LightningLoop never promotes model output into durable memory silently."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(model.memories) { memory in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(memory.statement).font(.body)
                            Spacer()
                            Text(memory.scope.label).font(.caption.bold())
                            Label(memory.isEligible(for: model.selectedSessionID) ? "Eligible" : "Inactive", systemImage: memory.isEligible(for: model.selectedSessionID) ? "checkmark.shield.fill" : "pause.circle")
                                .font(.caption)
                                .foregroundStyle(memory.isEligible(for: model.selectedSessionID) ? .green : .secondary)
                        }
                        Text("Source: \(memory.sourceArtifact) · \(memory.verification.label) · confidence \(memory.confidence, format: .number.precision(.fractionLength(2)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            if !memory.tags.isEmpty { Text(memory.tags.joined(separator: " · ")).font(.caption2).foregroundStyle(.tertiary) }
                            Spacer()
                            if memory.scope != .run && !memory.promotionApprovedByUser {
                                Button("Approve Promotion") { model.approveMemoryPromotion(memory.id) }
                                    .controlSize(.small)
                            }
                            Button("Delete", role: .destructive) { pendingDeletion = memory.id }
                                .controlSize(.small)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            Text("Secrets are prohibited from memory. Run memory is bound to the selected session; promoted project and user memory may enter future runs. Retrieval excludes expired, contradicted, superseded, and unapproved entries. Deletion is explicit and local.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .confirmationDialog("Delete this memory entry?", isPresented: Binding(
            get: { pendingDeletion != nil },
            set: { if !$0 { pendingDeletion = nil } }
        )) {
            Button("Delete Memory", role: .destructive) {
                if let pendingDeletion { model.deleteMemory(pendingDeletion) }
                pendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { pendingDeletion = nil }
        }
    }
}
