import Foundation

enum LoopEngineError: LocalizedError {
    case malformedModelOutput(String)
    case emptyGoal

    var errorDescription: String? {
        switch self {
        case .malformedModelOutput(let detail): "The model returned invalid structured output: \(detail)"
        case .emptyGoal: "Enter a goal before starting the loop."
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
}

struct LoopEngine: Sendable {
    private let agent: any AgentServing

    init(agent: any AgentServing) {
        self.agent = agent
    }

    func clarify(goal: String) async throws -> ClarificationResult {
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LoopEngineError.emptyGoal }
        let reply = try await agent.complete(LoopPrompts.clarification(goal: trimmed))
        let envelope: ClarificationEnvelope = try decode(reply.content)
        let questions = envelope.questions.enumerated().map { index, question in
            ClarifyingQuestion(
                id: question.id.isEmpty ? "Q\(index + 1)" : question.id,
                question: question.question,
                whyItMatters: question.whyItMatters
            )
        }
        return .init(
            summary: envelope.summary,
            questions: questions,
            timeline: .init(
                role: .orchestrator,
                title: "Clarified the objective",
                summary: "Raised \(questions.count) decision-critical question\(questions.count == 1 ? "" : "s").",
                metrics: reply.metrics
            )
        )
    }

    func execute(
        goal: String,
        summary: String,
        answers: [String: String],
        maxReviewCycles: Int,
        emit: @escaping @Sendable (LoopEngineEvent) async -> Void
    ) async throws -> LoopExecutionResult {
        let cycleLimit = min(max(maxReviewCycles, 1), 8)
        try Task.checkCancellation()
        await emit(.phase(.planning, "Building falsifiable criteria and an execution plan…"))

        let planningReply = try await agent.complete(LoopPrompts.planning(goal: goal, summary: summary, answers: answers))
        var planning = try parsePlanning(planningReply.content)
        await emit(.planning(planning))
        await emit(.timeline(.init(
            role: .orchestrator,
            title: "Built the execution contract",
            summary: "Defined \(planning.criteria.count) criteria and \(planning.plan.count) plan steps.",
            metrics: planningReply.metrics
        )))

        var planPassed = false
        for round in 1...cycleLimit {
            try Task.checkCancellation()
            await emit(.phase(.reviewingPlan, "Gold Reviewer is challenging plan round \(round)…"))
            let reply = try await agent.complete(LoopPrompts.reviewPlan(goal: goal, draft: planning, round: round))
            let review = try parseReview(reply.content)
            let record = reviewRecord(from: review, target: "Plan", round: round)
            await emit(.review(record))
            await emit(.timeline(.init(
                role: .reviewer,
                title: review.passed ? "Approved plan round \(round)" : "Rejected plan round \(round)",
                summary: "Score \(review.score)/10 · \(review.summary)",
                metrics: reply.metrics
            )))
            if review.passed {
                planPassed = true
                break
            }
            guard round < cycleLimit else { break }
            await emit(.phase(.planning, "Orchestrator is repairing every plan defect…"))
            let revisionReply = try await agent.complete(LoopPrompts.revisePlan(goal: goal, draft: planning, review: review))
            planning = try parsePlanning(revisionReply.content)
            await emit(.planning(planning))
            await emit(.timeline(.init(
                role: .orchestrator,
                title: "Reworked the plan",
                summary: "Applied the reviewer’s required changes before round \(round + 1).",
                metrics: revisionReply.metrics
            )))
        }

        guard planPassed else {
            return .init(
                planning: planning,
                implementation: .init(deliverable: "", notes: []),
                completed: false,
                finalMessage: "Paused after \(cycleLimit) plan review cycles. Resolve the remaining findings, then run again."
            )
        }

        try Task.checkCancellation()
        await emit(.phase(.implementing, "Implementer is producing the complete deliverable…"))
        let implementationReply = try await agent.complete(LoopPrompts.implement(goal: goal, draft: planning))
        var implementation = try parseImplementation(implementationReply.content)
        await emit(.implementation(implementation))
        await emit(.timeline(.init(
            role: .implementer,
            title: "Produced the first implementation",
            summary: "Submitted a complete artifact for criterion-by-criterion review.",
            metrics: implementationReply.metrics
        )))

        var implementationPassed = false
        for round in 1...cycleLimit {
            try Task.checkCancellation()
            await emit(.phase(.reviewingImplementation, "Gold Reviewer is auditing implementation round \(round)…"))
            let reply = try await agent.complete(
                LoopPrompts.reviewImplementation(goal: goal, draft: planning, implementation: implementation, round: round)
            )
            let review = try parseReview(reply.content)
            let record = reviewRecord(from: review, target: "Implementation", round: round)
            await emit(.review(record))
            await emit(.timeline(.init(
                role: .reviewer,
                title: review.passed ? "Awarded gold on round \(round)" : "Rejected implementation round \(round)",
                summary: "Score \(review.score)/10 · \(review.summary)",
                metrics: reply.metrics
            )))
            if review.passed {
                implementationPassed = true
                break
            }
            guard round < cycleLimit else { break }
            await emit(.phase(.implementing, "Implementer is fixing every cited defect…"))
            let revisionReply = try await agent.complete(
                LoopPrompts.reviseImplementation(
                    goal: goal,
                    draft: planning,
                    implementation: implementation,
                    review: review
                )
            )
            implementation = try parseImplementation(revisionReply.content)
            await emit(.implementation(implementation))
            await emit(.timeline(.init(
                role: .implementer,
                title: "Revised the implementation",
                summary: "Applied all required changes before round \(round + 1).",
                metrics: revisionReply.metrics
            )))
        }

        return .init(
            planning: planning,
            implementation: implementation,
            completed: implementationPassed,
            finalMessage: implementationPassed
                ? "Gold standard reached. Every criterion passed strict review."
                : "Paused after \(cycleLimit) implementation review cycles. The remaining findings are preserved."
        )
    }
}

private extension LoopEngine {
    struct ClarificationEnvelope: Decodable {
        struct Question: Decodable {
            let id: String
            let question: String
            let whyItMatters: String
            enum CodingKeys: String, CodingKey { case id, question, whyItMatters = "why_it_matters" }
        }
        let summary: String
        let questions: [Question]
    }

