import Foundation

enum EvolutionKind: String, Codable, CaseIterable, Identifiable {
    case systemPrompt = "system_prompt"
    case skill
    case tool
    case mcp
    case memoryPolicy = "memory_policy"

    var id: String { rawValue }
    var label: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }
}

enum EvolutionState: String, Codable {
    case draft
    case sourceReviewed = "source_reviewed"
    case sandboxTested = "sandbox_tested"
    case adversariallyReviewed = "adversarially_reviewed"
    case userApproved = "user_approved"
    case active
    case superseded
    case rolledBack = "rolled_back"

    var label: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }

    var next: EvolutionState? {
        switch self {
        case .draft: .sourceReviewed
        case .sourceReviewed: .sandboxTested
        case .sandboxTested: .adversariallyReviewed
        case .adversariallyReviewed: .userApproved
        case .userApproved: .active
        case .active: .superseded
        case .superseded, .rolledBack: nil
        }
    }
}

struct EvolutionProposal: Identifiable, Codable, Hashable {
    let id: UUID
    var kind: EvolutionKind
    var name: String
    var version: String
    var state: EvolutionState
    var source: String
    var reason: String
    var exactDiff: String
    var permissions: [String]
    var evaluationSuite: String
    var evaluationSummary: String?
    var reviewerHasMaterialFinding: Bool
    var rollbackTarget: String?
    var createdAt: Date
    var activatedAt: Date?

    init(kind: EvolutionKind, name: String, source: String, reason: String, exactDiff: String) {
        self.id = UUID()
        self.kind = kind
        self.name = name
        self.version = "0.1.0-draft"
        self.state = .draft
        self.source = source
        self.reason = reason
        self.exactDiff = exactDiff
        self.permissions = []
        self.evaluationSuite = "Not yet assigned"
        self.evaluationSummary = nil
        self.reviewerHasMaterialFinding = false
        self.rollbackTarget = nil
        self.createdAt = Date()
        self.activatedAt = nil
    }

    var canActivate: Bool {
        state == .userApproved
            && evaluationSummary?.isEmpty == false
            && rollbackTarget?.isEmpty == false
            && !reviewerHasMaterialFinding
    }

    var canRecordSandboxPass: Bool {
        state == .sourceReviewed
            && evaluationSuite.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && evaluationSummary?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    var canRecordAdversarialReview: Bool {
        state == .sandboxTested && !reviewerHasMaterialFinding
    }
}
