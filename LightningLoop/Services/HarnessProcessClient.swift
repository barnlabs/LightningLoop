import Foundation
import Darwin

enum HarnessProcessError: LocalizedError {
    case unavailable
    case busy
    case launchFailed(String)
    case invalidResponse(String)
    case remote(String)
    case outputTooLarge
    case deadlineExceeded

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "The shared LightningLoop runtime is unavailable. Build it with npm run build:harness."
        case .busy:
            "The shared LightningLoop runtime is already processing another request."
        case .launchFailed(let detail):
            "The shared LightningLoop runtime could not run: \(detail)"
        case .invalidResponse(let detail):
            "The shared LightningLoop runtime returned an invalid response: \(detail)"
        case .remote(let detail):
            detail
        case .outputTooLarge:
            "The shared LightningLoop runtime exceeded its bounded response limit."
        case .deadlineExceeded:
            "The shared LightningLoop runtime exceeded its execution deadline."
        }
    }
}

/// Credential-free catalog information returned by the shared LightningLoop
/// runtime. It never contains provider secrets or account identifiers.
struct HarnessRuntimeModelCatalog: Decodable, Equatable, Sendable {
    let providerID: String
    let models: [ProviderModelOption]
    let selectedModelID: String
    let selectedModelCatalogued: Bool
    let catalogScope: String
    let selectionNotice: String?
}

struct HarnessSubprocessResult: Sendable {
    let stdout: Data
    let stderr: Data
    let processIdentifier: Int32
    let terminationStatus: Int32
}

private final class BoundedProcessOutput: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var standardOutput = Data()
    private var standardError = Data()
    private var aggregateCount = 0
    private(set) var overflowed = false
    private(set) var readError: Error?

    init(limit: Int) { self.limit = limit }

    func append(_ data: Data, isError: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard !overflowed else { return }
        guard data.count <= limit - aggregateCount else {
            overflowed = true
            return
        }
        aggregateCount += data.count
        if isError { standardError.append(data) } else { standardOutput.append(data) }
    }

    func record(_ error: Error) {
        lock.lock()
        if readError == nil { readError = error }
        lock.unlock()
    }

    func snapshot() -> (stdout: Data, stderr: Data, overflowed: Bool, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        return (standardOutput, standardError, overflowed, readError)
    }
}

