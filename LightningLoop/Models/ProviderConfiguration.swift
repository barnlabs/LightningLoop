import Foundation
import Darwin

enum ProviderPreset: String, Codable, CaseIterable, Identifiable, Sendable {
    case cerebras
    case groq
    case fireworks
    case generalcompute
    case xai
    case openaiCodex = "openai-codex"
    case anthropic
    case custom
    case selectionRequired = "selection-required"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cerebras: "Cerebras Inference"
        case .groq: "Groq"
        case .fireworks: "Fireworks"
        case .generalcompute: "GeneralCompute"
        case .xai: "xAI / Grok (LightningLoop runtime sign-in)"
        case .openaiCodex: "OpenAI Codex (LightningLoop runtime sign-in)"
        case .anthropic: "Anthropic Claude (LightningLoop runtime sign-in)"
        case .custom: "Custom OpenAI-compatible"
        case .selectionRequired: "Choose a provider"
        }
    }
}

/// A credential-free model description supplied by the shared LightningLoop
/// runtime. Built-in providers must select from this catalog; custom profiles
/// continue to use their explicit, user-triggered connection test instead.
struct ProviderModelOption: Codable, Hashable, Identifiable, Sendable {
    var id: String { modelID }

    var modelID: String
    var modelName: String
    var supportsImages: Bool
    var contextWindow: Int
    var maxOutputTokens: Int
}

struct ProviderConfiguration: Codable, Hashable, Sendable {
    static let schemaVersion = 1
    static let cerebrasGemma4_31B = ProviderModelOption(
        modelID: "gemma-4-31b",
        modelName: "Gemma 4 31B",
        supportsImages: true,
        contextWindow: 131_072,
        maxOutputTokens: 40_960
    )

    var schemaVersion: Int
    var id: String
    var preset: ProviderPreset
    var displayName: String
    var baseURL: String
    var modelID: String
    var modelName: String
    var supportsImages: Bool
    var contextWindow: Int
    var maxOutputTokens: Int

    static let onboarding = ProviderConfiguration(
        schemaVersion: schemaVersion,
        id: "selection-required",
        preset: .selectionRequired,
        displayName: "Choose a provider",
        baseURL: "",
        modelID: "",
        modelName: "",
        supportsImages: false,
        contextWindow: 1_024,
        maxOutputTokens: 256
    )

    var requiresProviderSelection: Bool { preset == .selectionRequired }

    static func preset(_ preset: ProviderPreset) -> ProviderConfiguration {
        switch preset {
        case .cerebras:
            .init(schemaVersion: schemaVersion, id: "cerebras", preset: .cerebras, displayName: "Cerebras Inference", baseURL: "https://api.cerebras.ai/v1", modelID: cerebrasGemma4_31B.modelID, modelName: cerebrasGemma4_31B.modelName, supportsImages: cerebrasGemma4_31B.supportsImages, contextWindow: cerebrasGemma4_31B.contextWindow, maxOutputTokens: cerebrasGemma4_31B.maxOutputTokens)
        case .groq:
            .init(schemaVersion: schemaVersion, id: "groq", preset: .groq, displayName: "Groq", baseURL: "https://api.groq.com/openai/v1", modelID: "openai/gpt-oss-120b", modelName: "GPT-OSS 120B", supportsImages: false, contextWindow: 131_072, maxOutputTokens: 32_768)
        case .fireworks:
            .init(schemaVersion: schemaVersion, id: "fireworks", preset: .fireworks, displayName: "Fireworks", baseURL: "https://api.fireworks.ai/inference/v1", modelID: "accounts/fireworks/models/kimi-k2p6", modelName: "Kimi K2.6", supportsImages: true, contextWindow: 262_000, maxOutputTokens: 32_768)
        case .generalcompute:
            .init(schemaVersion: schemaVersion, id: "generalcompute", preset: .generalcompute, displayName: "GeneralCompute", baseURL: "https://api.generalcompute.com/v1", modelID: "minimax-m2.7", modelName: "MiniMax M2.7", supportsImages: false, contextWindow: 192_000, maxOutputTokens: 131_072)
        case .xai:
            .init(schemaVersion: schemaVersion, id: "xai", preset: .xai, displayName: "xAI / Grok", baseURL: "https://api.x.ai/v1", modelID: "grok-4.5", modelName: "Grok 4.5", supportsImages: true, contextWindow: 256_000, maxOutputTokens: 32_768)
        case .openaiCodex:
            .init(schemaVersion: schemaVersion, id: "openai-codex", preset: .openaiCodex, displayName: "OpenAI Codex", baseURL: "https://api.openai.com/v1", modelID: "gpt-5.6-terra", modelName: "GPT-5.6 Terra", supportsImages: true, contextWindow: 400_000, maxOutputTokens: 131_072)
        case .anthropic:
            .init(schemaVersion: schemaVersion, id: "anthropic", preset: .anthropic, displayName: "Anthropic Claude", baseURL: "https://api.anthropic.com/v1", modelID: "claude-sonnet-4-6", modelName: "Claude Sonnet 4.6", supportsImages: true, contextWindow: 200_000, maxOutputTokens: 64_000)
        case .custom:
            .init(schemaVersion: schemaVersion, id: "custom", preset: .custom, displayName: "Custom provider", baseURL: "https://inference.example.com/v1", modelID: "model-id", modelName: "Custom model", supportsImages: false, contextWindow: 65_536, maxOutputTokens: 8_192)
        case .selectionRequired:
            onboarding
        }
    }

