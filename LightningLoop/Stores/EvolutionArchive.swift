import Foundation

@MainActor
struct EvolutionArchive {
    private let fileURL: URL
    private let credentialRegistry: CustomCredentialServiceRegistry

    init(fileManager: FileManager = .default, fileURL: URL? = nil, credentialRegistry: CustomCredentialServiceRegistry = .init()) {
        self.credentialRegistry = credentialRegistry
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let directory = support.appendingPathComponent("LightningLoop", isDirectory: true)
            try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            self.fileURL = directory.appendingPathComponent("evolutions.json")
        }
    }

    func load() -> [EvolutionProposal] {
        loadForMutation() ?? []
    }

    /// Returns nil for malformed, oversized, linked, or unreadable storage so a
    /// UI mutation cannot silently replace a ledger that failed to decode.
    func loadForMutation() -> [EvolutionProposal]? {
        guard credentialRegistry.state().services != nil else { return nil }
        let source = fileURL
        guard FileManager.default.fileExists(atPath: source.path) else { return [] }
        guard let values = try? source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true,
              (values.fileSize ?? 0) <= 1_048_576,
              let data = try? Data(contentsOf: source) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let records = try? decoder.decode([EvolutionProposal].self, from: data), records.count <= 500 else { return nil }
        return records
    }

    @discardableResult
    func save(_ records: [EvolutionProposal]) -> Bool {
        guard credentialRegistry.state().services != nil else { return false }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(records) else { return false }
        do {
            try data.write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            return true
        } catch {
            return false
        }
    }
}

protocol PromptEvolutionServing: Sendable {
    func activeSystemPromptAddenda() -> [String]
    func activeSkillGuidance() -> [String]
}

struct ActiveEvolutionReader: PromptEvolutionServing, Sendable {
    private let fileURL: URL
    private let providerProfile: ProviderConfiguration
    private let credentialRegistry: CustomCredentialServiceRegistry
    private let credentialReader: @Sendable (String) throws -> String?

    init(
        fileManager: FileManager = .default,
        fileURL: URL? = nil,
        keychain: KeychainStore = .init(),
        providerProfile: ProviderConfiguration = .onboarding,
        credentialRegistry: CustomCredentialServiceRegistry = .init(),
        credentialReader: (@Sendable (String) throws -> String?)? = nil
    ) {
        self.providerProfile = providerProfile
        self.credentialRegistry = credentialRegistry
        self.credentialReader = credentialReader ?? { service in try keychain.readCredential(service: service) }
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            self.fileURL = support.appendingPathComponent("LightningLoop/evolutions.json")
        }
    }

    func activeSystemPromptAddenda() -> [String] {
        activeContent(for: .systemPrompt)
    }

    func activeSkillGuidance() -> [String] {
        activeContent(for: .skill)
    }

    private func activeContent(for kind: EvolutionKind) -> [String] {
        guard credentialRegistry.state().services != nil,
              let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= 1_048_576,
              let data = try? Data(contentsOf: fileURL, options: [.mappedIfSafe]), data.count == size else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let proposals = try? decoder.decode([EvolutionProposal].self, from: data), proposals.count <= 500 else { return [] }
        guard let sanitizer = try? CredentialTextSanitizer(
            activeProfile: providerProfile,
            registry: credentialRegistry,
            credentialReader: credentialReader
        ) else { return [] }
        return proposals
            .filter { $0.kind == kind && $0.state == .active }
            .filter { proposal in
                !Self.containsSecretShape(proposal.exactDiff)
                    && !sanitizer.containsCredential(in: [proposal.exactDiff])
            }
            .sorted { ($0.activatedAt ?? .distantPast) < ($1.activatedAt ?? .distantPast) }
            .prefix(5)
            .map { String($0.exactDiff.prefix(8_000)) }
    }

    private static func containsSecretShape(_ value: String) -> Bool {
        [
            #"\bcsk-[A-Za-z0-9_-]{12,}\b"#,
            #"\bgsk_[A-Za-z0-9_-]{12,}\b"#,
            #"\bfc-[A-Za-z0-9_-]{12,}\b"#,
            #"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"#
        ].contains { value.range(of: $0, options: .regularExpression) != nil }
    }
}
