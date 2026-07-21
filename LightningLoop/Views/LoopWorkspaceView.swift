import SwiftUI

private enum WorkspaceSection: String, CaseIterable, Identifiable {
    case output = "Output"
    case artifacts = "Evidence"
    case criteria = "Criteria"
    case plan = "Plan"
    case reviews = "Reviews"
    case trace = "Trace"
    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .output: "doc.richtext"
        case .artifacts: "viewfinder"
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
                } else if session.stage == .paused {
                    Button("Run Again") { model.startLoop() }
                        .disabled(!model.allQuestionsAnswered)
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
                VStack(spacing: 14) {
                    ProgressView().controlSize(.large)
                    Text(session.statusMessage).font(.headline)
                    Text("Switch to Trace to watch each agent handoff.")
                        .foregroundStyle(.secondary)
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