final class HarnessSubprocessRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancellationRequested = false
    private var lastProcessIdentifier: Int32 = 0

    func execute(nodeURL: URL, scriptURL: URL, rootURL: URL, input: Data) throws -> Data {
        let result = try executeCommand(
            executableURL: nodeURL,
            arguments: [scriptURL.path, "serve"],
            rootURL: rootURL,
            environment: Self.restrictedEnvironment(nodeURL: nodeURL),
            input: input,
            outputLimit: 8 * 1_048_576,
            deadline: 300
        )
        guard result.terminationStatus == 0 else {
            throw HarnessProcessError.launchFailed("process exited with status \(result.terminationStatus); provider output was withheld")
        }
        return result.stdout
    }

    func executeCommand(
        executableURL: URL,
        arguments: [String],
        rootURL: URL,
        environment: [String: String],
        input: Data = Data(),
        outputLimit: Int,
        deadline: TimeInterval
    ) throws -> HarnessSubprocessResult {
        guard outputLimit > 0, deadline > 0 else {
            throw HarnessProcessError.launchFailed("invalid subprocess bounds")
        }
        let task = Process()
        task.executableURL = executableURL
        task.arguments = arguments
        task.currentDirectoryURL = rootURL
        task.environment = environment
        let standardInput = Pipe()
        let standardOutput = Pipe()
        let standardError = Pipe()
        task.standardInput = standardInput
        task.standardOutput = standardOutput
        task.standardError = standardError

        lock.lock()
        guard process == nil else {
            lock.unlock()
            throw HarnessProcessError.busy
        }
        process = task
        cancellationRequested = false
        lock.unlock()
        defer {
            lock.lock()
            process = nil
            lock.unlock()
        }

        do { try task.run() }
        catch { throw HarnessProcessError.launchFailed(error.localizedDescription) }
        let pid = task.processIdentifier
        lock.lock()
        lastProcessIdentifier = pid
        lock.unlock()
        let output = BoundedProcessOutput(limit: outputLimit)
        let drains = DispatchGroup()
        func startDrain(_ handle: FileHandle, isError: Bool) {
            drains.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                defer { drains.leave() }
                do {
                    while let chunk = try handle.read(upToCount: 16_384), !chunk.isEmpty {
                        output.append(chunk, isError: isError)
                    }
                } catch { output.record(error) }
            }
        }
        startDrain(standardOutput.fileHandleForReading, isError: false)
        startDrain(standardError.fileHandleForReading, isError: true)

        let writer = DispatchGroup()
        writer.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            defer {
                try? standardInput.fileHandleForWriting.close()
                writer.leave()
            }
            do {
                if !input.isEmpty { try standardInput.fileHandleForWriting.write(contentsOf: input) }
            } catch { output.record(error) }
        }

        lock.lock()
        let cancelImmediately = cancellationRequested
        lock.unlock()
        let expiresAt = Date().addingTimeInterval(deadline)
        var terminationRequestedAt: Date?
        var timedOut = false
        var overflowed = false
        if cancelImmediately, task.isRunning {
            task.terminate()
            terminationRequestedAt = Date()
        }

        while task.isRunning {
            let snapshot = output.snapshot()
            lock.lock()
            let cancelled = cancellationRequested
            lock.unlock()
            if snapshot.overflowed, terminationRequestedAt == nil {
                overflowed = true
                task.terminate()
                terminationRequestedAt = Date()
                try? standardInput.fileHandleForWriting.close()
            } else if cancelled, terminationRequestedAt == nil {
                task.terminate()
                terminationRequestedAt = Date()
                try? standardInput.fileHandleForWriting.close()
            } else if Date() >= expiresAt, terminationRequestedAt == nil {
                timedOut = true
                task.terminate()
                terminationRequestedAt = Date()
                try? standardInput.fileHandleForWriting.close()
            } else if let terminationRequestedAt,
                      Date().timeIntervalSince(terminationRequestedAt) >= 0.5,
                      task.isRunning {
                _ = Darwin.kill(pid, SIGKILL)
            }
            Thread.sleep(forTimeInterval: 0.01)
        }
        task.waitUntilExit()
        writer.wait()
        drains.wait()

        lock.lock()
        let wasCancelled = cancellationRequested
        lock.unlock()
        let snapshot = output.snapshot()
        if wasCancelled { throw CancellationError() }
        if overflowed || snapshot.overflowed { throw HarnessProcessError.outputTooLarge }
        if timedOut { throw HarnessProcessError.deadlineExceeded }
        if let error = snapshot.error, task.terminationStatus == 0 {
            throw HarnessProcessError.launchFailed(error.localizedDescription)
        }
        return HarnessSubprocessResult(
            stdout: snapshot.stdout,
            stderr: snapshot.stderr,
            processIdentifier: pid,
            terminationStatus: task.terminationStatus
        )
    }

    func activeProcessIdentifier() -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        guard let process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    func mostRecentProcessIdentifier() -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        return lastProcessIdentifier
    }

    func cancel() {
        lock.lock()
        cancellationRequested = true
        let active = process
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    fileprivate static func restrictedEnvironment(nodeURL: URL) -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var result: [String: String] = [
            "PATH": "\(nodeURL.deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_ENV": "production",
            "NO_COLOR": "1"
        ]
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_CTYPE"] {
            if let value = inherited[key] { result[key] = value }
        }
        return result
    }
}

final class ArtifactBrowserSession: @unchecked Sendable {
    let url: URL
    let expiresAt: Date
    private let process: Process
    private let standardInput: Pipe

    init(url: URL, expiresAt: Date, process: Process, standardInput: Pipe) {
        self.url = url
        self.expiresAt = expiresAt
        self.process = process
        self.standardInput = standardInput
    }

    func close() {
        try? standardInput.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
    }

    deinit { close() }
}

private final class ArtifactStartupLineReader: @unchecked Sendable {
    private let handle: FileHandle
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Result<Data, Error>?

    init(handle: FileHandle) { self.handle = handle }