    /// Gemma is intentionally a preview preference, not a claim that every
    /// installed runtime catalog contains it. The shared runtime must confirm
    /// the selected model before execution.
    var requiresRuntimeModelVerification: Bool {
        preset == .cerebras && modelID == Self.cerebrasGemma4_31B.modelID
    }

    var runtimeModelSelectionNotice: String? {
        guard requiresRuntimeModelVerification else { return nil }
        return "Gemma 4 31B is a public-preview preference. It is not treated as catalogued until the installed LightningLoop runtime catalog lists it."
    }

    func applyingRuntimeModel(_ option: ProviderModelOption) -> ProviderConfiguration {
        var selected = self
        selected.modelID = option.modelID
        selected.modelName = option.modelName
        selected.supportsImages = option.supportsImages
        selected.contextWindow = option.contextWindow
        selected.maxOutputTokens = option.maxOutputTokens
        return selected
    }

    var credentialProvider: CredentialProvider {
        switch preset {
        case .cerebras: .cerebras
        case .groq: .groq
        case .fireworks: .fireworks
        case .generalcompute: .generalcompute
        case .xai, .openaiCodex, .anthropic: .custom
        case .custom, .selectionRequired: .custom
        }
    }

    /// Pi-managed presets use the runtime /login path. GeneralCompute and custom
    /// use LightningLoop-owned API keys (Keychain / env); never Pi /login.
    var usesPiAuthentication: Bool {
        switch preset {
        case .custom, .generalcompute, .selectionRequired: false
        default: true
        }
    }

    var allowsNativeConnectionTesting: Bool {
        preset == .custom || preset == .generalcompute
    }

    var credentialService: String {
        if usesPiAuthentication { return "com.barnlabs.LightningLoop.pi-managed.\(id)" }
        if preset == .generalcompute {
            return CredentialProvider.generalcompute.service
        }
        guard preset == .custom, let host = URLComponents(string: baseURL)?.host?.lowercased() else {
            return credentialProvider.service
        }
        return "com.barnlabs.LightningLoop.provider.custom.\(id).\(host).apiKey"
    }

    var endpoint: URL? {
        URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/chat/completions")
    }

    var modelsEndpoint: URL? {
        URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/models")
    }
}

/// A deliberately small LightningLoop-owned index of *service identifiers*,
/// not credentials. It lets ledger filtering cover a previous custom host
/// after the active custom profile changes, without ever enumerating Pi or
/// another application's Keychain items.
struct CustomCredentialServiceRegistry: Sendable {
    enum State: Equatable, Sendable {
        case missing
        case valid(Set<String>)
        case invalid

        var services: Set<String>? {
            switch self {
            case .missing: []
            case .valid(let services): services
            case .invalid: nil
            }
        }
    }

    enum RegistryError: Error, Equatable {
        case invalidState
        case invalidService
        case capacityExceeded
        case writeFailed
    }

    let fileURL: URL

