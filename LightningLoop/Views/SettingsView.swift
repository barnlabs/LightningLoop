import SwiftUI

private enum SettingsTab: Hashable {
    case providers
    case skills
    case harness
}

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
    @State private var selectedTab: SettingsTab

    init(model: AppModel) {
        self.model = model
        _draft = State(initialValue: model.providerProfile)
#if DEBUG
        switch ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_SCENARIO"] {
        case "settings-update":
            _selectedTab = State(initialValue: .harness)
        default:
            _selectedTab = State(initialValue: .providers)
        }
#else
        _selectedTab = State(initialValue: .providers)
#endif
    }

    var body: some View {
        settingsBody
            .frame(width: 700, height: fixtureCaptureEnabled ? 740 : 640)
            .onAppear {
                draft = model.providerProfile
                model.refreshManagedLedgers()
                model.refreshSkillPack()
                Task { await model.loadModelCatalogIfCredentialFree() }
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
            providerForm
                .tabItem { Label("Setup", systemImage: "bolt.horizontal.circle") }
                .tag(SettingsTab.providers)

            skillsForm
                .tabItem { Label("Skills", systemImage: "puzzlepiece.extension") }
                .tag(SettingsTab.skills)

            harnessForm
                .tabItem { Label("Harness", systemImage: "point.3.connected.trianglepath.dotted") }
                .tag(SettingsTab.harness)
        }
    }

    private var providerForm: some View {
        Form {
            Section {
                Text(DesignedCopy.setupNextAction)
                    .font(.callout.weight(.medium))
            }

            Section("Provider and model") {
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
                Button(isTesting ? "Loading…" : (draft.usesPiAuthentication ? DesignedCopy.loadRuntimeCatalog : DesignedCopy.discoverHostModels)) {
                    isTesting = true
                    Task {
                        await model.loadModelCatalog()
                        if draft.usesPiAuthentication, let selected = model.runtimeModels.first(where: { $0.modelID == draft.modelID }) {
                            draft = draft.applyingRuntimeModel(selected)
                        } else if model.availableModels.contains(draft.modelID) {
                            model.applyDiscoveredCustomModel(draft.modelID, to: &draft)
                        }
                        isTesting = false
                    }
                }
                .disabled(!model.canLoadModelCatalog || isTesting)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("catalog.load")
                if !model.cataloguedPickerModels.isEmpty {
                    Picker(DesignedCopy.pickCataloguedModel, selection: cataloguedModelBinding) {
                        ForEach(model.cataloguedPickerModels) { option in
                            Text("\(option.modelName) · \(option.supportsImages ? "Image + text" : "Text") · \(option.modelID)")
                                .tag(option.modelID)
                        }
                    }
                    .accessibilityIdentifier(draft.usesPiAuthentication ? "runtime.model.picker" : "custom.model.picker")
                } else {
                    Text(DesignedCopy.catalogNotLoaded)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if draft.preset == .openrouter {
                    Toggle(DesignedCopy.justFreeLabel, isOn: Binding(
                        get: { draft.freeOnly ?? false },
                        set: { enabled in
                            draft.freeOnly = enabled
                            model.saveProviderConfiguration(draft)
                            draft = model.providerProfile
                        }
                    ))
                    .accessibilityIdentifier("openrouter.free.only")
                }
                if draft.preset == .custom {
                    Button("Save host") { model.saveProviderConfiguration(draft); draft = model.providerProfile }
                        .disabled(!model.canSaveProviderConfiguration(draft))
                }
                if !model.settingsMessage.isEmpty {
                    Text(model.settingsMessage).font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Inference credential") {
                if draft.usesPiAuthentication {
                    Label("Runtime-managed sign-in", systemImage: "person.badge.key")
                    Text("Next: lightningloop auth, then /login. Tokens stay in the runtime. Never copied.")
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
                Text(DesignedCopy.keyNeverEchoed)
            }

            Section("Loop") {
                Stepper("Maximum review rounds: \(maxReviewCycles)", value: $maxReviewCycles, in: 1...8)
                Toggle("Research before planning", isOn: $researchEnabled)
                    .disabled(!model.supportsAutomaticResearch)
                if researchEnabled {
                    Picker("Search provider", selection: $researchProvider) {
                        Text("Brave").tag("brave")
                        Text("Exa").tag("exa")
                        Text("Firecrawl").tag("firecrawl")
                    }
                }
                Toggle("Notify when Gold, blocked, or waiting", isOn: $notificationsEnabled)
                    .onChange(of: notificationsEnabled) { _, enabled in
                        guard enabled else { return }
                        Task {
                            if !(await LoopNotificationService.requestAuthorization()) {
                                notificationsEnabled = false
                            }
                        }
                    }
            }
        }
        .formStyle(.grouped)
    }

    private var skillsForm: some View {
        Form {
            Section {
                Text("Default pack. Enable and disable are explicit. Drafts never auto-enable.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(model.skillPack) { skill in
                    Toggle(isOn: Binding(
                        get: { skill.enabled },
                        set: { model.setSkillEnabled($0, id: skill.id) }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(skill.title)
                            Text(skill.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("skill.toggle.\(skill.id)")
                }
                if !model.settingsMessage.isEmpty {
                    Text(model.settingsMessage).font(.caption).foregroundStyle(.secondary)
                }
            } header: {
                Text("Shipped skills")
            } footer: {
                Text("CLI: llp skills list|enable|disable ID")
            }
        }
        .formStyle(.grouped)
    }

    private var harnessForm: some View {
        Form {
            Section("Managed harness") {
                Text("Skills extras, MCP manifests, tools, graphs, and prompt addenda. Runtime sign-in stays outside this overlay.")
                    .font(.caption)
                HStack {
                    Button("Inspect") { model.manageHarness("status") }
                    Button("Back Up Now") { model.manageHarness("backup") }
                    Button("Restore Latest") { confirmsHarnessRestore = true }
                    Button("Reset Managed Overlay", role: .destructive) { confirmsHarnessReset = true }
                }
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
                        Text("This source build has no pinned signing key or release feed.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Link("Read secure update guidance", destination: URL(string: "https://github.com/barnlabs/LightningLoop/blob/main/docs/UPDATES.md")!)
                    .accessibilityIdentifier("secure.update.guide")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Reset LightningLoop’s managed overlay?", isPresented: $confirmsHarnessReset) {
            Button("Back Up and Reset", role: .destructive) { model.manageHarness("reset", approveReset: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This resets only LightningLoop-managed extras. Runtime authentication is untouched.")
        }
        .confirmationDialog("Restore the latest managed-overlay backup?", isPresented: $confirmsHarnessRestore) {
            Button("Back Up Current and Restore", role: .destructive) { model.manageHarness("restore", approveRestore: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Runtime state is untouched.")
        }
    }

    private var fixtureNavigation: some View {
        Picker("Settings section", selection: $selectedTab) {
            Label("Setup", systemImage: "bolt.horizontal.circle").tag(SettingsTab.providers)
            Label("Skills", systemImage: "puzzlepiece.extension").tag(SettingsTab.skills)
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

    private var cataloguedModelBinding: Binding<String> {
        Binding(
            get: { draft.modelID },
            set: { modelID in
                model.persistCataloguedModel(modelID, to: &draft)
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
                    .accessibilityIdentifier("credential.secure.field")
                    .accessibilityLabel("API key for \(provider.label)")
                Button("Save") { save(pendingValue); pendingValue = "" }
                    .disabled(pendingValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("credential.save")
                Button("Remove", role: .destructive) { confirmsRemoval = true }
                    .disabled(!configured)
            }
            Text(DesignedCopy.keyNeverEchoed)
                .font(.caption)
                .foregroundStyle(.secondary)
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
