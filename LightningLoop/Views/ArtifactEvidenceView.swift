import AppKit
import SwiftUI

struct ArtifactEvidenceView: View {
    let model: AppModel
    let session: LoopSession
    @State private var selectedSourcePath: String?

    private var previews: [ArtifactPreviewEvidence] { session.artifactReport?.previews ?? [] }
    private var isUITestFixture: Bool { session.title.contains("UI TEST FIXTURE") }
    private var evidenceReader: ArtifactEvidenceReader {
        ArtifactEvidenceReader(workspacePath: session.artifactWorkspacePath)
    }
    private var sourcePaths: [String] {
        guard let files = session.artifactReport?.files else { return [] }
        let extensions = Set(["py", "rs", "ts", "tsx", "js", "mjs", "cjs", "html", "css", "json", "toml"])
        return files.map(\.path).filter { extensions.contains(URL(fileURLWithPath: $0).pathExtension.lowercased()) }
    }

    var body: some View {
        Group {
            if let report = session.artifactReport {
                VStack(alignment: .leading, spacing: 18) {
                    overview(report)
                    if !previews.isEmpty { previewGallery }
                    viewers(report)
                    scriptRunner(report)
                    materializedFiles(report)
                    workspaceAudit(report)
                }
            } else {
                DesignedEmptyState(
                    title: "No workspace evidence",
                    detail: "Choose a dedicated artifact directory and enable verification to receive static picture evidence, script output, and reviewed files that open in their default apps.",
                    symbol: "viewfinder",
                    identifier: "evidence.empty"
                )
            }
        }
        .accessibilityIdentifier("evidence.lab")
    }