    init(fileManager: FileManager = .default, fileURL: URL? = nil) {
        if let fileURL { self.fileURL = fileURL; return }
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = support.appendingPathComponent("LightningLoop", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        self.fileURL = directory.appendingPathComponent("custom-credential-services.json")
    }

    func state() -> State {
        var metadata = stat()
        guard lstat(fileURL.path, &metadata) == 0 else {
            return errno == ENOENT ? .missing : .invalid
        }
        guard (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_size >= 0,
              metadata.st_size <= 32_768,
              let data = try? Data(contentsOf: fileURL, options: [.mappedIfSafe]),
              data.count == Int(metadata.st_size),
              let raw = try? JSONDecoder().decode([String].self, from: data),
              raw.count <= 128,
              Set(raw).count == raw.count,
              raw.allSatisfy(Self.isValidService) else { return .invalid }
        return .valid(Set(raw))
    }

    /// Returns true only when this call inserted a new service identifier.
    /// Callers can use that bit to roll the registry back if the subsequent
    /// Keychain operation fails.
    ///
    /// Only host-suffixed custom services are registered. Fixed LightningLoop
    /// services (for example GeneralCompute) are already in CredentialProvider.
    @discardableResult
    func register(profile: ProviderConfiguration) throws -> Bool {
        guard profile.allowsNativeConnectionTesting else { throw RegistryError.invalidService }
        guard profile.preset == .custom else { return false }
        let service = profile.credentialService
        guard Self.isValidService(service) else { throw RegistryError.invalidService }
        guard var values = state().services else { throw RegistryError.invalidState }
        guard !values.contains(service) else { return false }
        values.insert(service)
        guard values.count <= 128 else { throw RegistryError.capacityExceeded }
        try write(values)
        return true
    }

    func rollBackRegistration(profile: ProviderConfiguration) throws {
        guard profile.allowsNativeConnectionTesting else { throw RegistryError.invalidService }
        guard profile.preset == .custom else { return }
        guard Self.isValidService(profile.credentialService) else { throw RegistryError.invalidService }
        guard var values = state().services else { throw RegistryError.invalidState }
        values.remove(profile.credentialService)
        try write(values)
    }

    private func write(_ services: Set<String>) throws {
        guard services.count <= 128,
              services.allSatisfy(Self.isValidService),
              let data = try? JSONEncoder().encode(services.sorted()),
              data.count <= 32_768 else { throw RegistryError.capacityExceeded }
        let manager = FileManager.default
        let directory = fileURL.deletingLastPathComponent()
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var directoryMetadata = stat()
            guard lstat(directory.path, &directoryMetadata) == 0,
                  (directoryMetadata.st_mode & S_IFMT) == S_IFDIR else { throw RegistryError.writeFailed }
            if case .invalid = state() { throw RegistryError.invalidState }
            try data.write(to: fileURL, options: .atomic)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            guard case .valid(let written) = state(), written == services else { throw RegistryError.writeFailed }
        } catch let error as RegistryError {
            throw error
        } catch {
            throw RegistryError.writeFailed
        }
    }

    static func isValidService(_ service: String) -> Bool {
        service.range(of: #"^com\.barnlabs\.LightningLoop\.provider\.custom\.[a-z0-9-]{1,64}\.[a-z0-9.-]{3,253}\.apiKey$"#, options: .regularExpression) != nil
    }
}

enum CredentialServiceCatalog {
    /// Direct-provider services written by historical LightningLoop builds.
    /// They remain readable solely so persisted text can be filtered and
    /// sanitized. Current built-in authentication is runtime-managed, and no
    /// save/delete API accepts these service identifiers.
    static let historicalReadOnlyServices: Set<String> = [
        "com.barnlabs.LightningLoop.provider.xai.apiKey",
        "com.barnlabs.LightningLoop.provider.openai-codex.apiKey",
        "com.barnlabs.LightningLoop.provider.anthropic.apiKey"
    ]

    static func services(activeProfile: ProviderConfiguration, registry: CustomCredentialServiceRegistry = .init()) throws -> [String] {
        guard let registered = registry.state().services else {
            throw CustomCredentialServiceRegistry.RegistryError.invalidState
        }
        var values = Set(CredentialProvider.allCases.map(\.service))
        values.formUnion(historicalReadOnlyServices)
        values.formUnion(registered)
        if activeProfile.allowsNativeConnectionTesting { values.insert(activeProfile.credentialService) }
        return values.sorted()
    }
}

enum ProviderConfigurationError: LocalizedError, Equatable {
    case unsupportedVersion
    case invalidIdentifier
    case invalidName
    case unsafeURL
    case wrongPresetURL
    case invalidModel
    case invalidLimits
    case persistenceFailed
    case providerSelectionRequired
    case unreadableConfiguration

    var errorDescription: String? {
        switch self {
        case .unsupportedVersion: "The provider profile version is unsupported."
        case .invalidIdentifier: "The provider identifier may contain only lowercase letters, numbers, and hyphens."
        case .invalidName: "Enter a provider display name from 1 through 80 characters."
        case .unsafeURL: "Use a credential-free HTTPS base URL with no query or fragment."
        case .wrongPresetURL: "Preset providers must use their verified API endpoint. Choose Custom to use another endpoint."
        case .invalidModel: "Enter a model ID and display name."
        case .invalidLimits: "Context and output limits are outside LightningLoop’s safe bounds."
        case .providerSelectionRequired: "Choose and save an inference provider before starting LightningLoop."
        case .persistenceFailed: "The provider profile could not be saved to protected local storage."
        case .unreadableConfiguration: "The saved provider profile is malformed or unsafe. Review it in Settings."
        }
    }
}

struct ProviderConfigurationStore: Sendable {
    let fileURL: URL

    init(fileManager: FileManager = .default, fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            return
        }
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = support.appendingPathComponent("LightningLoop", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        self.fileURL = directory.appendingPathComponent("provider.json")
    }

    func load() -> ProviderConfiguration {
        (try? loadValidated()) ?? .onboarding
    }

    func loadValidated() throws -> ProviderConfiguration {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw ProviderConfigurationError.providerSelectionRequired
        }
        guard let data = try? Data(contentsOf: fileURL),
              let profile = try? JSONDecoder().decode(ProviderConfiguration.self, from: data) else {
            throw ProviderConfigurationError.unreadableConfiguration
        }
        return try validated(profile)
    }

    func save(_ profile: ProviderConfiguration) throws {
        let clean = try validated(profile)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder.encode(clean).write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch let error as ProviderConfigurationError {
            throw error
        } catch {
            throw ProviderConfigurationError.persistenceFailed
        }
    }

    func validated(_ profile: ProviderConfiguration) throws -> ProviderConfiguration {
        guard profile.preset != .selectionRequired else { throw ProviderConfigurationError.providerSelectionRequired }
        guard profile.schemaVersion == ProviderConfiguration.schemaVersion else { throw ProviderConfigurationError.unsupportedVersion }
        guard profile.id.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil else {
            throw ProviderConfigurationError.invalidIdentifier
        }
        let displayName = profile.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(displayName.count) else { throw ProviderConfigurationError.invalidName }
        let modelID = profile.modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelName = profile.modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...200).contains(modelID.count), (1...120).contains(modelName.count),
              !modelID.contains("\n"), !modelID.contains("\r") else { throw ProviderConfigurationError.invalidModel }
        guard var components = URLComponents(string: profile.baseURL), components.scheme == "https",
              components.host?.isEmpty == false, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { throw ProviderConfigurationError.unsafeURL }
        guard let host = components.host?.lowercased(), isPublicDNSName(host) else {
            throw ProviderConfigurationError.unsafeURL
        }
        let cleanPath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = cleanPath.isEmpty ? "" : "/\(cleanPath)"
        guard let normalizedURL = components.url?.absoluteString else { throw ProviderConfigurationError.unsafeURL }
        if profile.preset != .custom,
           normalizedURL != ProviderConfiguration.preset(profile.preset).baseURL {
            throw ProviderConfigurationError.wrongPresetURL
        }
        guard (1_024...2_000_000).contains(profile.contextWindow),
              (256...131_072).contains(profile.maxOutputTokens) else { throw ProviderConfigurationError.invalidLimits }
        var clean = profile
        clean.id = profile.preset == .custom ? profile.id : profile.preset.rawValue
        clean.displayName = displayName
        clean.baseURL = normalizedURL
        clean.modelID = modelID
        clean.modelName = modelName
        return clean
    }

    private func isPublicDNSName(_ host: String) -> Bool {
        guard host != "localhost", !host.hasSuffix(".localhost"), !host.hasSuffix(".local"),
              host.contains("."), !host.contains(":") else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        return labels.allSatisfy { label in
            !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        } && !labels.allSatisfy { $0.allSatisfy(\.isNumber) }
    }
}
