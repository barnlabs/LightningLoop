import Foundation

enum LoopStage: String, Codable, Sendable {
    case draft
    case clarifying
    case awaitingAnswers
    case planning
    case reviewingPlan
    case implementing
    case reviewingImplementation
    case completed
    case paused
    case failed

    var label: String {
        switch self {
        case .draft: "Draft"
        case .clarifying: "Clarifying"
        case .awaitingAnswers: "Needs answers"
        case .planning: "Planning"
        case .reviewingPlan: "Reviewing plan"
        case .implementing: "Implementing"
        case .reviewingImplementation: "Reviewing result"
        case .completed: "Gold"
        case .paused: "Needs attention"
        case .failed: "Failed"
        }
    }

    var symbol: String {
        switch self {
        case .completed: "checkmark.seal.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .paused: "pause.circle.fill"
        case .draft: "square.and.pencil"
        default: "arrow.trianglehead.2.clockwise.rotate.90"
        }
    }
}

struct ClarifyingQuestion: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let question: String
    let whyItMatters: String
}

struct Criterion: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let evidence: String
}

struct PlanStep: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let proof: String
}

struct ReviewFinding: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let severity: String
    let criterionID: String?
    let issue: String
    let requiredChange: String

    init(
        id: UUID = UUID(),
        severity: String,
        criterionID: String?,
        issue: String,
        requiredChange: String
    ) {
        self.id = id
        self.severity = severity
        self.criterionID = criterionID
        self.issue = issue
        self.requiredChange = requiredChange
    }
}

struct CriterionAssessment: Codable, Hashable, Sendable {
    let criterionID: String
    let status: String
    let evidence: String
    let evidenceRefs: [String]?

    enum CodingKeys: String, CodingKey {
        case status, evidence
        case evidenceRefs = "evidence_refs"
        case criterionID = "criterion_id"
    }
}

struct ReviewRecord: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let target: String
    let round: Int
    let score: Int
    let passed: Bool
    let summary: String
    let findings: [ReviewFinding]
    let requiredChanges: [String]
    let criterionAssessments: [CriterionAssessment]?

    init(
        id: UUID = UUID(),
        target: String,
        round: Int,
        score: Int,
        passed: Bool,
        summary: String,
        findings: [ReviewFinding],
        requiredChanges: [String],
        criterionAssessments: [CriterionAssessment]? = nil
    ) {
        self.id = id
        self.target = target
        self.round = round
        self.score = score
        self.passed = passed
        self.summary = summary
        self.findings = findings
        self.requiredChanges = requiredChanges
        self.criterionAssessments = criterionAssessments
    }
}

struct TimelineEntry: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let date: Date
    let role: AgentRole
    let title: String
    let summary: String
    let metrics: InferenceMetrics

    init(
        id: UUID = UUID(),
        date: Date = Date(),
        role: AgentRole,
        title: String,
        summary: String,
        metrics: InferenceMetrics
    ) {
        self.id = id
        self.date = date
        self.role = role
        self.title = title
        self.summary = summary
        self.metrics = metrics
    }
}

