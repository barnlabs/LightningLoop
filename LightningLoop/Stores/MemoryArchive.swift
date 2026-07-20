import Foundation

@MainActor
struct MemoryArchive {
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
            self.fileURL = directory.appendingPathComponent("memory.json")
        }
    }

    func load() -> [MemoryRecord] {
        loadForMutation() ?? []
    }

    /// Returns nil for malformed, oversized, linked, or unreadable storage so a
    /// UI mutation cannot silently replace a ledger that failed to decode.
    func loadForMutation() -> [MemoryRecord]? {
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
        guard let records = try? decoder.decode([MemoryRecord].self, from: data), records.count <= 500 else { return nil }
        return records
    }

    @discardableResult
    func save(_ records: [MemoryRecord]) -> Bool {
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

protocol MemoryContextServing: Sendable {
    func eligibleMemory(for runID: UUID?) -> [String]
}

struct ActiveMemoryReader: MemoryContextServing, Sendable {
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
            self.fileURL = support.appendingPathComponent("LightningLoop/memory.json")
        }
    }

    func eligibleMemory(for runID: UUID?) -> [String] {
        guard credentialRegistry.state().services != nil,
              let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= 1_048_576,
              let data = try? Data(contentsOf: fileURL, options: [.mappedIfSafe]), data.count == size else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let records = try? decoder.decode([MemoryRecord].self, from: data), records.count <= 500 else { return [] }
        guard let sanitizer = try? CredentialTextSanitizer(
            activeProfile: providerProfile,
            registry: credentialRegistry,
            credentialReader: credentialReader
        ) else { return [] }
        let now = Date()
        return records
            .filter { record in
                guard record.verification != .contradicted,
                      record.supersededBy == nil,
                      record.expiresAt.map({ $0 > now }) ?? true,
                      !Self.containsSecretShape(record.statement),
                      !Self.containsSecretShape(record.sourceArtifact),
                      !sanitizer.containsCredential(in: [record.statement, record.sourceArtifact]) else { return false }
                switch record.scope {
                case .run:
                    return runID != nil && record.sourceRunID == runID
                case .project, .user:
                    return record.promotionApprovedByUser
                }
            }
            .sorted { left, right in
                let weights: [MemoryScope: Int] = [.run: 3, .project: 2, .user: 1]
                let leftWeight = weights[left.scope] ?? 0
                let rightWeight = weights[right.scope] ?? 0
                return leftWeight == rightWeight ? left.confidence > right.confidence : leftWeight > rightWeight
            }
            .prefix(12)
            .map { "[\($0.scope.rawValue); source: \(String($0.sourceArtifact.prefix(200)))] \(String($0.statement.prefix(1_000)))" }
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