    struct PlanningEnvelope: Decodable {
        struct RawCriterion: Decodable { let id: String; let title: String; let detail: String; let evidence: String }
        struct RawStep: Decodable { let id: String; let title: String; let detail: String; let proof: String }
        let criteria: [RawCriterion]
        let plan: [RawStep]
        let risks: [String]
        let acceptanceTest: String
        enum CodingKeys: String, CodingKey { case criteria, plan, risks, acceptanceTest = "acceptance_test" }
    }

    struct ReviewEnvelope: Decodable {
        struct RawFinding: Decodable {
            let severity: String
            let criterionID: String?
            let issue: String
            let requiredChange: String
            enum CodingKeys: String, CodingKey {
                case severity, issue
                case criterionID = "criterion_id"
                case requiredChange = "required_change"
            }
        }
        let verdict: String
        let score: Int
        let summary: String
        let findings: [RawFinding]
        let requiredChanges: [String]
        enum CodingKeys: String, CodingKey { case verdict, score, summary, findings, requiredChanges = "required_changes" }
    }

    struct ImplementationEnvelope: Decodable {
        let deliverable: String
        let notes: [String]
    }

    func parsePlanning(_ content: String) throws -> PlanningDraft {
        let envelope: PlanningEnvelope = try decode(content)
        guard !envelope.criteria.isEmpty, !envelope.plan.isEmpty, !envelope.acceptanceTest.isEmpty else {
            throw LoopEngineError.malformedModelOutput("Planning contract was incomplete.")
        }
        return .init(
            criteria: envelope.criteria.enumerated().map { index, item in
                .init(id: item.id.isEmpty ? "C\(index + 1)" : item.id, title: item.title, detail: item.detail, evidence: item.evidence)
            },
            plan: envelope.plan.enumerated().map { index, item in
                .init(id: item.id.isEmpty ? "P\(index + 1)" : item.id, title: item.title, detail: item.detail, proof: item.proof)
            },
            risks: envelope.risks,
            acceptanceTest: envelope.acceptanceTest
        )
    }

    func parseReview(_ content: String) throws -> ReviewDraft {
        let envelope: ReviewEnvelope = try decode(content)
        let findings = envelope.findings.map {
            ReviewFinding(severity: $0.severity, criterionID: $0.criterionID, issue: $0.issue, requiredChange: $0.requiredChange)
        }
        let score = min(max(envelope.score, 0), 10)
        let hasMaterialFinding = findings.contains { ["blocking", "high"].contains($0.severity.lowercased()) }
        let passed = envelope.verdict.lowercased() == "pass"
            && score >= 9
            && envelope.requiredChanges.isEmpty
            && !hasMaterialFinding
        return .init(
            score: score,
            passed: passed,
            summary: envelope.summary,
            findings: findings,
            requiredChanges: envelope.requiredChanges
        )
    }

    func parseImplementation(_ content: String) throws -> ImplementationDraft {
        let envelope: ImplementationEnvelope = try decode(content)
        guard !envelope.deliverable.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LoopEngineError.malformedModelOutput("Implementation was empty.")
        }
        return .init(deliverable: envelope.deliverable, notes: envelope.notes)
    }

    func reviewRecord(from review: ReviewDraft, target: String, round: Int) -> ReviewRecord {
        .init(
            target: target,
            round: round,
            score: review.score,
            passed: review.passed,
            summary: review.summary,
            findings: review.findings,
            requiredChanges: review.requiredChanges
        )
    }

    func decode<T: Decodable>(_ content: String) throws -> T {
        let cleaned = cleanJSON(content)
        guard let data = cleaned.data(using: .utf8) else {
            throw LoopEngineError.malformedModelOutput("Response was not UTF-8.")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw LoopEngineError.malformedModelOutput(error.localizedDescription)
        }
    }

    func cleanJSON(_ content: String) -> String {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("```") else { return trimmed }
        var lines = trimmed.components(separatedBy: .newlines)
        if lines.first?.hasPrefix("```") == true { lines.removeFirst() }
        if lines.last?.hasPrefix("```") == true { lines.removeLast() }
        return lines.joined(separator: "\n")
    }
}