struct LoopSession: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var title: String
    /// How `title` was produced. Legacy archives default to provisional.
    var titleSource: SessionTitleSource
    /// When true, goal/plan/LLM auto-title updates are skipped until unlocked.
    var titleLocked: Bool
    var goal: String
    var clarifiedSummary: String
    var questions: [ClarifyingQuestion]
    var answers: [String: String]
    var criteria: [Criterion]
    var plan: [PlanStep]
    var risks: [String]
    var acceptanceTest: String
    var implementation: String
    var implementationNotes: [String]
    var reviews: [ReviewRecord]
    var timeline: [TimelineEntry]
    var stage: LoopStage
    var statusMessage: String
    var createdAt: Date
    var updatedAt: Date
    var metrics: InferenceMetrics
    var attachments: [ImageAttachment]
    var artifactWorkspacePath: String?
    var artifactVerificationCommands: Bool?
    var artifactReport: ArtifactExecutionReport?

    enum CodingKeys: String, CodingKey {
        case id, title, titleSource, titleLocked, goal, clarifiedSummary, questions, answers
        case criteria, plan, risks, acceptanceTest, implementation, implementationNotes
        case reviews, timeline, stage, statusMessage, createdAt, updatedAt, metrics, attachments
        case artifactWorkspacePath, artifactVerificationCommands, artifactReport
    }

    init(id: UUID = UUID(), goal: String = "") {
        self.id = id
        let provisional = SessionTitle.provisional(from: goal)
        self.title = provisional
        self.titleSource = goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .provisional : .provisional
        self.titleLocked = false
        self.goal = goal
        self.clarifiedSummary = ""
        self.questions = []
        self.answers = [:]
        self.criteria = []
        self.plan = []
        self.risks = []
        self.acceptanceTest = ""
        self.implementation = ""
        self.implementationNotes = []
        self.reviews = []
        self.timeline = []
        self.stage = .draft
        self.statusMessage = "Describe the result you want."
        self.createdAt = Date()
        self.updatedAt = Date()
        self.metrics = .init()
        self.attachments = []
        self.artifactWorkspacePath = nil
        self.artifactVerificationCommands = nil
        self.artifactReport = nil
        if !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.title = provisional
            self.titleSource = .provisional
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        titleSource = try container.decodeIfPresent(SessionTitleSource.self, forKey: .titleSource) ?? .provisional
        titleLocked = try container.decodeIfPresent(Bool.self, forKey: .titleLocked) ?? false
        goal = try container.decode(String.self, forKey: .goal)
        clarifiedSummary = try container.decodeIfPresent(String.self, forKey: .clarifiedSummary) ?? ""
        questions = try container.decodeIfPresent([ClarifyingQuestion].self, forKey: .questions) ?? []
        answers = try container.decodeIfPresent([String: String].self, forKey: .answers) ?? [:]
        criteria = try container.decodeIfPresent([Criterion].self, forKey: .criteria) ?? []
        plan = try container.decodeIfPresent([PlanStep].self, forKey: .plan) ?? []
        risks = try container.decodeIfPresent([String].self, forKey: .risks) ?? []
        acceptanceTest = try container.decodeIfPresent(String.self, forKey: .acceptanceTest) ?? ""
        implementation = try container.decodeIfPresent(String.self, forKey: .implementation) ?? ""
        implementationNotes = try container.decodeIfPresent([String].self, forKey: .implementationNotes) ?? []
        reviews = try container.decodeIfPresent([ReviewRecord].self, forKey: .reviews) ?? []
        timeline = try container.decodeIfPresent([TimelineEntry].self, forKey: .timeline) ?? []
        stage = try container.decodeIfPresent(LoopStage.self, forKey: .stage) ?? .draft
        statusMessage = try container.decodeIfPresent(String.self, forKey: .statusMessage) ?? ""
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
        metrics = try container.decodeIfPresent(InferenceMetrics.self, forKey: .metrics) ?? .init()
        attachments = try container.decodeIfPresent([ImageAttachment].self, forKey: .attachments) ?? []
        artifactWorkspacePath = try container.decodeIfPresent(String.self, forKey: .artifactWorkspacePath)
        artifactVerificationCommands = try container.decodeIfPresent(Bool.self, forKey: .artifactVerificationCommands)
        artifactReport = try container.decodeIfPresent(ArtifactExecutionReport.self, forKey: .artifactReport)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(titleSource, forKey: .titleSource)
        try container.encode(titleLocked, forKey: .titleLocked)
        try container.encode(goal, forKey: .goal)
        try container.encode(clarifiedSummary, forKey: .clarifiedSummary)
        try container.encode(questions, forKey: .questions)
        try container.encode(answers, forKey: .answers)
        try container.encode(criteria, forKey: .criteria)
        try container.encode(plan, forKey: .plan)
        try container.encode(risks, forKey: .risks)
        try container.encode(acceptanceTest, forKey: .acceptanceTest)
        try container.encode(implementation, forKey: .implementation)
        try container.encode(implementationNotes, forKey: .implementationNotes)
        try container.encode(reviews, forKey: .reviews)
        try container.encode(timeline, forKey: .timeline)
        try container.encode(stage, forKey: .stage)
        try container.encode(statusMessage, forKey: .statusMessage)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encode(metrics, forKey: .metrics)
        try container.encode(attachments, forKey: .attachments)
        try container.encodeIfPresent(artifactWorkspacePath, forKey: .artifactWorkspacePath)
        try container.encodeIfPresent(artifactVerificationCommands, forKey: .artifactVerificationCommands)
        try container.encodeIfPresent(artifactReport, forKey: .artifactReport)
    }
}

struct PlanningDraft: Codable, Sendable {
    var criteria: [Criterion]
    var plan: [PlanStep]
    var risks: [String]
    var acceptanceTest: String

    enum CodingKeys: String, CodingKey {
        case criteria, plan, risks
        case acceptanceTest = "acceptance_test"
    }
}

struct ImplementationDraft: Codable, Sendable {
    var deliverable: String
    var notes: [String]
    var files: [ArtifactFileDraft]? = nil
    var verificationCommands: [VerificationCommandDraft]? = nil
}

struct ArtifactFileDraft: Codable, Hashable, Sendable {
    let path: String
    let content: String
}

struct VerificationCommandDraft: Codable, Hashable, Sendable {
    let executable: String
    let arguments: [String]
    let purpose: String
}

struct ArtifactFileEvidence: Codable, Hashable, Sendable {
    let path: String
    let bytes: Int
    let sha256: String
}

struct VerificationCommandEvidence: Codable, Hashable, Sendable {
    let executable: String
    let arguments: [String]
    let purpose: String
    let exitCode: Int?
    let output: String
    let passed: Bool
    let origin: String?
    let durationMs: Int?
}

struct ArtifactLoopbackEvidence: Codable, Hashable, Sendable {
    let scheme: String
    let host: String
    let status: Int
    let contentType: String
    let bytes: Int
    let sha256: String
}

struct ArtifactPreviewEvidence: Codable, Hashable, Sendable {
    let kind: String
    let title: String
    let sourcePath: String
    let previewPath: String
    let mimeType: String
    let passed: Bool
    let message: String
    let width: Int?
    let height: Int?
    let loopback: ArtifactLoopbackEvidence?
}

struct ArtifactWorkspaceAudit: Codable, Hashable, Sendable {
    let passed: Bool
    let files: Int
    let bytes: Int
    let message: String
}

struct ArtifactExecutionReport: Codable, Hashable, Sendable {
    let enabled: Bool
    let passed: Bool
    let summary: String
    let files: [ArtifactFileEvidence]
    let commands: [VerificationCommandEvidence]
    let previews: [ArtifactPreviewEvidence]?
    let workspaceAudit: ArtifactWorkspaceAudit
}

struct ReviewDraft: Encodable, Sendable {
    var score: Int
    var passed: Bool
    var summary: String
    var findings: [ReviewFinding]
    var requiredChanges: [String]
    var criterionAssessments: [CriterionAssessment]
    var researchQueries: [String]

    enum CodingKeys: String, CodingKey {
        case score, passed, summary, findings
        case requiredChanges = "required_changes"
        case criterionAssessments = "criteria"
        case researchQueries = "research_queries"
    }
}
