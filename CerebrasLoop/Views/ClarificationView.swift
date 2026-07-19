import SwiftUI

struct ClarificationView: View {
    let model: AppModel
    let session: LoopSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Make the target falsifiable")
                            .font(.largeTitle.bold())
                        Text(session.clarifiedSummary)
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(stage: session.stage)
                }

                ForEach(Array(session.questions.enumerated()), id: \.element.id) { index, question in
                    SurfaceCard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .firstTextBaseline) {
                                Text("Q\(index + 1)")
                                    .font(.caption.bold())
                                    .foregroundStyle(LoopBrand.blue)
                                Text(question.question)
                                    .font(.headline)
                            }
                            Text(question.whyItMatters)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextEditor(text: Binding(
                                get: { session.answers[question.id] ?? "" },
                                set: { model.updateAnswer(questionID: question.id, value: $0) }
                            ))
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 64)
                            .padding(8)
                            .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 9))
                        }
                    }
                }

                HStack {
                    Text("The reviewer may reject both the plan and the result up to \(model.configuredReviewCycles) times each.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        model.startLoop()
                    } label: {
                        Label("Start Strict Loop", systemImage: "bolt.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(LoopBrand.blue)
                    .disabled(!model.allQuestionsAnswered || !model.hasAPIKey)
                }
            }
            .frame(maxWidth: 820)
            .padding(.horizontal, 34)
            .padding(.bottom, 34)
            .padding(.top, 76)
            .frame(maxWidth: .infinity)
        }
    }
}
