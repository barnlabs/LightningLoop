import SwiftUI

struct SettingsView: View {
    let model: AppModel
    @AppStorage("maxReviewCycles") private var maxReviewCycles = 4
    @State private var newAPIKey = ""
    @State private var isTesting = false
    @State private var showRemoveKeyConfirmation = false

    var body: some View {
        TabView {
            Form {
                Section("Cerebras connection") {
                    LabeledContent("Model") {
                        Text("Gemma 4 31B")
                        Text("gemma-4-31b").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    LabeledContent("Credential") {
                        Label(model.hasAPIKey ? "Stored in Keychain" : "Not configured", systemImage: model.hasAPIKey ? "checkmark.circle.fill" : "exclamationmark.circle")
                            .foregroundStyle(model.hasAPIKey ? .green : .orange)
                    }
                    SecureField(model.hasAPIKey ? "Paste to replace existing key" : "Paste Cerebras API key", text: $newAPIKey)
                        .textContentType(.password)
                    HStack {
                        Button("Save Key") {
                            model.saveAPIKey(newAPIKey)
                            newAPIKey = ""
                        }
                        .disabled(newAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("Remove", role: .destructive) { showRemoveKeyConfirmation = true }
                            .disabled(!model.hasAPIKey)
                        Spacer()
                        Button("Test Connection") {
                            isTesting = true
                            Task {
                                await model.testConnection()
                                isTesting = false
                            }
                        }
                        .disabled(!model.hasAPIKey || isTesting)
                    }
                    if !model.settingsMessage.isEmpty {
                        Text(model.settingsMessage).font(.caption).foregroundStyle(.secondary)
                    }
                    if let metrics = model.connectionMetrics { MetricsStrip(metrics: metrics) }
                }

                Section("Review loop") {
                    Stepper("Maximum review rounds per stage: \(maxReviewCycles)", value: $maxReviewCycles, in: 1...8)
                    Text("If the plan or implementation still fails after this many rounds, the run pauses with every finding preserved. This prevents infinite cost loops and false completion claims.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Privacy & identity") {
                    Text("Loop history is stored locally in Application Support. Goal, answers, plans, and drafts are sent to Cerebras only when you run the loop. API keys never enter the repository or session files.")
                        .font(.caption)
                    Text("CerebrasLoop is an independent open-source BarnLabs demonstration. It is not affiliated with, endorsed by, or sponsored by Cerebras Systems, Inc. Cerebras is a trademark of its respective owner.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 560, height: 520)
        .confirmationDialog(
            "Remove the Cerebras API key?",
            isPresented: $showRemoveKeyConfirmation,
            titleVisibility: .visible
        ) {
            Button("Remove Key", role: .destructive) { model.removeAPIKey() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("CerebrasLoop will not be able to run until a key is saved again.")
        }
    }
}