    func start() {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            do {
                var data = Data()
                while data.count <= 16_384 {
                    guard let byte = try handle.read(upToCount: 1), !byte.isEmpty else { break }
                    if byte[0] == 0x0a { break }
                    data.append(byte)
                }
                guard !data.isEmpty, data.count <= 16_384 else { throw HarnessProcessError.outputTooLarge }
                store(.success(data))
            } catch { store(.failure(error)) }
        }
    }

    func wait(seconds: Double) throws -> Data {
        guard semaphore.wait(timeout: .now() + seconds) == .success else {
            throw HarnessProcessError.launchFailed("artifact helper did not return a bounded startup line within 10 seconds")
        }
        lock.lock()
        defer { lock.unlock() }
        return try result!.get()
    }

    private func store(_ value: Result<Data, Error>) {
        lock.lock()
        result = value
        lock.unlock()
        semaphore.signal()
    }
}

struct HarnessProcessClient: LoopServicing, Sendable {
    private static let protocolVersion = 1
    private let rootURL: URL
    private let scriptURL: URL
    private let nodeURL: URL
    private let runner: HarnessSubprocessRunner

    private init(rootURL: URL, nodeURL: URL) {
        self.rootURL = rootURL
        self.scriptURL = rootURL.appendingPathComponent("dist/cli/index.js")
        self.nodeURL = nodeURL
        self.runner = HarnessSubprocessRunner()
    }

    static func validateJSONLForTesting(
        _ output: Data,
        runID: String,
        requestID: String,
        requestType: String
    ) throws -> [String] {
        let client = HarnessProcessClient(rootURL: URL(fileURLWithPath: "/"), nodeURL: URL(fileURLWithPath: "/usr/bin/false"))
        return try client.parse(output: output, runID: runID, requestID: requestID, requestType: requestType).map(\.type)
    }

    static func discover() -> HarnessProcessClient? {
        let environment = ProcessInfo.processInfo.environment
        var roots: [URL] = []
        if let configured = environment["LIGHTNINGLOOP_HARNESS_ROOT"], configured.hasPrefix("/") {
            roots.append(URL(fileURLWithPath: configured, isDirectory: true))
        }
        roots.append(installedHarnessRoot(homeDirectory: FileManager.default.homeDirectoryForCurrentUser))
        roots.append(contentsOf: ancestors(of: Bundle.main.bundleURL))
        roots.append(contentsOf: ancestors(of: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)))

