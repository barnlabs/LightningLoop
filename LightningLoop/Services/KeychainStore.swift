import Foundation
import Security

enum CredentialProvider: String, CaseIterable, Identifiable, Sendable {
    case cerebras
    case groq
    case fireworks
    case generalcompute
    case openrouter
    case custom
    case exa
    case brave
    case firecrawl

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cerebras: "Cerebras Inference"
        case .groq: "Groq Inference"
        case .fireworks: "Fireworks Inference"
        case .generalcompute: "GeneralCompute"
        case .openrouter: "OpenRouter"
        case .custom: "Custom Inference"
        case .exa: "Exa Search"
        case .brave: "Brave Search"
        case .firecrawl: "Firecrawl"
        }
    }

    var purpose: String {
        switch self {
        case .cerebras: "Cerebras-hosted models"
        case .groq: "Groq-hosted models"
        case .fireworks: "Fireworks-hosted models"
        case .generalcompute: "GeneralCompute OpenAI-compatible models"
        case .openrouter: "OpenRouter models, including just-free discovery"
        case .custom: "Your OpenAI-compatible endpoint"
        case .exa: "Neural and research-oriented search"
        case .brave: "Independent-index web search"
        case .firecrawl: "Search with optional page extraction"
        }
    }

    var service: String {
        switch self {
        case .cerebras: "com.barnlabs.LightningLoop.provider.cerebras.apiKey"
        case .groq: "com.barnlabs.LightningLoop.provider.groq.apiKey"
        case .fireworks: "com.barnlabs.LightningLoop.provider.fireworks.apiKey"
        case .generalcompute: "com.barnlabs.LightningLoop.provider.generalcompute.apiKey"
        case .openrouter: "com.barnlabs.LightningLoop.provider.openrouter.apiKey"
        case .custom: "com.barnlabs.LightningLoop.provider.custom.apiKey"
        case .exa: "com.barnlabs.LightningLoop.search.exa"
        case .brave: "com.barnlabs.LightningLoop.search.brave"
        case .firecrawl: "com.barnlabs.LightningLoop.search.firecrawl"
        }
    }

    static var inferenceCases: [CredentialProvider] { [.cerebras, .groq, .fireworks, .generalcompute, .openrouter, .custom] }
    static var searchCases: [CredentialProvider] { [.exa, .brave, .firecrawl] }
}

enum KeychainStoreError: LocalizedError, Equatable {
    case unexpectedStatus(OSStatus)
    case invalidData
    case piManagedProfile
    case invalidService
    case invalidCredentialLength

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            "Keychain operation failed (OSStatus \(status))."
        case .invalidData:
            "The stored credential could not be read."
        case .piManagedProfile:
            "This preset is managed by the LightningLoop runtime. Start the shared runtime and complete the provider sign-in flow instead of storing a LightningLoop API key."
        case .invalidService:
            "The requested credential service is not owned by LightningLoop."
        case .invalidCredentialLength:
            "Credentials must contain 8 through 4096 non-whitespace characters."
        }
    }
}

struct KeychainStore: Sendable {
    let account: String

    init(account: String = NSUserName()) {
        self.account = account
    }

    func readCredential(for provider: CredentialProvider) throws -> String? {
        try readCredential(service: provider.service)
    }

    func readCredential(for profile: ProviderConfiguration) throws -> String? {
        guard profile.allowsNativeConnectionTesting else { throw KeychainStoreError.piManagedProfile }
        return try readCredential(service: profile.credentialService)
    }

