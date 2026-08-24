import XCTest
@testable import LightningLoop

final class LoopEngineTests: XCTestCase {
    func testNativeClarificationFailsClosedBeforeAnyAgentOrResearchCall() async throws {
        let agent = NativeAgentCallRecorder()
        let research = NativeResearchCallRecorder()
        let engine = LoopEngine(agent: agent, research: research)

        do {
            _ = try await engine.clarify(goal: "Create a current provider brief")
            XCTFail("Native clarification must require the shared harness.")
        } catch let error as LoopEngineError {
            XCTAssertEqual(error, .sharedHarnessRequired)
        }

        let agentCalls = await agent.callCount()
        let researchCalls = await research.callCount()
        XCTAssertEqual(agentCalls, 0)
        XCTAssertEqual(researchCalls, 0)
    }

    func testNativeExecutionReturnsPausedWithoutCallingAgentResearchOrEvents() async throws {
        let agent = NativeAgentCallRecorder()
        let research = NativeResearchCallRecorder()
        let events = NativeEventCallRecorder()
        let engine = LoopEngine(agent: agent, research: research)

        let result = try await engine.execute(
            goal: "Create a current provider brief",
            summary: "Use current sources",
            answers: ["Q1": "Developers"],
            maxReviewCycles: 8,
            researchProvider: "brave",
            artifactWorkspace: "/tmp/must-not-be-used",
            approveArtifactWrites: true,
            approveVerificationCommands: true
        ) { event in
            await events.record(event)
        }

        XCTAssertFalse(result.completed)
        XCTAssertTrue(result.planning.criteria.isEmpty)
        XCTAssertTrue(result.implementation.deliverable.isEmpty)
        XCTAssertTrue(result.finalMessage.contains("shared LightningLoop harness"))
        let agentCalls = await agent.callCount()
        let researchCalls = await research.callCount()
        let eventCalls = await events.callCount()
        XCTAssertEqual(agentCalls, 0)
        XCTAssertEqual(researchCalls, 0)
        XCTAssertEqual(eventCalls, 0)
    }
}

private actor NativeAgentCallRecorder: AgentServing {
    private var calls = 0

    func complete(_ request: AgentRequest) async throws -> AgentReply {
        calls += 1
        throw RecorderError.unexpectedCall
    }

    func callCount() -> Int { calls }
}

private actor NativeResearchCallRecorder: ResearchServing {
    private var calls = 0

    func search(provider: String, query: String, limit: Int) async throws -> [ResearchSource] {
        calls += 1
        throw RecorderError.unexpectedCall
    }

    func callCount() -> Int { calls }
}

private actor NativeEventCallRecorder {
    private var calls = 0

    func record(_ event: LoopEngineEvent) { calls += 1 }
    func callCount() -> Int { calls }
}

private enum RecorderError: Error {
    case unexpectedCall
}

final class LoopAgentSourceTrustTests: XCTestCase {
    func testThreeAgentsMapFromLegacyRoles() {
        XCTAssertEqual(AgentRole.orchestrator.loopAgent, .researcher)
        XCTAssertEqual(AgentRole.implementer.loopAgent, .engineer)
        XCTAssertEqual(AgentRole.reviewer.loopAgent, .verifier)
        XCTAssertEqual(LoopAgent.allCases.map(\.rawValue), ["researcher", "engineer", "verifier"])
    }

    func testSourceTrustAllowsPrimaryHostsAndLoopbackAndRejectsBlogs() {
        XCTAssertTrue(SourceTrust.isReputable(URL(string: "https://www.rfc-editor.org/rfc/rfc9110")!))
        XCTAssertTrue(SourceTrust.isReputable(URL(string: "https://cdc.gov/x")!))
        XCTAssertTrue(SourceTrust.isReputable(URL(string: "http://127.0.0.1:9/token/index.html")!))
        XCTAssertFalse(SourceTrust.isReputable(URL(string: "https://example.com/")!))
        XCTAssertFalse(SourceTrust.isReputable(URL(string: "https://medium.com/p/1")!))
        XCTAssertFalse(SourceTrust.isReputable(URL(string: "http://cdc.gov/x")!))
    }
}