        return discover(environment: environment, rootCandidates: roots)
    }

    static func discover(environment: [String: String], rootCandidates: [URL]) -> HarnessProcessClient? {
        let resolvedRoots = rootCandidates.map { $0.resolvingSymlinksInPath() }
        guard let root = resolvedRoots.first(where: isTrustedHarnessRoot),
              let node = discoverNode(environment: environment) else {
            return nil
        }
        return HarnessProcessClient(rootURL: root, nodeURL: node)
    }

    static func installedHarnessRoot(homeDirectory: URL) -> URL {
        homeDirectory
            .appendingPathComponent(".local", isDirectory: true)
            .appendingPathComponent("lib", isDirectory: true)
            .appendingPathComponent("node_modules", isDirectory: true)
            .appendingPathComponent("@barnlabs", isDirectory: true)
            .appendingPathComponent("lightningloop-harness", isDirectory: true)
    }

    /// Finder has no reliable shell PATH. Keep normal app launches constrained
    /// to explicit, installer-supported locations; the environment override is
    /// intentionally opt-in for development and test launches only.
    static func nodeCandidates(environment: [String: String], homeDirectory: URL) -> [URL] {
        var candidates: [URL] = []
        if let configured = environment["LIGHTNINGLOOP_NODE_PATH"], configured.hasPrefix("/") {
            candidates.append(URL(fileURLWithPath: configured))
        }
        candidates.append(homeDirectory.appendingPathComponent(".local/node/bin/node"))
        candidates.append(URL(fileURLWithPath: "/opt/homebrew/bin/node"))
        candidates.append(URL(fileURLWithPath: "/usr/local/bin/node"))
        return candidates
    }

    func probe() async throws -> String {
        let runID = UUID().uuidString
        let envelopes = try await request(type: "hello", runID: runID, payload: [:])
        let payload = try responsePayload(in: envelopes, requestType: "hello")
        return try requiredString(payload["product"], label: "product")
    }

    func runtimeModelCatalog() async throws -> HarnessRuntimeModelCatalog {
        let runID = UUID().uuidString
        let envelopes = try await request(type: "providerModels", runID: runID, payload: [:])
        let payload = try responsePayload(in: envelopes, requestType: "providerModels")
        return try decode(HarnessRuntimeModelCatalog.self, from: payload, label: "runtime model catalog")
    }

    func runManagedHarnessCommand(_ arguments: [String]) async throws -> String {
        let allowed = ["status", "backup", "restore", "reset"]
        guard let action = arguments.first, allowed.contains(action), arguments.allSatisfy({ !$0.contains("\0") && $0.count <= 80 }) else {
            throw HarnessProcessError.launchFailed("management arguments were rejected")
        }
        let runner = self.runner
        return try await Task.detached {
            let result = try runner.executeCommand(
                executableURL: nodeURL,
                arguments: [scriptURL.path, "harness"] + arguments,
                rootURL: rootURL,
                environment: HarnessSubprocessRunner.restrictedEnvironment(nodeURL: nodeURL),
                outputLimit: 262_144,
                deadline: 60
            )
            guard result.terminationStatus == 0 else {
                throw HarnessProcessError.launchFailed(String(data: result.stderr, encoding: .utf8) ?? "management command failed")
            }
            guard let text = String(data: result.stdout, encoding: .utf8) else {
                throw HarnessProcessError.invalidResponse("management output was not strict UTF-8")
            }
            return text
        }.value
    }

    func startArtifactBrowser(workspace: URL, sourcePath: String, sha256: String, files: [ArtifactFileEvidence]) async throws -> ArtifactBrowserSession {
        guard !sourcePath.isEmpty, !sourcePath.hasPrefix("/"), !sourcePath.split(separator: "/").contains(".."),
              sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw HarnessProcessError.launchFailed("artifact handoff arguments were rejected")
        }
        let manifestData = try JSONSerialization.data(withJSONObject: files.map { ["path": $0.path, "sha256": $0.sha256] })
        guard let manifestJSON = String(data: manifestData, encoding: .utf8), manifestJSON.count <= 65_536 else {
            throw HarnessProcessError.launchFailed("artifact evidence manifest exceeded its boundary")
        }
        return try await Task.detached {
            let task = Process()
            task.executableURL = nodeURL
            task.arguments = [scriptURL.path, "artifact", "serve", "--workspace", workspace.path, "--source", sourcePath, "--sha256", sha256, "--manifest-json", manifestJSON]
            task.currentDirectoryURL = rootURL
            task.environment = HarnessSubprocessRunner.restrictedEnvironment(nodeURL: nodeURL)
            let input = Pipe()
            let output = Pipe()
            let errors = Pipe()
            task.standardInput = input
            task.standardOutput = output
            task.standardError = errors
            do { try task.run() }
            catch { throw HarnessProcessError.launchFailed(error.localizedDescription) }
            let reader = ArtifactStartupLineReader(handle: output.fileHandleForReading)
            reader.start()
            let line: Data
            do { line = try reader.wait(seconds: 10) }
            catch {
                try? input.fileHandleForWriting.close()
                if task.isRunning { task.terminate(); task.waitUntilExit() }
                throw error
            }
            guard
                  let object = try JSONSerialization.jsonObject(with: line) as? [String: String],
                  let rawURL = object["url"], let url = URL(string: rawURL),
                  url.scheme == "http", url.host == "127.0.0.1",
                  let rawExpiry = object["expiresAt"],
                  let expiresAt = ISO8601DateFormatter().date(from: rawExpiry) else {
                try? input.fileHandleForWriting.close()
                if task.isRunning { task.terminate(); task.waitUntilExit() }
                let detail = "invalid or incomplete helper startup response"
                throw HarnessProcessError.invalidResponse(detail)
            }
            return ArtifactBrowserSession(url: url, expiresAt: expiresAt, process: task, standardInput: input)
        }.value
    }

    func clarify(
        goal: String,
        attachments: [ImageAttachment],
        expectedModelSelection: ExpectedModelSelection,
        runID: UUID?
    ) async throws -> ClarificationResult {
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LoopEngineError.emptyGoal }
        let protocolRunID = runID?.uuidString ?? UUID().uuidString
        let envelopes = try await request(type: "createRun", runID: protocolRunID, payload: [
            "goal": trimmed,
            "expectedProviderID": expectedModelSelection.providerID,
            "expectedModelID": expectedModelSelection.modelID,
            "expectedSupportsImages": expectedModelSelection.supportsImages,
            "expectedContextWindow": expectedModelSelection.contextWindow,
            "expectedMaxOutputTokens": expectedModelSelection.maxOutputTokens,
            "imagePaths": attachments.map(\.fileURL.path)
        ])
        let payload = try responsePayload(in: envelopes, requestType: "createRun")
        let clarification = try decode(HarnessClarification.self, from: payload["clarification"], label: "clarification")
        let questions = clarification.questions.map {
            ClarifyingQuestion(id: $0.id, question: $0.question, whyItMatters: $0.whyItMatters)
        }
        return ClarificationResult(
            summary: clarification.summary,
            questions: questions,
            timeline: TimelineEntry(
                role: .orchestrator,
                title: "Clarified through the shared LightningLoop runtime",
                summary: "Raised \(questions.count) decision-critical question\(questions.count == 1 ? "" : "s").",
                metrics: .init()
            )
        )
    }

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
        expectedModelSelection: ExpectedModelSelection,
        runID: UUID?,
        emit: @escaping @Sendable (LoopEngineEvent) async -> Void
    ) async throws -> LoopExecutionResult {
        let protocolRunID = runID?.uuidString ?? UUID().uuidString
        let clarificationQuestions: [[String: String]] = questions.map {
            ["id": $0.id, "question": $0.question, "whyItMatters": $0.whyItMatters]
        }
        var payload: [String: Any] = [
            "goal": goal,
            "clarification": ["summary": summary, "questions": clarificationQuestions],
            "answers": answers,
            "expectedProviderID": expectedModelSelection.providerID,
            "expectedModelID": expectedModelSelection.modelID,
            "expectedSupportsImages": expectedModelSelection.supportsImages,
            "expectedContextWindow": expectedModelSelection.contextWindow,
            "expectedMaxOutputTokens": expectedModelSelection.maxOutputTokens,
            "maxReviewCycles": maxReviewCycles,
            "imagePaths": attachments.map(\.fileURL.path),
            "approveArtifactWrites": approveArtifactWrites,
            "approveVerificationCommands": approveVerificationCommands
        ]
        if let researchProvider { payload["researchProvider"] = researchProvider }
        if let artifactWorkspace { payload["artifactWorkspace"] = artifactWorkspace }
        let envelopes = try await request(type: "continueRun", runID: protocolRunID, payload: payload)
        for envelope in envelopes where envelope.type == "stageChanged" {
            guard let stageName = envelope.payload["stage"] as? String,
                  let message = envelope.payload["message"] as? String,
                  let stage = Self.loopStage(stageName) else { continue }
            await emit(.phase(stage, message))
        }

        let resultObject: Any
        if let completed = envelopes.first(where: { $0.type == "runCompleted" || $0.type == "runPaused" }) {
            resultObject = completed.payload
        } else {
            resultObject = try responsePayload(in: envelopes, requestType: "continueRun")["result"] as Any
        }
        let result = try decode(HarnessRunResult.self, from: resultObject, label: "result")
        let planning = result.planning.native
        let implementation = result.implementation
        await emit(.planning(planning))
        for review in result.reviews {
            await emit(.review(review.native))
        }
        await emit(.implementation(implementation))
        await emit(.timeline(TimelineEntry(
            role: .reviewer,
            title: result.completed ? "Shared harness verified Gold" : "Shared harness paused safely",
            summary: result.message,
            metrics: result.usage.native
        )))
        return LoopExecutionResult(
            planning: planning,
            implementation: implementation,
            completed: result.completed,
            finalMessage: result.message,
            artifactReport: result.artifactReport
        )
    }
}