    func readCredential(service: String) throws -> String? {
        guard try CredentialServiceCatalog.services(activeProfile: .onboarding).contains(service)
                || CustomCredentialServiceRegistry.isValidService(service) else { throw KeychainStoreError.invalidService }
        let query = Self.nonInteractiveQuery(service: service, account: account, returnData: true)

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound || Self.isNonInteractiveDenial(status) { return nil }
        guard status == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainStoreError.invalidData
        }
        guard value.count <= CredentialTextSanitizer.maximumCredentialLength else {
            throw KeychainStoreError.invalidData
        }
        return value
    }

    func hasCredential(for provider: CredentialProvider) throws -> Bool {
        try hasCredential(service: provider.service)
    }

    func hasCredential(for profile: ProviderConfiguration) throws -> Bool {
        guard profile.allowsNativeConnectionTesting else { return false }
        return try hasCredential(service: profile.credentialService)
    }

    func hasCredential(service: String) throws -> Bool {
        guard try CredentialServiceCatalog.services(activeProfile: .onboarding).contains(service)
                || CustomCredentialServiceRegistry.isValidService(service) else { throw KeychainStoreError.invalidService }
        let query = Self.nonInteractiveQuery(service: service, account: account, returnData: false)
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        if status == errSecItemNotFound || Self.isNonInteractiveDenial(status) { return false }
        guard status == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(status) }
        return true
    }

    /// Presence and read fail instead of showing a Keychain password dialog.
    /// Writes (`saveCredential`) keep the default UI because the user is storing a key.
    static func nonInteractiveQuery(service: String, account: String, returnData: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail
        ]
        if returnData { query[kSecReturnData as String] = true }
        return query
    }

    static func isNonInteractiveDenial(_ status: OSStatus) -> Bool {
        status == errSecInteractionNotAllowed || status == errSecUserCanceled || status == errSecAuthFailed
    }

    func saveCredential(_ value: String, for provider: CredentialProvider) throws {
        // Pi-managed API-key presets only. GeneralCompute and custom are LightningLoop-owned.
        guard ![CredentialProvider.cerebras, .groq, .fireworks].contains(provider) else {
            throw KeychainStoreError.piManagedProfile
        }
        try saveCredential(value, service: provider.service)
    }

    func saveCredential(_ value: String, for profile: ProviderConfiguration) throws {
        guard profile.allowsNativeConnectionTesting else { throw KeychainStoreError.piManagedProfile }
        try saveCredential(value, service: profile.credentialService)
    }

    private func saveCredential(_ value: String, service: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (CredentialTextSanitizer.minimumCredentialLength...CredentialTextSanitizer.maximumCredentialLength).contains(trimmed.count) else {
            throw KeychainStoreError.invalidCredentialLength
        }
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(trimmed.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var addQuery = baseQuery
            attributes.forEach { addQuery[$0.key] = $0.value }
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(addStatus) }
        } else if updateStatus != errSecSuccess {
            throw KeychainStoreError.unexpectedStatus(updateStatus)
        }
    }

    func deleteCredential(for provider: CredentialProvider) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: provider.service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    func deleteCredential(for profile: ProviderConfiguration) throws {
        guard profile.allowsNativeConnectionTesting else { throw KeychainStoreError.piManagedProfile }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: profile.credentialService,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

}

/// A snapshot of the currently configured LightningLoop-owned credentials.
/// Callers create a fresh value at each trust boundary so newly-added or
/// rotated credentials cannot be missed by a long-lived reader.
struct CredentialTextSanitizer: Sendable {
    static let minimumCredentialLength = 8
    static let maximumCredentialLength = 4_096

    private let credentials: [String]
    private static let secretPatterns = [
        #"\bcsk-[A-Za-z0-9_-]{12,}\b"#,
        #"\bgsk_[A-Za-z0-9_-]{12,}\b"#,
        #"\bfc-[A-Za-z0-9_-]{12,}\b"#,
        #"\bBearer\s+[A-Za-z0-9._~+/=-]{1,4096}"#,
        #"(?i)\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{1,4096}"#
    ]

    init(
        activeProfile: ProviderConfiguration,
        registry: CustomCredentialServiceRegistry,
        credentialReader: @Sendable (String) throws -> String?
    ) throws {
        let services = try CredentialServiceCatalog.services(activeProfile: activeProfile, registry: registry)
        var values: [String] = []
        for service in services {
            guard let value = try credentialReader(service), !value.isEmpty else { continue }
            guard value.count <= Self.maximumCredentialLength else { throw KeychainStoreError.invalidData }
            values.append(value)
        }
        self.credentials = Array(Set(values)).sorted { $0.count > $1.count }
    }

    func containsCredential(in values: [String]) -> Bool {
        credentials.contains { credential in values.contains { $0.contains(credential) } }
    }

    func sanitize(_ value: String) -> String {
        var clean = value
        for pattern in Self.secretPatterns {
            clean = clean.replacingOccurrences(of: pattern, with: "[REDACTED]", options: .regularExpression)
        }
        for credential in credentials {
            clean = clean.replacingOccurrences(of: credential, with: "[REDACTED]")
        }
        return clean
    }

    static func failClosed(_ value: String) -> String {
        value.isEmpty ? value : "[REDACTED: credential catalog unavailable]"
    }
}
