import SwiftUI

struct SidebarView: View {
    let model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var pendingDeletionID: UUID?
    @State private var renameSessionID: UUID?
    @State private var renameDraft = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                LoopLogo(size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text("LightningLoop")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(colorScheme == .dark ? Color.white : LoopBrand.forest)
                    Text("Fast models. Strict evidence.")
                        .font(.caption2)
                        .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.68) : Color.secondary)
                    BarnLabsWordmark()
                        .scaleEffect(0.88, anchor: .leading)
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
                                Button("Rename…") {
                                    model.selectedSessionID = session.id
                                    renameDraft = session.title
                                    renameSessionID = session.id
                                }
                                .disabled(model.isRunning)
                                if session.titleLocked {
                                    Button("Unlock auto-title") {
                                        model.selectedSessionID = session.id
                                        model.unlockSelectedSessionTitle()
                                    }
                                    .disabled(model.isRunning)
                                }
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
                            .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.68) : Color.secondary)
                        Spacer()
                        Button {
                            model.newSession()
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.82) : LoopBrand.forest)
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
                    .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.54) : Color.secondary)
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
        .sheet(isPresented: Binding(
            get: { renameSessionID != nil },
            set: { if !$0 { renameSessionID = nil } }
        )) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Rename loop")
                    .font(.headline)
                TextField("Title", text: $renameDraft)
                    .textFieldStyle(.roundedBorder)
                Text("Renaming locks auto-title updates until you unlock them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel") { renameSessionID = nil }
                    Button("Save") {
                        if let id = renameSessionID {
                            model.selectedSessionID = id
                            model.renameSelectedSession(to: renameDraft)
                        }
                        renameSessionID = nil
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(20)
            .frame(width: 360)
        }
    }
}

private struct SidebarRow: View {
    let session: LoopSession
    @Environment(\.colorScheme) private var colorScheme

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
                    .foregroundStyle(colorScheme == .dark ? Color.white : Color.primary)
                HStack(spacing: 6) {
                    Text(session.stage.label)
                    Text("·")
                    Text(session.updatedAt, style: .relative)
                }
                .font(.caption2)
                .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.68) : Color.secondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}