    private func overview(_ report: ArtifactExecutionReport) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Evidence Lab").font(.title2.bold())
                Text(report.summary).foregroundStyle(.secondary)
                Text("Evidence is captured by the local harness after materialization—not claimed by the model.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 8) {
                let state = currentReportState(report)
                Label(isUITestFixture ? "UI TEST FIXTURE" : state.label, systemImage: isUITestFixture ? "testtube.2" : state.systemImage)
                    .font(.caption.bold())
                    .foregroundStyle(isUITestFixture ? .orange : state.color)
                if isUITestFixture {
                    Text("NOT CURRENT VERIFICATION")
                        .font(.caption.bold())
                        .foregroundStyle(.orange)
                } else {
                    Text("\(previews.count) previews · \(report.commands.count) runs · \(report.files.count) files")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                if session.artifactWorkspacePath != nil {
                    Button("Reveal in Finder", action: model.revealArtifactWorkspace)
                }
            }
        }
    }

    private var previewGallery: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Static picture evidence", systemImage: "photo.on.rectangle")
                .font(.headline)
            ForEach(Array(previews.enumerated()), id: \.offset) { _, preview in
                let currentEvidence = currentPreviewEvidence(preview)
                let state = preview.passed ? ArtifactDisplayState(currentEvidence.state) : .failed
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(preview.title).font(.headline)
                                Text(preview.message).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Label(isUITestFixture ? "NOT CURRENT VERIFICATION" : state.label, systemImage: isUITestFixture ? "testtube.2" : state.systemImage)
                                .font(.caption.bold())
                                .foregroundStyle(isUITestFixture ? .orange : state.color)
                        }
                        if (preview.passed || isUITestFixture), currentEvidence.state == .verified,
                           let imageData = currentEvidence.data,
                           let image = NSImage(data: imageData) {
                            Image(nsImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity, maxHeight: 600)
                                .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        } else if preview.passed, !isUITestFixture {
                            Label(state.explanation, systemImage: state.systemImage)
                                .font(.caption)
                                .foregroundStyle(state.color)
                        }
                        if let loopback = preview.loopback {
                            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 5) {
                                GridRow {
                                    Label("Localhost proof", systemImage: "network")
                                    Text("HTTP \(loopback.status) · \(loopback.host) · \(ByteCountFormatter.string(fromByteCount: Int64(loopback.bytes), countStyle: .file))")
                                        .font(.caption.monospaced())
                                }
                                GridRow {
                                    Text("Response hash").foregroundStyle(.secondary)
                                    Text(loopback.sha256).font(.caption2.monospaced()).textSelection(.enabled)
                                }
                            }
                        }
                        if preview.kind == "html", preview.passed, state == .verified,
                           session.artifactVerificationCommands == true,
                           let source = fileEvidence(preview.sourcePath),
                           currentFileEvidence(source, maximumBytes: 10 * 1_048_576).state == .verified {
                            HStack {
                                Button("Open HTML in Default Browser") {
                                    model.openArtifactInDefaultApp(relativePath: source.path, expectedSHA256: source.sha256)
                                }
                                .buttonStyle(.borderedProminent)
                                Text("Hash-checked · short-lived loopback handoff · inspection only")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func viewers(_ report: ArtifactExecutionReport) -> some View {
        let viewable: [ArtifactFileEvidence] = report.files.filter { file in
            ArtifactViewerPolicy.kind(forRelativePath: file.path) != .none
        }
        if !viewable.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Label("Bound viewers", systemImage: "eye")
                    .font(.headline)
                Text(DesignedCopy.unverifiedBytes)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(viewable, id: \.path) { file in
                    boundViewerCard(for: file, in: report)
                }
            }
            .accessibilityIdentifier("evidence.bound.viewers")
        }
    }

    @ViewBuilder
    private func boundViewerCard(for file: ArtifactFileEvidence, in report: ArtifactExecutionReport) -> some View {
        let current = currentFileEvidence(file, maximumBytes: ArtifactEvidenceReader.maximumEvidenceBytes)
        let kind = ArtifactViewerPolicy.kind(forRelativePath: file.path)
        SurfaceCard {
            switch kind {
            case .image:
                ArtifactImageViewer(
                    title: file.path,
                    evidence: current,
                    compare: compareEvidence(for: file, in: report)
                )
            case .sceneKitModel, .glbOrGltf:
                ArtifactModelViewer(
                    title: file.path,
                    relativePath: file.path,
                    evidence: current,
                    fileURL: evidenceReader.verifiedFileURL(
                        relativePath: file.path,
                        expectedSHA256: file.sha256,
                        expectedBytes: file.bytes
                    )
                )
            case .none:
                EmptyView()
            }
        }
    }

    private func compareEvidence(for file: ArtifactFileEvidence, in report: ArtifactExecutionReport) -> ArtifactCurrentEvidence? {
        let images = report.files.filter { ArtifactViewerPolicy.kind(forRelativePath: $0.path) == .image && $0.path != file.path }
        guard let other = images.first else { return nil }
        return currentFileEvidence(other, maximumBytes: ArtifactEvidenceReader.maximumEvidenceBytes)
    }

    private func scriptRunner(_ report: ArtifactExecutionReport) -> some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Label("Sandboxed script runner", systemImage: "terminal")
                            .font(.headline)
                        Text("Bounded single-process Python and JavaScript checks run without process forking, network, or ambient credentials. Multi-process build tools fail closed.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(report.commands.isEmpty ? "NO RUNS" : "\(report.commands.filter(\.passed).count)/\(report.commands.count) PASSED")
                        .font(.caption.bold().monospacedDigit())
                        .foregroundStyle(report.commands.allSatisfy(\.passed) ? LoopBrand.mint : .red)
                }
                if report.commands.isEmpty {
                    Text("No executable verification was requested or selected for this artifact.")
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(report.commands.enumerated()), id: \.offset) { _, command in
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(([command.executable] + command.arguments).joined(separator: " "))
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                            Divider()
                            Text(command.output.isEmpty ? "No output." : command.output)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                        .padding(.top, 8)
                    } label: {
                        HStack {
                            Label("\(command.executable) · \(command.purpose)", systemImage: command.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(command.passed ? LoopBrand.mint : .red)
                            Spacer()
                            Text(command.origin == "harness" ? "AUTO" : "IMPLEMENTER")
                                .font(.caption2.bold())
                                .foregroundStyle(.secondary)
                            if let duration = command.durationMs {
                                Text("\(duration) ms").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !sourcePaths.isEmpty {
                    Divider()
                    HStack {
                        Label("Source inspection", systemImage: "chevron.left.forwardslash.chevron.right")
                            .font(.headline)
                        Spacer()
                        Picker("Source", selection: Binding(
                            get: { selectedSourcePath ?? sourcePaths.first ?? "" },
                            set: { selectedSourcePath = $0 }
                        )) {
                            ForEach(sourcePaths, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 300)
                    }
                    if let path = selectedSourcePath ?? sourcePaths.first {
                        let evidence = currentSourceEvidence(path)
                        let state = ArtifactDisplayState(evidence.state)
                        VStack(alignment: .leading, spacing: 8) {
                            Label(isUITestFixture && state == .verified ? "FIXTURE BYTES MATCH" : (state == .verified ? "CURRENT BYTES VERIFIED" : state.label), systemImage: isUITestFixture && state == .verified ? "testtube.2" : state.systemImage)
                                .font(.caption.bold())
                                .foregroundStyle(isUITestFixture && state == .verified ? .orange : state.color)
                            if state == .verified,
                               let data = evidence.data,
                               let source = String(data: data, encoding: .utf8) {
                                ScrollView([.horizontal, .vertical]) {
                                    Text(source)
                                        .font(.caption.monospaced())
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(10)
                                }
                                .frame(minHeight: 160, maxHeight: 360)
                                .background(.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
                            } else {
                                Text("The current workspace source is not shown because it no longer matches the reviewed evidence.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func materializedFiles(_ report: ArtifactExecutionReport) -> some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Materialized files").font(.headline)
                ForEach(report.files, id: \.path) { file in
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 3) {
                        GridRow {
                            Image(systemName: "doc.fill").foregroundStyle(LoopBrand.mint)
                            Text(file.path).font(.callout.monospaced())
                            Text(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                            Button(file.path.lowercased().hasSuffix(".html") ? "Open in Default Browser" : "Open in Default App") {
                                model.openArtifactInDefaultApp(relativePath: file.path, expectedSHA256: file.sha256)
                            }
                            .buttonStyle(.link)
                        }
                        GridRow {
                            Color.clear.frame(width: 1, height: 1)
                            Text("sha256 \(file.sha256)")
                                .font(.caption2.monospaced()).foregroundStyle(.secondary)
                                .textSelection(.enabled).gridCellColumns(2)
                        }
                    }
                }
            }
        }
    }

    private func workspaceAudit(_ report: ArtifactExecutionReport) -> some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 6) {
                Label(report.workspaceAudit.message, systemImage: report.workspaceAudit.passed ? "checkmark.shield" : "exclamationmark.shield")
                    .foregroundStyle(report.workspaceAudit.passed ? Color.secondary : Color.red)
                Text("\(report.workspaceAudit.files) files · \(ByteCountFormatter.string(fromByteCount: Int64(report.workspaceAudit.bytes), countStyle: .file))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func fileEvidence(_ path: String) -> ArtifactFileEvidence? {
        session.artifactReport?.files.first(where: { $0.path == path })
    }

    private func currentPreviewEvidence(_ preview: ArtifactPreviewEvidence) -> ArtifactCurrentEvidence {
        guard let evidence = fileEvidence(preview.previewPath) else {
            return ArtifactCurrentEvidence(state: .unavailable, data: nil)
        }
        return evidenceReader.inspect(
            relativePath: evidence.path,
            expectedSHA256: evidence.sha256,
            expectedBytes: evidence.bytes,
            requireDecodableImage: true
        )
    }

    private func currentFileEvidence(_ evidence: ArtifactFileEvidence, maximumBytes: Int) -> ArtifactCurrentEvidence {
        evidenceReader.inspect(
            relativePath: evidence.path,
            expectedSHA256: evidence.sha256,
            expectedBytes: evidence.bytes,
            maximumBytes: maximumBytes
        )
    }

    private func currentSourceEvidence(_ relativePath: String) -> ArtifactCurrentEvidence {
        guard let evidence = fileEvidence(relativePath) else {
            return ArtifactCurrentEvidence(state: .unavailable, data: nil)
        }
        return evidenceReader.inspect(
            relativePath: evidence.path,
            expectedSHA256: evidence.sha256,
            expectedBytes: evidence.bytes,
            maximumBytes: 524_288,
            requireUTF8Text: true
        )
    }

    private func currentReportState(_ report: ArtifactExecutionReport) -> ArtifactDisplayState {
        ArtifactDisplayState(evidenceReader.reportState(report, sourcePaths: sourcePaths))
    }
}

private enum ArtifactDisplayState: Equatable {
    case verified
    case failed
    case unavailable
    case tampered
    case unreadable

    init(_ state: ArtifactCurrentEvidenceState) {
        switch state {
        case .verified: self = .verified
        case .failed: self = .failed
        case .unavailable: self = .unavailable
        case .tampered: self = .tampered
        case .unreadable: self = .unreadable
        }
    }

    var label: String {
        switch self {
        case .verified: "VERIFIED"
        case .failed: "FAILED"
        case .unavailable: "EVIDENCE UNAVAILABLE"
        case .tampered: "EVIDENCE CHANGED"
        case .unreadable: "EVIDENCE UNREADABLE"
        }
    }

    var systemImage: String {
        switch self {
        case .verified: "checkmark.shield.fill"
        case .failed: "xmark.shield.fill"
        case .unavailable: "questionmark.diamond.fill"
        case .tampered: "exclamationmark.triangle.fill"
        case .unreadable: "eye.slash.fill"
        }
    }

    var color: Color {
        switch self {
        case .verified: LoopBrand.mint
        case .unavailable: .orange
        case .failed, .tampered, .unreadable: .red
        }
    }

    var explanation: String {
        switch self {
        case .verified: "Current bytes match the reviewed evidence."
        case .failed: "The persisted verification failed."
        case .unavailable: "The reviewed evidence file is missing or unavailable."
        case .tampered: "Current bytes differ from the reviewed evidence hash."
        case .unreadable: "Current bytes match the evidence hash but cannot be decoded for display."
        }
    }
}