extension HarnessProcessClient {
    struct Envelope {
        let type: String
        let runID: String
        let requestID: String
        let payload: [String: Any]
    }

    struct HarnessClarification: Decodable {
        struct Question: Decodable {
            let id: String
            let question: String
            let whyItMatters: String
        }
        let summary: String
        let questions: [Question]
    }

    struct HarnessPlanning: Decodable {
        let criteria: [Criterion]
        let plan: [PlanStep]
        let risks: [String]
        let acceptanceTest: String

        var native: PlanningDraft {
            .init(criteria: criteria, plan: plan, risks: risks, acceptanceTest: acceptanceTest)
        }
    }

    struct HarnessUsage: Decodable {
        let input: Int
        let output: Int

        var native: InferenceMetrics {
            .init(promptTokens: input, completionTokens: output)
        }
    }

    struct HarnessFinding: Decodable {
        let severity: String
        let criterionID: String?
        let issue: String
        let requiredChange: String
    }

    struct HarnessReview: Decodable {
        let target: String
        let round: Int
        let score: Int
        let verdict: String
        let summary: String
        let findings: [HarnessFinding]
        let requiredChanges: [String]

        var native: ReviewRecord {
            let mapped = findings.map {
                ReviewFinding(
                    severity: $0.severity,
                    criterionID: $0.criterionID,
                    issue: $0.issue,
                    requiredChange: $0.requiredChange
                )
            }
            let passed = verdict == "pass"
                && score >= 9
                && requiredChanges.isEmpty
                && !mapped.contains { ["high", "blocking"].contains($0.severity.lowercased()) }
            return .init(
                target: target.capitalized,
                round: round,
                score: score,
                passed: passed,
                summary: summary,
                findings: mapped,
                requiredChanges: requiredChanges
            )
        }
    }

