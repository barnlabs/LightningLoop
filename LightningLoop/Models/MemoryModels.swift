import Foundation

enum MemoryScope: String, Codable, CaseIterable, Identifiable {
    case run
    case project
    case user

    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

enum MemoryVerification: String, Codable {
    case unverified
    case sourceBacked = "source_backed"
    case verified
    case contradicted

    var label: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }
}

struct MemoryRecord: Identifiable, Codable, Hashable {
    let id: UUID
    var scope: MemoryScope
    var statement: String
    var tags: [String]
    var sourceArtifact: String
    var sourceRunID: UUID?
    var confidence: Double
    var verification: MemoryVerification
    var createdAt: Date
    var reviewedAt: Date?
    var expiresAt: Date?
    var supersededBy: UUID?
    var promotionApprovedByUser: Bool

    init(
        id: UUID = UUID(),
        scope: MemoryScope,
        statement: String,
        tags: [String],
        sourceArtifact: String,
        sourceRunID: UUID? = nil,
        confidence: Double = 1,
        verification: MemoryVerification = .unverified,
        createdAt: Date = Date(),
        reviewedAt: Date? = nil,
        expiresAt: Date? = nil,
        supersededBy: UUID? = nil,
        promotionApprovedByUser: Bool
    ) {
        self.id = id
        self.scope = scope
        self.statement = statement
        self.tags = tags
        self.sourceArtifact = sourceArtifact
        self.sourceRunID = sourceRunID
        self.confidence = min(max(confidence, 0), 1)
        self.verification = verification
        self.createdAt = createdAt
        self.reviewedAt = reviewedAt
        self.expiresAt = expiresAt
        self.supersededBy = supersededBy
        self.promotionApprovedByUser = promotionApprovedByUser
    }

    var isEligible: Bool {
        let unexpired = expiresAt.map { $0 > Date() } ?? true
        return verification != .contradicted
            && supersededBy == nil
            && unexpired
            && (scope == .run || promotionApprovedByUser)
    }

    func isEligible(for runID: UUID?) -> Bool {
        isEligible && (scope != .run || (runID != nil && sourceRunID == runID))
    }
}
