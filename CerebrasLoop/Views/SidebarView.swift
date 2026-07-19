import SwiftUI

struct SidebarView: View {
    let model: AppModel
    @State private var pendingDeletionID: UUID?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                LoopLogo(size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text("CerebrasLoop")
                        .font(.headline)
                    Text("Fast models. Ruthless review.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)

            List(selection: Binding(
                get: { model.selectedSessionID },
                set: { model.selectedSessionID = $0 }
            )) {
                Section("Loops") {
                    ForEach(model.sessions) { session in
                        SidebarRow(session: session)
                            .tag(session.id)
                            .contextMenu {
                                Button("Delete", role: .destructive) {
                                    pendingDeletionID = session.id
                                }
                                .disabled(model.isRunning)
                            }
                    }
                }
            }
            .listStyle(.sidebar)

            VStack(alignment: .leading, spacing: 8) {
                Button {
                    model.newSession()
                } label: {
                    Label("New Loop", systemImage: "plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut("n", modifiers: [.command])

                Divider()
                BarnLabsWordmark()
                Text("Independent project. Not affiliated with or endorsed by Cerebras Systems.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
        }
        .confirmationDialog(
            "Delete this loop?",
            isPresented: Binding(
                get: { pendingDeletionID != nil },
                set: { if !$0 { pendingDeletionID = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Loop", role: .destructive) {
                guard let id = pendingDeletionID else { return }
                model.selectedSessionID = id
                model.deleteSelectedSession()
                pendingDeletionID = nil
            }
            Button("Cancel", role: .cancel) { pendingDeletionID = nil }
        } message: {
            Text("This permanently removes the local goal, criteria, reviews, and deliverable.")
        }
    }
}

private struct SidebarRow: View {
    let session: LoopSession

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: session.stage.symbol)
                .foregroundStyle(session.stage == .completed ? LoopBrand.gold : .secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .lineLimit(1)
                Text(session.stage.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}