    struct HarnessRunResult: Decodable {
        let completed: Bool
        let message: String
        let planning: HarnessPlanning
        let implementation: ImplementationDraft
        let reviews: [HarnessReview]
        let artifactReport: ArtifactExecutionReport?
        let usage: HarnessUsage
    }

    func request(type: String, runID: String, payload: [String: Any]) async throws -> [Envelope] {
        try Task.checkCancellation()
        let requestID = UUID().uuidString
        let body: [String: Any] = [
            "protocolVersion": Self.protocolVersion,
            "type": type,
            "runID": runID,
            "requestID": requestID,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "payload": payload
        ]
        guard JSONSerialization.isValidJSONObject(body) else {
            throw HarnessProcessError.invalidResponse("request could not be encoded")
        }
        var encodedInput = try JSONSerialization.data(withJSONObject: body)
        encodedInput.append(0x0A)
        let input = encodedInput
        let runner = self.runner
        let output = try await withTaskCancellationHandler {
            try await Task.detached(priority: .userInitiated) {
                try runner.execute(nodeURL: nodeURL, scriptURL: scriptURL, rootURL: rootURL, input: input)
            }.value
        } onCancel: {
            runner.cancel()
        }
        try Task.checkCancellation()
        let envelopes = try parse(output: output, runID: runID, requestID: requestID, requestType: type)
        if let error = envelopes.first(where: { $0.type == "error" }) {
            throw HarnessProcessError.remote(try requiredString(error.payload["message"], label: "error.message"))
        }
        return envelopes
    }

