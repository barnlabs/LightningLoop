import SwiftUI

struct SidebarView: View {
    let model: AppModel
    @State private var pendingDeletionID: UUID?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                LoopLogo(size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text("LightningLoop")
                        .font(.headline.weight(.bold))
                    HStack(spacing: 4) {
                        Text("BARNLABS")
                            .fontWeight(.bold)
                            .tracking(0.8)
                        Text("· Fast model. Strict loop.")
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)

            Divider()

            List(selection: Binding(
                get: { model.selectedSessionID },
                set: { model.selectedSessionID = $0 }
            )) {
                Section {
                    ForEach(model.sessions) { session in
                        SidebarRow(session: session)
                            .tag(session.id)
                            .listRowInsets(.init(top: 6, leading: 10, bottom: 6, trailing: 10))
                            .listRowSeparator(.hidden)
                            .contextMenu {
                                Button("Delete", role: .destructive) {
                                    pendingDeletionID = session.id
                                }
                                .disabled(model.isRunning)
                            }
                    }
                } header: {
                    HStack {
                        Text("LOOPS")
                            .font(.caption2.weight(.bold))
                            .tracking(1.3)
                        Spacer()
                        Button {
                            model.newSession()
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.plain)
                        .help("New Loop (⌘N)")
                        .keyboardShortcut("n", modifiers: [.command])
                        .accessibilityLabel("New Loop")
                        .accessibilityIdentifier("new.loop")
                    }
                }
            }
            .listStyle(.sidebar)

            VStack(alignment: .leading, spacing: 7) {
                Divider()
                BarnLabsWordmark()
                Text("An independent BarnLabs open-source project.")
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
        HStack(spacing: 11) {
            Image(systemName: session.stage.symbol)
                .foregroundStyle(session.stage == .completed ? LoopBrand.gold : .secondary)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(session.stage.label)
                    Text("·")
                    Text(session.updatedAt, style: .relative)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}
