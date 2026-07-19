import SwiftUI

enum LoopBrand {
    static let blue = Color(red: 0.08, green: 0.48, blue: 0.98)
    static let cyan = Color(red: 0.14, green: 0.82, blue: 0.96)
    static let gold = Color(red: 0.98, green: 0.64, blue: 0.10)
    static let deepNavy = Color(red: 0.02, green: 0.06, blue: 0.13)
}

struct LoopLogo: View {
    var size: CGFloat = 36

    var body: some View {
        Image(nsImage: NSApplication.shared.applicationIconImage)
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct BarnLabsWordmark: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles.rectangle.stack")
            Text("BARNLABS")
                .font(.caption.weight(.bold))
                .tracking(1.7)
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("BarnLabs")
    }
}

struct SurfaceCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(18)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(.primary.opacity(0.08))
            }
    }
}

struct StatusPill: View {
    let stage: LoopStage

    var body: some View {
        Label(stage.label, systemImage: stage.symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(color.opacity(0.12), in: Capsule())
    }

    private var color: Color {
        switch stage {
        case .completed: LoopBrand.gold
        case .failed: .red
        case .paused: .orange
        case .draft: .secondary
        default: LoopBrand.blue
        }
    }
}

struct MetricsStrip: View {
    let metrics: InferenceMetrics

    var body: some View {
        HStack(spacing: 12) {
            metric("\(metrics.promptTokens + metrics.completionTokens)", label: "tokens", symbol: "text.word.spacing")
            if let speed = metrics.tokensPerSecond, speed.isFinite {
                metric(speed.formatted(.number.precision(.fractionLength(0))), label: "tok/s", symbol: "bolt.fill")
            }
            metric(metrics.totalSeconds.formatted(.number.precision(.fractionLength(2))), label: "model s", symbol: "timer")
            metric(metrics.estimatedCostUSD.formatted(.currency(code: "USD").precision(.fractionLength(4))), label: "est.", symbol: "dollarsign.circle")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func metric(_ value: String, label: String, symbol: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
            Text(value).monospacedDigit().foregroundStyle(.primary)
            Text(label)
        }
    }
}

struct MarkdownResultView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text))
                .font(headingFont(level))
                .padding(.top, level == 1 ? 4 : 2)
        case .paragraph(let text):
            Text(inline(text))
                .fixedSize(horizontal: false, vertical: true)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•").foregroundStyle(LoopBrand.blue)
                Text(inline(text)).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 6)
        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker).monospacedDigit().foregroundStyle(LoopBrand.blue)
                Text(inline(text)).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 6)
        case .quote(let text):
            Text(inline(text))
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(LoopBrand.blue.opacity(0.55)).frame(width: 3)
                }
        case .code(let language, let code):
            VStack(alignment: .leading, spacing: 6) {
                if !language.isEmpty {
                    Text(language.uppercased())
                        .font(.caption2.bold().monospaced())
                        .foregroundStyle(.secondary)
                }
                ScrollView(.horizontal) {
                    Text(code)
                        .font(.system(.callout, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12)
            .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 9))
        case .divider:
            Divider().padding(.vertical, 4)
        }
    }

    private var blocks: [MarkdownBlock] {
        let lines = markdown.components(separatedBy: .newlines)
        var result: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let raw = lines[index]
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                index += 1
                continue
            }
            if line.hasPrefix("```") {
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var codeLines: [String] = []
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                result.append(.code(language: language, code: codeLines.joined(separator: "\n")))
                continue
            }
            if line == "---" || line == "***" {
                result.append(.divider)
                index += 1
                continue
            }
            if let heading = heading(from: line) {
                result.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") {
                result.append(.bullet(String(line.dropFirst(2))))
                index += 1
                continue
            }
            if line.hasPrefix("> ") {
                result.append(.quote(String(line.dropFirst(2))))
                index += 1
                continue
            }
            if let numbered = numberedItem(from: line) {
                result.append(.numbered(marker: numbered.marker, text: numbered.text))
                index += 1
                continue
            }

            var paragraphLines = [line]
            index += 1
            while index < lines.count {
                let next = lines[index].trimmingCharacters(in: .whitespaces)
                if next.isEmpty || startsBlock(next) { break }
                paragraphLines.append(next)
                index += 1
            }
            result.append(.paragraph(paragraphLines.joined(separator: " ")))
        }
        return result
    }

    private func startsBlock(_ line: String) -> Bool {
        line.hasPrefix("#") || line.hasPrefix("- ") || line.hasPrefix("* ")
            || line.hasPrefix("> ") || line.hasPrefix("```") || line == "---" || line == "***"
            || numberedItem(from: line) != nil
    }

    private func heading(from line: String) -> (level: Int, text: String)? {
        let prefixCount = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(prefixCount), line.dropFirst(prefixCount).hasPrefix(" ") else { return nil }
        return (prefixCount, String(line.dropFirst(prefixCount + 1)))
    }

    private func numberedItem(from line: String) -> (marker: String, text: String)? {
        guard let separator = line.firstIndex(of: ".") else { return nil }
        let number = line[..<separator]
        let remainder = line[line.index(after: separator)...]
        guard !number.isEmpty, number.allSatisfy(\.isNumber), remainder.hasPrefix(" ") else { return nil }
        return ("\(number).", String(remainder.dropFirst()))
    }

    private func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title.bold()
        case 2: .title2.bold()
        case 3: .title3.bold()
        default: .headline
        }
    }
}

private enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullet(String)
    case numbered(marker: String, text: String)
    case quote(String)
    case code(language: String, code: String)
    case divider
}