    func parse(output: Data, runID: String, requestID: String, requestType: String) throws -> [Envelope] {
        guard output.count <= 8 * 1_048_576,
              output.last == 0x0A,
              let text = String(data: output, encoding: .utf8) else {
            throw HarnessProcessError.invalidResponse("JSONL must be bounded, newline-terminated strict UTF-8")
        }
        let rawLines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard rawLines.last?.isEmpty == true else { throw HarnessProcessError.invalidResponse("unterminated JSONL stream") }
        let lines = rawLines.dropLast()
        guard !lines.isEmpty, lines.count <= 10_000, lines.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1_048_576 }) else {
            throw HarnessProcessError.invalidResponse("empty, overlong, or overpopulated JSONL stream")
        }
        let expectedFields: Set<String> = ["protocolVersion", "type", "runID", "requestID", "timestamp", "payload"]
        let envelopes = try lines.map { line -> Envelope in
            guard let root = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  Set(root.keys) == expectedFields,
                  root["protocolVersion"] as? Int == Self.protocolVersion,
                  root["runID"] as? String == runID,
                  root["requestID"] as? String == requestID,
                  let timestamp = root["timestamp"] as? String,
                  timestamp.count <= 64,
                  Self.isValidTimestamp(timestamp),
                  let type = root["type"] as? String,
                  !type.isEmpty, type.count <= 64,
                  let payload = root["payload"] as? [String: Any] else {
                throw HarnessProcessError.invalidResponse("uncorrelated, non-exact, or malformed envelope")
            }
            return Envelope(type: type, runID: runID, requestID: requestID, payload: payload)
        }
        try validateSequence(envelopes, requestType: requestType)
        return envelopes
    }

    func validateSequence(_ envelopes: [Envelope], requestType: String) throws {
        let allowedTypes: Set<String> = ["response", "error", "stageChanged", "runCompleted", "runPaused"]
        guard envelopes.allSatisfy({ allowedTypes.contains($0.type) }) else {
            throw HarnessProcessError.invalidResponse("unknown JSONL envelope type")
        }
        if let error = envelopes.first(where: { $0.type == "error" }) {
            guard envelopes.count == 1,
                  Set(error.payload.keys) == ["code", "message", "retryable"],
                  let code = error.payload["code"] as? String, !code.isEmpty, code.count <= 128,
                  let message = error.payload["message"] as? String, !message.isEmpty, message.count <= 1_000,
                  error.payload["retryable"] is Bool else {
                throw HarnessProcessError.invalidResponse("malformed or non-terminal error envelope")
            }
            return
        }
        guard let responseIndex = envelopes.indices.last,
              envelopes[responseIndex].type == "response",
              envelopes.filter({ $0.type == "response" }).count == 1,
              envelopes[responseIndex].payload["requestType"] as? String == requestType else {
            throw HarnessProcessError.invalidResponse("response must be the unique final envelope")
        }
        let response = envelopes[responseIndex]
        let exactResponseFields: Set<String>
        switch requestType {
        case "hello": exactResponseFields = ["requestType", "product", "protocolVersion", "provider", "model", "capabilities", "identity"]
        case "providerModels":
            exactResponseFields = response.payload["selectionNotice"] == nil
                ? ["requestType", "providerID", "models", "selectedModelID", "selectedModelCatalogued", "catalogScope"]
                : ["requestType", "providerID", "models", "selectedModelID", "selectedModelCatalogued", "catalogScope", "selectionNotice"]
        case "credentialStatus": exactResponseFields = ["requestType", "activeProvider", "providers", "valuesExposed"]
        case "cancelRun": exactResponseFields = ["requestType", "cancelled"]
        case "createRun": exactResponseFields = ["requestType", "stage", "clarification"]
        case "continueRun": exactResponseFields = ["requestType", "result"]
        default: throw HarnessProcessError.invalidResponse("unknown request sequence")
        }
        guard Set(response.payload.keys) == exactResponseFields else {
            throw HarnessProcessError.invalidResponse("response payload fields were not exact")
        }

        let preceding = Array(envelopes[..<responseIndex])
        guard requestType == "continueRun" else {
            guard preceding.isEmpty else { throw HarnessProcessError.invalidResponse("unexpected pre-response envelopes") }
            return
        }
        let terminals = preceding.filter { $0.type == "runCompleted" || $0.type == "runPaused" }
        guard terminals.count == 1, preceding.last?.type == terminals[0].type,
              let result = response.payload["result"] as? [String: Any],
              Self.canonicalJSON(result) == Self.canonicalJSON(terminals[0].payload) else {
            throw HarnessProcessError.invalidResponse("continueRun requires one matching terminal result before its response")
        }
        let stages = preceding.dropLast()
        guard !stages.isEmpty, stages.allSatisfy({ $0.type == "stageChanged" }) else {
            throw HarnessProcessError.invalidResponse("continueRun requires only ordered stage events before its terminal result")
        }
        var seen = Set<String>()
        var terminalStage: String?
        for envelope in stages {
            let keys = Set(envelope.payload.keys)
            guard keys == ["stage", "role", "message"] || keys == ["stage", "role", "round", "message"],
                  let stage = envelope.payload["stage"] as? String,
                  let role = envelope.payload["role"] as? String,
                  ["orchestrator", "reviewer", "implementer"].contains(role),
                  let message = envelope.payload["message"] as? String,
                  !message.isEmpty, message.count <= 10_000,
                  envelope.payload["round"].map({ ($0 as? Int).map { (1...8).contains($0) } == true }) ?? true else {
                throw HarnessProcessError.invalidResponse("stage event fields or bounds were invalid")
            }
            if terminalStage != nil { throw HarnessProcessError.invalidResponse("stage event followed the terminal stage") }
            if seen.isEmpty && stage != "planning" { throw HarnessProcessError.invalidResponse("the first stage must be planning") }
            if stage == "reviewing_plan" && !seen.contains("planning") { throw HarnessProcessError.invalidResponse("plan review preceded planning") }
            if stage == "implementing" && !seen.contains("reviewing_plan") { throw HarnessProcessError.invalidResponse("implementation preceded plan review") }
            if ["verifying", "reviewing_implementation"].contains(stage) && !seen.contains("implementing") {
                throw HarnessProcessError.invalidResponse("implementation review preceded implementation")
            }
            if stage == "gold" && !seen.contains("reviewing_implementation") { throw HarnessProcessError.invalidResponse("Gold preceded implementation review") }
            guard ["planning", "reviewing_plan", "implementing", "verifying", "reviewing_implementation", "gold", "paused"].contains(stage) else {
                throw HarnessProcessError.invalidResponse("unknown run stage")
            }
            if stage == "gold" || stage == "paused" { terminalStage = stage }
            seen.insert(stage)
        }
        let expectedTerminalStage = terminals[0].type == "runCompleted" ? "gold" : "paused"
        guard terminalStage == expectedTerminalStage,
              terminals[0].payload["stage"] as? String == expectedTerminalStage else {
            throw HarnessProcessError.invalidResponse("terminal stage and terminal result disagreed")
        }
    }

    static func canonicalJSON(_ value: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        return try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    static func isValidTimestamp(_ value: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: value) != nil { return true }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value) != nil
    }

    func responsePayload(in envelopes: [Envelope], requestType: String) throws -> [String: Any] {
        guard let response = envelopes.first(where: {
            $0.type == "response" && ($0.payload["requestType"] as? String) == requestType
        }) else {
            throw HarnessProcessError.invalidResponse("missing \(requestType) response")
        }
        return response.payload
    }

    func decode<T: Decodable>(_ type: T.Type, from object: Any?, label: String) throws -> T {
        guard let object, JSONSerialization.isValidJSONObject(object) else {
            throw HarnessProcessError.invalidResponse("\(label) was absent or malformed")
        }
        do {
            return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
        } catch {
            throw HarnessProcessError.invalidResponse("\(label): \(error.localizedDescription)")
        }
    }

    func requiredString(_ value: Any?, label: String) throws -> String {
        guard let value = value as? String, !value.isEmpty else {
            throw HarnessProcessError.invalidResponse("\(label) must be a non-empty string")
        }
        return value
    }

    static func ancestors(of initial: URL) -> [URL] {
        var result: [URL] = []
        var current = initial.standardizedFileURL
        for _ in 0..<14 {
            result.append(current)
            let parent = current.deletingLastPathComponent()
            if parent == current { break }
            current = parent
        }
        return result
    }

    static func discoverNode(environment: [String: String]) -> URL? {
        return nodeCandidates(
            environment: environment,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
            .map { $0.resolvingSymlinksInPath() }
            .first(where: {
                FileManager.default.isExecutableFile(atPath: $0.path)
                    && supportsRequiredNodeVersion($0)
            })
    }

    static func isTrustedHarnessRoot(_ root: URL) -> Bool {
        let packageURL = root.appendingPathComponent("package.json")
        let scriptURL = root.appendingPathComponent("dist/cli/index.js")
        let piURL = root.appendingPathComponent("node_modules/@earendil-works/pi-coding-agent")
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: scriptURL.path),
              fileManager.fileExists(atPath: piURL.path),
              let data = try? Data(contentsOf: packageURL),
              let package = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              package["name"] as? String == "@barnlabs/lightningloop-harness",
              package["private"] as? Bool == true else {
            return false
        }
        return true
    }

    static func supportsRequiredNodeVersion(_ nodeURL: URL) -> Bool {
        let task = Process()
        let output = Pipe()
        task.executableURL = nodeURL
        task.arguments = ["--version"]
        task.environment = ["PATH": nodeURL.deletingLastPathComponent().path]
        task.standardOutput = output
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            guard task.terminationStatus == 0 else { return false }
            let version = String(decoding: data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "v"))
                .split(separator: ".")
                .prefix(2)
                .compactMap { Int($0) }
            guard version.count == 2 else { return false }
            return version[0] > 22 || (version[0] == 22 && version[1] >= 19)
        } catch {
            return false
        }
    }

    static func loopStage(_ value: String) -> LoopStage? {
        switch value {
        case "planning": .planning
        case "reviewing_plan": .reviewingPlan
        case "implementing": .implementing
        case "reviewing_implementation", "verifying": .reviewingImplementation
        case "gold": .completed
        case "paused": .paused
        case "failed": .failed
        default: nil
        }
    }
}
