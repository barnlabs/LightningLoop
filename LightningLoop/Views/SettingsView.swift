import SwiftUI

private enum SettingsTab: Hashable {
    case general
    case providers
    case memory
    case evolution
    case harness
}

struct SettingsView: View {
    let model: AppModel
    @AppStorage("maxReviewCycles") private var maxReviewCycles = 4
    @AppStorage("researchEnabled") private var researchEnabled = false
    @AppStorage("researchProvider") private var researchProvider = "brave"
    @AppStorage(AppModel.autoTitleLLMPreferenceKey) private var autoTitleLLMEnabled = false
    @AppStorage(LoopNotificationService.preferenceKey) private var notificationsEnabled = false
    @State private var isTesting = false
    @State private var draft: ProviderConfiguration
    @State private var confirmsHarnessReset = false
    @State private var confirmsHarnessRestore = false
    @State private var copiedAgentPromptID: String?
    @State private var selectedTab: SettingsTab

    init(model: AppModel) {
        self.model = model
        _draft = State(initialValue: model.providerProfile)
#if DEBUG
        switch ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_SCENARIO"] {
        case "settings-model":
            _selectedTab = State(initialValue: .providers)
        case "settings-update":
            _selectedTab = State(initialValue: .harness)
        default:
            _selectedTab = State(initialValue: .general)
        }
#else
        _selectedTab = State(initialValue: .general)
#endif
    }

    var body: some View {
        settingsBody
            .frame(width: 700, height: fixtureCaptureEnabled ? 740 : 690)
            .onAppear {
                draft = model.providerProfile
                model.refreshManagedLedgers()
                if draft.usesPiAuthentication {
                    Task { await model.refreshRuntimeModelCatalog() }
                }
            }
    }

    @ViewBuilder
    private var settingsBody: some View {
        if fixtureCaptureEnabled {
            VStack(spacing: 0) {
                fixtureNavigation
                Divider()
                settingsTabs
            }
        } else {
            settingsTabs
        }
    }

    private var settingsTabs: some View {
        TabView(selection: $selectedTab) {
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
                        if draft.usesPiAuthentication {
                            // Do not paint built-in auth as "ready" — catalogued ≠ signed-in.
                            Label("Runtime-managed (sign-in unknown)", systemImage: "key.horizontal")
                                .foregroundStyle(.secondary)
                        } else {
                            Label(
                                model.hasCredential(draft) ? "Stored in Keychain" : "Not configured",
                                systemImage: model.hasCredential(draft) ? "checkmark.circle.fill" : "exclamationmark.circle"
                            )
                            .foregroundStyle(model.hasCredential(draft) ? .green : .orange)
                        }
                    }
                    HStack {
                        if draft.usesPiAuthentication {
                            Button(isTesting ? "Refreshing…" : "Refresh Runtime Models") {
                                isTesting = true
                                Task {
                                    await model.refreshRuntimeModelCatalog()
                                    if let selected = model.runtimeModels.first(where: { $0.modelID == draft.modelID }) {
                                        draft = draft.applyingRuntimeModel(selected)
                                    }
                                    isTesting = false
                                }
                            }
                            .disabled(isTesting)
                            Button("Copy runtime login command") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString("lightningloop auth", forType: .string)
                            }
                        } else {
                            Button(isTesting ? "Testing…" : "Discover Models & Test") {
                                isTesting = true
                                Task {
                                    await model.testConnection()
                                    if model.availableModels.contains(draft.modelID) {
                                        model.applyDiscoveredCustomModel(draft.modelID, to: &draft)
                                    }
                                    isTesting = false
                                }
                            }
                            .disabled(!model.hasCredential(draft) || isTesting)
                        }
                    }
                    if draft.usesPiAuthentication {
                        Text("Installed LightningLoop runtime catalog — not a live provider account inventory. Catalogued means the pinned runtime lists the model ID; it does not prove sign-in or entitlement.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if !model.runtimeModelCatalogScope.isEmpty {
                            Text(model.runtimeModelCatalogScope)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        if !model.runtimeModels.isEmpty {
                            Text("\(model.runtimeModels.count) runtime model\(model.runtimeModels.count == 1 ? "" : "s") catalogued")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let selectionMessage = model.runtimeModelSelectionMessage(for: draft) {
                            Text(selectionMessage)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text("Provider credentials stay in the runtime. Run `lightningloop auth`, then the runtime’s /login picker. LightningLoop never copies those credentials.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if !model.availableModels.isEmpty {
                        Text("\(model.availableModels.count) model ID\(model.availableModels.count == 1 ? "" : "s") returned by this host’s /models (account-visible list).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !model.settingsMessage.isEmpty {
                        Text(model.settingsMessage).font(.caption).foregroundStyle(.secondary)
                    }
                    if let metrics = model.connectionMetrics { MetricsStrip(metrics: metrics) }
                    Text("Clarification, execution, and Gold require the shared LightningLoop runtime. For a Custom profile, Discover Models & Test is the only direct native provider operation.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Autonomy") {
                    Stepper("Maximum review rounds per stage: \(maxReviewCycles)", value: $maxReviewCycles, in: 1...8)
                    Toggle("LLM short titles (custom providers only)", isOn: $autoTitleLLMEnabled)
                    Text("After clarification or plan, optionally rewrite the sidebar title with a tiny completion. Built-in providers keep titles offline (goal/plan heuristic). Failures never block Gold. Manual renames lock auto-title.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
                         : "Automatic research, clarification, execution, and Gold require the shared LightningLoop runtime. No native fallback loop runs without it.")
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
            .tag(SettingsTab.general)

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
                    if draft.usesPiAuthentication {
                        LabeledContent("Selected model") {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(draft.modelName)
                                Text(draft.modelID).font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                        if !model.runtimeModels.isEmpty {
                            Picker("Runtime model", selection: runtimeModelBinding) {
                                ForEach(model.runtimeModels) { option in
                                    Text("\(option.modelName) · \(option.supportsImages ? "Image + text" : "Text") · \(option.modelID)")
                                        .tag(option.modelID)
                                }
                            }
                            .accessibilityIdentifier("runtime.model.picker")
                        } else {
                            Text("Refresh the installed LightningLoop runtime catalog to select a catalogued model.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if !model.runtimeModelCatalogScope.isEmpty {
                            Text(model.runtimeModelCatalogScope)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        TextField("Model ID", text: $draft.modelID)
                            .font(.body.monospaced())
                        TextField("Model display name", text: $draft.modelName)
                        if !model.availableModels.isEmpty {
                            Picker("Discovered model", selection: Binding(
                                get: { draft.modelID },
                                set: { id in
                                    draft.modelID = id
                                    model.applyDiscoveredCustomModel(id, to: &draft)
                                }
                            )) {
                                ForEach(model.availableModels, id: \.self) { id in
                                    Text(id).tag(id)
                                }
                            }
                            .accessibilityIdentifier("custom.model.picker")
                            Text("OpenAI-compatible /models returns IDs only. Context window and image support stay user-set until the host exposes richer metadata.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Use Discover Models & Test to load account-visible model IDs from this host.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if draft.usesPiAuthentication {
                        LabeledContent("Image input", value: draft.supportsImages ? "Supported" : "Text only")
                        LabeledContent("Context window", value: draft.contextWindow.formatted())
                        LabeledContent("Maximum output", value: draft.maxOutputTokens.formatted())
                    } else {
                        Toggle("Model accepts image input", isOn: $draft.supportsImages)
                        Stepper("Context window: \(draft.contextWindow.formatted())", value: $draft.contextWindow, in: 1_024...2_000_000, step: 1_024)
                        Stepper("Maximum output: \(draft.maxOutputTokens.formatted())", value: $draft.maxOutputTokens, in: 256...131_072, step: 256)
                    }
                    Button("Save Active Profile") { model.saveProviderConfiguration(draft); draft = model.providerProfile }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.canSaveProviderConfiguration(draft))
                }

                Section("Inference credential") {
                    if draft.usesPiAuthentication {
                        Label("Authentication is delegated to the LightningLoop runtime’s provider flow.", systemImage: "person.badge.key")
                        Text("Use `lightningloop auth` and the runtime’s /login or /logout. OAuth tokens remain in the runtime credential store and are never copied into LightningLoop configuration, prompts, backups, or logs.")
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
            .tag(SettingsTab.providers)

            MemorySettingsView(model: model)
                .tabItem { Label("Memory", systemImage: "brain") }
                .tag(SettingsTab.memory)

            EvolutionSettingsView(model: model)
                .tabItem { Label("Evolution", systemImage: "arrow.triangle.2.circlepath") }
                .tag(SettingsTab.evolution)

            Form {
                Section("Managed harness") {
                    Text("LightningLoop manages only its own skills, MCP manifests, tools, graphs, and prompt addenda. Runtime authentication and runtime global settings are outside this overlay.")
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
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "lock.shield.fill")
                            .font(.title2)
                            .foregroundStyle(LoopBrand.gold)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Automatic updates are off")
                                .font(.headline)
                            Text("UNCONFIGURED")
                                .font(.caption2.bold().monospaced())
                                .tracking(1.1)
                                .foregroundStyle(.secondary)
                            Text("This source build has no pinned signing key or release feed. It will not fetch or install an update in the background.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    LabeledContent("Current update path", value: "Verified source rebuild")
                    Text("Use `lightningloop update check` for a local, read-only policy report. Until signed distribution exists, follow the clean-checkout source path and keep the installer rollback snapshot through launch verification.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Link("Read secure update guidance", destination: URL(string: "https://github.com/barnlabs/LightningLoop/blob/main/docs/UPDATES.md")!)
                        .accessibilityIdentifier("secure.update.guide")
                }
                Section("Agent setup & maintenance") {
                    Text("Copy a bounded handoff for another agent to install, connect provider access, maintain, or diagnose LightningLoop. Provider access uses official sign-in; credentials are never copied from another agent.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(AgentHandoffPrompts.all) { prompt in
                        HStack {
                            Label(prompt.title, systemImage: "doc.on.doc")
                            Spacer()
                            Button(copiedAgentPromptID == prompt.id ? "Copied" : "Copy Prompt") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(prompt.text, forType: .string)
                                copiedAgentPromptID = prompt.id
                            }
                            .accessibilityLabel("Copy \(prompt.title) prompt")
                        }
                    }
                    Link("Open the GitHub prompt guide", destination: URL(string: "https://github.com/barnlabs/LightningLoop/blob/main/docs/AGENT_SETUP_AND_MAINTENANCE.md")!)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("Harness", systemImage: "point.3.connected.trianglepath.dotted") }
            .tag(SettingsTab.harness)
            .confirmationDialog("Reset LightningLoop’s managed overlay?", isPresented: $confirmsHarnessReset) {
                Button("Back Up and Reset", role: .destructive) { model.manageHarness("reset", approveReset: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This resets only LightningLoop-managed skills, MCP manifests, tools, graphs, and prompt addenda. It never changes runtime authentication or runtime global settings.")
            }
            .confirmationDialog("Restore the latest managed-overlay backup?", isPresented: $confirmsHarnessRestore) {
                Button("Back Up Current and Restore", role: .destructive) { model.manageHarness("restore", approveRestore: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("LightningLoop verifies the backup snapshot, saves the current overlay to a new rotating backup, and then replaces only its managed resources. Runtime state is untouched.")
            }
        }
    }

    private var fixtureNavigation: some View {
        Picker("Settings section", selection: $selectedTab) {
            Label("General", systemImage: "gearshape").tag(SettingsTab.general)
            Label("Providers", systemImage: "bolt.horizontal.circle").tag(SettingsTab.providers)
            Label("Memory", systemImage: "brain").tag(SettingsTab.memory)
            Label("Evolution", systemImage: "arrow.triangle.2.circlepath").tag(SettingsTab.evolution)
            Label("Harness", systemImage: "point.3.connected.trianglepath.dotted").tag(SettingsTab.harness)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, 22)
        .padding(.vertical, 12)
        .accessibilityIdentifier("settings.fixture.navigation")
    }

    private var fixtureCaptureEnabled: Bool {
#if DEBUG
        let environment = ProcessInfo.processInfo.environment
        return environment["LIGHTNINGLOOP_UI_TESTING"] == "1"
            && environment["LIGHTNINGLOOP_UI_CAPTURE_PATH"] != nil
#else
        return false
#endif
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

    private var runtimeModelBinding: Binding<String> {
        Binding(
            get: { draft.modelID },
            set: { modelID in
                guard let option = model.runtimeModels.first(where: { $0.modelID == modelID }) else { return }
                draft = draft.applyingRuntimeModel(option)
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
