import SwiftUI
import WebKit

private enum WorkspaceSection: String, CaseIterable, Identifiable {
    case output = "Output"
    case artifacts = "Evidence"
    case browser = "Browser"
    case criteria = "Criteria"
    case plan = "Plan"
    case reviews = "Reviews"
    case trace = "Trace"
    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .output: "doc.richtext"
        case .artifacts: "viewfinder"
        case .browser: "safari"
        case .criteria: "scope"
        case .plan: "list.number"
        case .reviews: "checkmark.seal"
        case .trace: "point.3.connected.trianglepath.dotted"
        }
    }
}

struct LoopWorkspaceView: View {
    let model: AppModel
    let session: LoopSession
    @State private var section: WorkspaceSection

    init(model: AppModel, session: LoopSession) {
        self.model = model
        self.session = session
        let environment = ProcessInfo.processInfo.environment
        let startsInEvidence = environment["LIGHTNINGLOOP_UI_TESTING"] == "1"
            && environment["LIGHTNINGLOOP_EVIDENCE_DEMO_ROOT"] != nil
        _section = State(initialValue: startsInEvidence ? .artifacts : .output)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            sectionBar
            Divider()
            ScrollView {
                Group {
                    switch section {
                    case .output: output
                    case .artifacts: artifacts
                    case .browser: LoopBrowserView(session: session)
                    case .criteria: criteria
                    case .plan: plan
                    case .reviews: reviews
                    case .trace: trace
                    }
                }
                .frame(maxWidth: 980, alignment: .leading)
                .padding(.horizontal, 32)
                .padding(.vertical, 28)
                .frame(maxWidth: .infinity)
            }
        }
        .background(LoopBrand.raisedSurface)
    }

    @ViewBuilder private var artifacts: some View {
        ArtifactEvidenceView(model: model, session: session)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 14) {
                LoopLogo(size: 42)
                VStack(alignment: .leading, spacing: 3) {
                    Text("STRICT LOOP")
                        .font(.caption2.weight(.bold))
                        .tracking(1.4)
                        .foregroundStyle(.secondary)
                    Text(session.title)
                        .font(.title2.bold())
                        .lineLimit(2)
                    Text(session.statusMessage)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                StatusPill(stage: session.stage)
            }
            HStack {
                MetricsStrip(metrics: session.metrics)
                Spacer()
                if model.isRunning {
                    ProgressView().controlSize(.small)
                    Button("Cancel", action: model.cancelCurrentOperation)
                } else if session.stage == .paused || session.stage == .failed {
                    Button("Try Again") { model.startLoop() }
                        .disabled(!model.allQuestionsAnswered)
                        .help(model.allQuestionsAnswered ? "Start another bounded run" : "Answer every clarification question before trying again")
                }
            }
        }
        .frame(maxWidth: 980, alignment: .leading)
        .padding(.horizontal, 32)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity)
    }

    private var sectionBar: some View {
        HStack(spacing: 4) {
            ForEach(WorkspaceSection.allCases) { item in
                Button {
                    section = item
                } label: {
                    Label(item.rawValue, systemImage: item.symbol)
                        .font(.callout.weight(section == item ? .semibold : .regular))
                        .foregroundStyle(section == item ? .primary : .secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            section == item ? AnyShapeStyle(LoopBrand.blue.opacity(0.13)) : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(section == item ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: 980)
        .padding(.horizontal, 32)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(LoopBrand.raisedSurface.opacity(0.28))
    }

    @ViewBuilder private var output: some View {
        if session.implementation.isEmpty {
            SurfaceCard {
                VStack(spacing: 16) {
                    if model.isRunning {
                        ProgressView().controlSize(.large)
                    } else {
                        Image(systemName: emptyOutputSymbol)
                            .font(.system(size: 34, weight: .semibold))
                            .foregroundStyle(emptyOutputColor)
                            .accessibilityHidden(true)
                    }
                    VStack(spacing: 6) {
                        Text(emptyOutputTitle).font(.title3.bold())
                        Text(session.statusMessage)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 620)
                    }
                    Text(emptyOutputGuidance)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 580)
                        .accessibilityIdentifier("blocked.recovery.guidance")
                    if !model.isRunning && (session.stage == .paused || session.stage == .failed) {
                        SettingsLink {
                            Label("Open Settings", systemImage: "gearshape")
                        }
                        .accessibilityIdentifier("open.settings.blocked")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(36)
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.stage == .completed ? "Gold deliverable" : "Current deliverable")
                            .font(.title2.bold())
                        Text(session.stage == .completed ? "Passed strict criterion-by-criterion review." : "Preserved at the latest review boundary.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { model.copyImplementation() } label: { Label("Copy", systemImage: "doc.on.doc") }
                    Button { model.exportImplementation() } label: { Label("Export", systemImage: "square.and.arrow.up") }
                }
                SurfaceCard {
                    MarkdownResultView(markdown: session.implementation)
                        .frame(maxWidth: 760, alignment: .leading)
                }
                .frame(maxWidth: 860, alignment: .leading)
                if !session.implementationNotes.isEmpty {
                    SurfaceCard {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Implementation notes").font(.headline)
                            ForEach(session.implementationNotes, id: \.self) { Label($0, systemImage: "info.circle") }
                        }
                    }
                }
            }
        }
    }

    private var emptyOutputTitle: String {
        if model.isRunning { return "Work is in progress" }
        return switch session.stage {
        case .paused: "Paused before a deliverable was produced"
        case .failed: "Stopped safely before producing output"
        default: "No deliverable yet"
        }
    }

    private var emptyOutputGuidance: String {
        if model.isRunning { return "Switch to Trace to inspect each completed handoff." }
        return switch session.stage {
        case .paused: "Resolve the named blocker, then use Try Again. The prior loop history remains preserved."
        case .failed: "Review the status and trace before retrying. LightningLoop does not turn an error into a partial success."
        default: "The output area will populate only after the implementation stage begins."
        }
    }

    private var emptyOutputSymbol: String {
        switch session.stage {
        case .paused: "pause.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        default: "doc.badge.ellipsis"
        }
    }

    private var emptyOutputColor: Color {
        switch session.stage {
        case .failed: .red
        case .paused: .orange
        default: LoopBrand.blue
        }
    }

    private var criteria: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Acceptance contract").font(.title2.bold())
            ForEach(session.criteria) { criterion in
                SurfaceCard {
                    HStack(alignment: .top, spacing: 13) {
                        Text(criterion.id)
                            .font(.caption.bold().monospaced())
                            .foregroundStyle(LoopBrand.blue)
                            .padding(6)
                            .background(LoopBrand.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                        VStack(alignment: .leading, spacing: 6) {
                            Text(criterion.title).font(.headline)
                            Text(criterion.detail)
                            Label(criterion.evidence, systemImage: "checkmark.square")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !session.acceptanceTest.isEmpty {
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("End-to-end acceptance test", systemImage: "scope")
                            .font(.headline)
                        Text(session.acceptanceTest)
                    }
                }
            }
        }
    }

    private var plan: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Reviewed execution plan").font(.title2.bold())
            ForEach(Array(session.plan.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .top, spacing: 14) {
                    Text("\(index + 1)")
                        .font(.headline.monospacedDigit())
                        .frame(width: 30, height: 30)
                        .background(LoopBrand.blue.opacity(0.12), in: Circle())
                    SurfaceCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(step.title).font(.headline)
                            Text(step.detail)
                            Label(step.proof, systemImage: "checkmark.diamond")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            if !session.risks.isEmpty {
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 7) {
                        Label("Known risks", systemImage: "exclamationmark.shield")
                            .font(.headline)
                        ForEach(session.risks, id: \.self) { Text("• \($0)") }
                    }
                }
            }
        }
    }

    private var reviews: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Harsh review record").font(.title2.bold())
            if session.reviews.isEmpty {
                ContentUnavailableView("No reviews yet", systemImage: "checkmark.seal")
            }
            ForEach(session.reviews.reversed()) { review in
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label("\(review.target) · round \(review.round)", systemImage: review.passed ? "checkmark.seal.fill" : "xmark.seal.fill")
                                .font(.headline)
                                .foregroundStyle(review.passed ? LoopBrand.gold : .red)
                            Spacer()
                            Text("\(review.score)/10")
                                .font(.title3.bold().monospacedDigit())
                        }
                        Text(review.summary)
                        ForEach(review.findings) { finding in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(finding.severity.uppercased())
                                    .font(.caption2.bold())
                                    .foregroundStyle(finding.severity.lowercased() == "blocking" ? .red : .orange)
                                Text(finding.issue).font(.callout.weight(.medium))
                                Text("Required: \(finding.requiredChange)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.leading, 10)
                            .overlay(alignment: .leading) {
                                Rectangle().fill(.red.opacity(0.5)).frame(width: 2)
                            }
                        }
                    }
                }
            }
        }
    }

    private var trace: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Agent trace").font(.title2.bold()).padding(.bottom, 18)
            ForEach(session.timeline) { entry in
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 0) {
                        Image(systemName: entry.role.symbol)
                            .foregroundStyle(entry.role == .reviewer ? LoopBrand.gold : LoopBrand.blue)
                            .frame(width: 30, height: 30)
                            .background(.quaternary, in: Circle())
                        Rectangle().fill(.quaternary).frame(width: 2, height: 62)
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(entry.title).font(.headline)
                            Spacer()
                            Text(entry.role.displayName)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        Text(entry.summary).foregroundStyle(.secondary)
                        MetricsStrip(metrics: entry.metrics)
                    }
                    .padding(.bottom, 18)
                }
            }
            if model.isRunning {
                HStack(spacing: 12) {
                    ProgressView().controlSize(.small)
                    Text(session.statusMessage).foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct LoopBrowserView: View {
    let session: LoopSession
    @State private var address = "https://www.rfc-editor.org/rfc/rfc9110"
    @State private var destination: URL?
    @State private var refusal = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Browser").font(.title2.bold())
            Text("Opens hash-verified Evidence Lab pages on 127.0.0.1, or one reputable HTTPS primary source. Everything else is refused.")
                .foregroundStyle(.secondary)
            HStack {
                TextField("https://…", text: $address)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                Button("Open", action: open)
            }
            if session.artifactReport != nil {
                Text("Paste a reviewed 127.0.0.1 Evidence Lab URL from the Evidence tab to inspect it here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !refusal.isEmpty {
                Text(refusal).foregroundStyle(.orange)
            }
            LoopWebView(url: destination)
                .frame(minHeight: 420)
                .background(LoopBrand.raisedSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .accessibilityIdentifier("loop.browser")
    }

    private func open() {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            refusal = "Enter a valid URL."
            destination = nil
            return
        }
        guard SourceTrust.isReputable(url) else {
            refusal = "Refused: not a reputable primary source or reviewed artifact."
            destination = nil
            return
        }
        refusal = ""
        destination = url
    }
}

private struct LoopWebView: NSViewRepresentable {
    let url: URL?

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.allowed = url
        guard let url else { return }
        if view.url != url {
            view.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var allowed: URL?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url, SourceTrust.isReputable(url) else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
