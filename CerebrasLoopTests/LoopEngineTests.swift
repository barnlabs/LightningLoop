import XCTest
@testable import CerebrasLoop

final class LoopEngineTests: XCTestCase {
    func testGoldLoopRequiresAndAppliesImplementationRevision() async throws {
        let agent = MockAgent(responses: [
            json("""
            {"summary":"Build a launch brief","questions":[{"id":"Q1","question":"Who is it for?","why_it_matters":"Defines the audience."},{"id":"Q2","question":"What format?","why_it_matters":"Defines the artifact."}]}
            """),
            json(planningJSON),
            json(reviewJSON(verdict: "revise", score: 7, changes: ["Make the proof measurable."])),
            json(planningJSON.replacingOccurrences(of: "Readable brief", with: "Brief passes a named checklist")),
            json(reviewJSON(verdict: "pass", score: 9, changes: [])),
            json("{\"deliverable\":\"# Draft\\nInitial result\",\"notes\":[]}"),
            json(reviewJSON(verdict: "revise", score: 6, changes: ["Add the required audience section."])),
            json("{\"deliverable\":\"# Gold brief\\n## Audience\\nDevelopers\\n## Launch\\nComplete.\",\"notes\":[\"Text-only demo\"]}"),
            json(reviewJSON(verdict: "pass", score: 10, changes: []))
        ])
        let engine = LoopEngine(agent: agent)
        let clarification = try await engine.clarify(goal: "Create a launch brief")
        XCTAssertEqual(clarification.questions.count, 2)

        let recorder = EventRecorder()
        let result = try await engine.execute(
            goal: "Create a launch brief",
            summary: clarification.summary,
            answers: ["Q1": "Developers", "Q2": "Markdown"],
            maxReviewCycles: 3
        ) { event in
            await recorder.record(event)
        }

        XCTAssertTrue(result.completed)
        XCTAssertTrue(result.implementation.deliverable.contains("Gold brief"))
        let reviewCount = await recorder.reviewCount()
        let remainingCount = await agent.remainingCount()
        XCTAssertEqual(reviewCount, 4)
        XCTAssertEqual(remainingCount, 0)
    }

    func testReviewerCannotClaimPassWithScoreBelowGoldThreshold() async throws {
        let agent = MockAgent(responses: [
            json(planningJSON),
            json(reviewJSON(verdict: "pass", score: 8, changes: []))
        ])
        let engine = LoopEngine(agent: agent)
        let result = try await engine.execute(
            goal: "Create a brief",
            summary: "A brief",
            answers: ["Q1": "Developers"],
            maxReviewCycles: 1
        ) { _ in }

        XCTAssertFalse(result.completed)
        XCTAssertTrue(result.finalMessage.contains("Paused"))
        XCTAssertTrue(result.implementation.deliverable.isEmpty)
    }

    func testClarificationAcceptsFencedJSONButNoArbitraryText() async throws {
        let fenced = """
        ```json
        {"summary":"Clear target","questions":[{"id":"Q1","question":"What proof?","why_it_matters":"Makes success observable."}]}
        ```
        """
        let engine = LoopEngine(agent: MockAgent(responses: [json(fenced)]))
        let result = try await engine.clarify(goal: "Do the thing")
        XCTAssertEqual(result.questions.first?.id, "Q1")
    }

    private func json(_ content: String) -> AgentReply {
        .init(
            content: content,
            metrics: .init(promptTokens: 100, completionTokens: 50, totalSeconds: 0.2, completionSeconds: 0.05),
            model: "gemma-4-31b"
        )
    }

    private var planningJSON: String {
        """
        {"criteria":[{"id":"C1","title":"Audience fit","detail":"Address developers","evidence":"Readable brief"}],"plan":[{"id":"P1","title":"Draft","detail":"Write the brief","proof":"Review every section"}],"risks":["Vague claims"],"acceptance_test":"All criteria have direct evidence."}
        """
    }

    private func reviewJSON(verdict: String, score: Int, changes: [String]) -> String {
        let findings: String
        if changes.isEmpty {
            findings = "[]"
        } else {
            findings = "[{\"severity\":\"high\",\"criterion_id\":\"C1\",\"issue\":\"Evidence is incomplete.\",\"required_change\":\"\(changes[0])\"}]"
        }
        let encodedChanges = changes.map { "\"\($0)\"" }.joined(separator: ",")
        return "{\"verdict\":\"\(verdict)\",\"score\":\(score),\"summary\":\"Reviewed against every criterion.\",\"findings\":\(findings),\"required_changes\":[\(encodedChanges)]}"
    }
}

private actor MockAgent: AgentServing {
    private var responses: [AgentReply]

    init(responses: [AgentReply]) {
        self.responses = responses
    }

    func complete(_ request: AgentRequest) async throws -> AgentReply {
        guard !responses.isEmpty else { throw MockError.noResponse }
        return responses.removeFirst()
    }

    func remainingCount() -> Int { responses.count }

    enum MockError: Error { case noResponse }
}

private actor EventRecorder {
    private var reviews = 0

    func record(_ event: LoopEngineEvent) {
        if case .review = event { reviews += 1 }
    }

    func reviewCount() -> Int { reviews }
}
