import Foundation

enum LoopEngineError: LocalizedError, Equatable {
    case malformedModelOutput(String)
    case emptyGoal
    case workspaceArtifactsRequireSharedHarness
    case sharedHarnessRequired

    var errorDescription: String? {
        switch self {
        case .malformedModelOutput(let detail):
            "The model returned invalid structured output: \(detail)"
        case .emptyGoal:
            "Enter a goal before starting the loop."
        case .workspaceArtifactsRequireSharedHarness:
            "Workspace artifacts require the shared LightningLoop harness."
        case .sharedHarnessRequired:
            "Clarification and execution require the shared LightningLoop harness. Native custom-provider access is limited to explicit connection testing in Settings."
        }
    }
}

struct ClarificationResult: Sendable {
    let summary: String
    let questions: [ClarifyingQuestion]
    let timeline: TimelineEntry
}

enum LoopEngineEvent: Sendable {
    case phase(LoopStage, String)
    case timeline(TimelineEntry)
    case planning(PlanningDraft)
    case review(ReviewRecord)
    case implementation(ImplementationDraft)
}

struct LoopExecutionResult: Sendable {
    let planning: PlanningDraft
    let implementation: ImplementationDraft
    let completed: Bool
    let finalMessage: String
    let artifactReport: ArtifactExecutionReport?

    init(
        planning: PlanningDraft,
        implementation: ImplementationDraft,
        completed: Bool,
        finalMessage: String,
        artifactReport: ArtifactExecutionReport? = nil
    ) {
        self.planning = planning
        self.implementation = implementation
        self.completed = completed
        self.finalMessage = finalMessage
        self.artifactReport = artifactReport
    }
}

protocol LoopServicing: Sendable {
    func clarify(goal: String, attachments: [ImageAttachment], runID: UUID?) async throws -> ClarificationResult
    func execute(
        goal: String,
        summary: String,
        questions: [ClarifyingQuestion],
        answers: [String: String],
        maxReviewCycles: Int,
        attachments: [ImageAttachment],
        researchProvider: String?,
        artifactWorkspace: String?,
        approveArtifactWrites: Bool,
        approveVerificationCommands: Bool,
        runID: UUID?,
        emit: @escaping @Sendable (LoopEngineEvent) async -> Void
    ) async throws -> LoopExecutionResult
}

/// Compatibility boundary for source builds that cannot discover the shared
/// Pi harness. It deliberately retains the former initializer shape so callers
/// cannot accidentally regain native orchestration by supplying dependencies.
/// The dependencies are never retained or invoked.
struct LoopEngine: LoopServicing, Sendable {
    init(
        agent: any AgentServing,
        research: (any ResearchServing)? = nil,
        promptEvolution: (any PromptEvolutionServing)? = nil,
        memoryContext: (any MemoryContextServing)? = nil
    ) {
        _ = agent
        _ = research
        _ = promptEvolution
        _ = memoryContext
    }

    func clarify(
        goal: String,
        attachments: [ImageAttachment] = [],
        runID: UUID? = nil
    ) async throws -> ClarificationResult {
        throw LoopEngineError.sharedHarnessRequired
    }

    func execute(
        goal: String,
        summary: String,
        questions: [ClarifyingQuestion] = [],
        answers: [String: String],
        maxReviewCycles: Int,
        attachments: [ImageAttachment] = [],
        researchProvider: String? = nil,
        artifactWorkspace: String? = nil,
        approveArtifactWrites: Bool = false,
        approveVerificationCommands: Bool = false,
        runID: UUID? = nil,
        emit: @escaping @Sendable (LoopEngineEvent) async -> Void
    ) async throws -> LoopExecutionResult {
        .init(
            planning: .init(criteria: [], plan: [], risks: [], acceptanceTest: ""),
            implementation: .init(deliverable: "", notes: []),
            completed: false,
            finalMessage: LoopEngineError.sharedHarnessRequired.localizedDescription
        )
    }
}
