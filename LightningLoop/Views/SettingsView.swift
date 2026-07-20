import SwiftUI

struct SettingsView: View {
    let model: AppModel
    @AppStorage("maxReviewCycles") private var maxReviewCycles = 4
    @AppStorage("researchEnabled") private var researchEnabled = false
    @AppStorage("researchProvider") private var researchProvider = "brave"
    @AppStorage(LoopNotificationService.preferenceKey) private var notificationsEnabled = false
    @State private var isTesting = false
    @State private var draft: ProviderConfiguration
    @State private var confirmsHarnessReset = false
    @State private var confirmsHarnessRestore = false

    init(model: AppModel) {
        self.model = model
        _draft = State(initialValue: model.providerProfile)
    }

    var body: some View {
        TabView {
            Form {
                Section("Inference") {
                    Picker("Provider", selection: providerPresetBinding) {
                        ForEach(ProviderPreset.allCases) { preset in Text(preset.label).tag(preset) }
                    }
                    LabeledContent("Runtime", value: model.runtimeLabel)
                    LabeledContent("Active model") {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(model.providerProfile.modelName)
                            Text(model.providerProfile.modelID).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Credential") {
                        Label(draft.usesPiAuthentication ? "Managed by Pi" : (model.hasCredential(draft) ? "Stored in Keychain" : "Not configured"), systemImage: (draft.usesPiAuthentication || model.hasCredential(draft)) ? "checkmark.circle.fill" : "exclamationmark.circle")
                            .foregroundStyle((draft.usesPiAuthentication || model.hasCredential(draft)) ? .green : .orange)
                    }
                    HStack {
                    Button(isTesting ? "Testing…" : "Discover Models & Test") {
                            isTesting = true
                            Task { await model.testConnection(); isTesting = false }
                        }
                    .disabled(!model.hasCredential(draft) || isTesting || draft.usesPiAuthentication)
                    if draft.usesPiAuthentication {
                        Button("Copy Pi login command") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString("lightningloop auth", forType: .string)
                        }
                        Text("Run the copied command, then use Pi’s /login picker. LightningLoop does not receive or duplicate the OAuth credential.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                        if !model.availableModels.isEmpty {
                            Text("\(model.availableModels.count) available")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if !model.settingsMessage.isEmpty {
                        Text(model.settingsMessage).font(.caption).foregroundStyle(.secondary)
                    }
                    if let metrics = model.connectionMetrics { MetricsStrip(metrics: metrics) }
                    Text("Clarification, execution, and Gold require the shared Pi harness. For a Custom profile, Discover Models & Test is the only direct native provider operation.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Autonomy") {
                    Stepper("Maximum review rounds per stage: \(maxReviewCycles)", value: $maxReviewCycles, in: 1...8)
                    Toggle("Research before planning", isOn: $researchEnabled)
                        .disabled(!model.supportsAutomaticResearch)
                    if researchEnabled {
                        Picker("Search provider", selection: $researchProvider) {
                            Text("Brave").tag("brave")
                            Text("Exa").tag("exa")
                            Text("Firecrawl").tag("firecrawl")
                        }
                    }
                    Text(model.supportsAutomaticResearch
                         ? "After clarification, LightningLoop autonomously researches up to three focused queries, challenges the plan, implements, and repairs defects. Search, review, tool, and time caps remain enforced."
                         : "Automatic research, clarification, execution, and Gold require the shared Pi harness. No native fallback loop runs without it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Notifications") {
                    Toggle("Notify when Gold, blocked, or waiting for input", isOn: $notificationsEnabled)
                        .onChange(of: notificationsEnabled) { _, enabled in
                            guard enabled else { return }
                            Task {
                                if !(await LoopNotificationService.requestAuthorization()) {
                                    notificationsEnabled = false
                                }
                            }
                        }
                    Text("Notifications contain only the task title or bounded status—not prompts, provider credentials, generated files, or research content.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Privacy") {
                    Text("Loop history and copied attachments stay in Application Support. Goals, source images, plans, and drafts are sent only to the provider you select when a loop runs. Research queries go only to the search provider you enable. API keys never enter session files, prompts, logs, or the repository.")
                        .font(.caption)
                    Text("LightningLoop is an open-source BarnLabs project. Inference and search providers are independent third-party services selected by the user.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("General", systemImage: "gearshape") }

            Form {
                Section("Active provider profile") {
                    Picker("Preset", selection: providerPresetBinding) {
                        ForEach(ProviderPreset.allCases) { preset in Text(preset.label).tag(preset) }
                    }
                    if draft.preset == .custom {
                        TextField("Provider name", text: $draft.displayName)
                        TextField("HTTPS base URL", text: $draft.baseURL)
                            .textContentType(.URL)
                    } else {
                        LabeledContent("Verified endpoint", value: draft.baseURL)
                    }
                    TextField("Model ID", text: $draft.modelID)
                        .font(.body.monospaced())
                    TextField("Model display name", text: $draft.modelName)
                    if !model.availableModels.isEmpty {
                        Picker("Discovered model", selection: $draft.modelID) {
                            ForEach(model.availableModels, id: \.self) { Text($0).tag($0) }
                        }
                    }
                    Toggle("Model accepts image input", isOn: $draft.supportsImages)
                    Stepper("Context window: \(draft.contextWindow.formatted())", value: $draft.contextWindow, in: 1_024...2_000_000, step: 1_024)
                    Stepper("Maximum output: \(draft.maxOutputTokens.formatted())", value: $draft.maxOutputTokens, in: 256...131_072, step: 256)
                    Button("Save Active Profile") { model.saveProviderConfiguration(draft); draft = model.providerProfile }
                        .buttonStyle(.borderedProminent)
                }

                Section("Inference credential") {
                    if draft.usesPiAuthentication {
                        Label("Authentication is delegated to Pi’s built-in provider flow.", systemImage: "person.badge.key")
                        Text("Use `lightningloop auth` and Pi’s /login or /logout. OAuth tokens remain in Pi’s credential store and are never copied into LightningLoop configuration, prompts, backups, or logs.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        CredentialRow(
                            provider: draft.credentialProvider,
                            configured: model.hasCredential(draft),
                            save: { model.saveCredential($0, for: draft) },
                            remove: { model.removeCredential(for: draft) }
                        )
                    }
                }

                Section {
                    ForEach(CredentialProvider.searchCases) { provider in
                        CredentialRow(
                            provider: provider,
                            configured: model.hasCredential(provider),
                            save: { model.saveCredential($0, for: provider) },
                            remove: { model.removeCredential(for: provider) }
                        )
                    }
                } header: {
                    Text("Research credentials")
                } footer: {
                    Text("Every value is stored as a device-only generic password in macOS Keychain. Custom endpoint URLs and model metadata are non-secret local configuration; keys are isolated by provider.")
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("Providers", systemImage: "bolt.horizontal.circle") }

            MemorySettingsView(model: model)
                .tabItem { Label("Memory", systemImage: "brain") }

            EvolutionSettingsView(model: model)
                .tabItem { Label("Evolution", systemImage: "arrow.triangle.2.circlepath") }

            Form {
                Section("Managed harness") {
                    Text("LightningLoop manages only its own skills, MCP manifests, tools, graphs, and prompt addenda. Pi authentication and Pi’s global settings are outside this overlay.")
                        .font(.caption)
                    HStack {
                        Button("Inspect") { model.manageHarness("status") }
                        Button("Back Up Now") { model.manageHarness("backup") }
                        Button("Restore Latest") { confirmsHarnessRestore = true }
                        Button("Reset Managed Overlay", role: .destructive) { confirmsHarnessReset = true }
                    }
                    Text("Three rotating snapshots bound storage growth. Restore and reset create a fresh pre-change backup first.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if !model.settingsMessage.isEmpty {
                        Text(model.settingsMessage).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
                Section("Updates") {
                    Label("Signed channel not configured", systemImage: "lock.shield")
                    Text("This source build refuses automatic installation until BarnLabs publishes a Developer ID/notarized macOS feed and Ed25519-signed cross-platform manifests. User-managed resources remain separate from application updates.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("Harness", systemImage: "point.3.connected.trianglepath.dotted") }
            .confirmationDialog("Reset LightningLoop’s managed overlay?", isPresented: $confirmsHarnessReset) {
                Button("Back Up and Reset", role: .destructive) { model.manageHarness("reset", approveReset: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This resets only LightningLoop-managed skills, MCP manifests, tools, graphs, and prompt addenda. It never changes Pi authentication or Pi global settings.")
            }
            .confirmationDialog("Restore the latest managed-overlay backup?", isPresented: $confirmsHarnessRestore) {
                Button("Back Up Current and Restore", role: .destructive) { model.manageHarness("restore", approveRestore: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("LightningLoop verifies the backup snapshot, saves the current overlay to a new rotating backup, and then replaces only its managed resources. Pi state is untouched.")
            }
        }
        .frame(width: 700, height: 690)
        .onAppear {
            draft = model.providerProfile
            model.refreshManagedLedgers()
        }
    }

    private var providerPresetBinding: Binding<ProviderPreset> {
        Binding(
            get: { draft.preset },
            set: { preset in
                model.selectProviderPreset(preset)
                draft = model.providerProfile
            }
        )
    }
}

private struct CredentialRow: View {
    let provider: CredentialProvider
    let configured: Bool
    let save: (String) -> Void
    let remove: () -> Void
    @State private var pendingValue = ""
    @State private var confirmsRemoval = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.label).font(.headline)
                    Text(provider.purpose).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Label(configured ? "Configured" : "Missing", systemImage: configured ? "checkmark.circle.fill" : "circle.dashed")
                    .font(.caption)
                    .foregroundStyle(configured ? .green : .secondary)
            }
            HStack {
                SecureField(configured ? "Paste to replace" : "Paste API key", text: $pendingValue)
                    .textContentType(.password)
                Button("Save") { save(pendingValue); pendingValue = "" }
                    .disabled(pendingValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Remove", role: .destructive) { confirmsRemoval = true }
                    .disabled(!configured)
            }
        }
        .padding(.vertical, 4)
        .confirmationDialog("Remove the \(provider.label) credential?", isPresented: $confirmsRemoval) {
            Button("Remove Credential", role: .destructive, action: remove)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This provider remains unavailable until a new credential is saved.")
        }
    }
}
