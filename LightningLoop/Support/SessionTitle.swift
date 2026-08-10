import Foundation

/// Provenance of a loop's sidebar title. Manual renames lock further auto updates.
enum SessionTitleSource: String, Codable, Sendable, Hashable {
    case provisional
    case structured
    case llm
    case manual
}

enum SessionTitle {
    static let emptyTitle = "New loop"
    /// Sidebar-friendly cap; longer goals stay in `goal`, not the row title.
    static let maxLength = 56

    private static let leadingNoise: [String] = [
        "please ",
        "pls ",
        "help me ",
        "can you ",
        "could you ",
        "i want to ",
        "i need to ",
        "i'd like to ",
        "i would like to ",
        "write ",
        "create ",
        "build ",
        "make ",
        "generate ",
    ]

    /// Layer 0: offline provisional title from the goal text.
    static func provisional(from goal: String) -> String {
        let collapsed = collapseWhitespace(goal)
        guard !collapsed.isEmpty else { return emptyTitle }
        var working = collapsed
        let lower = working.lowercased()
        for prefix in leadingNoise where lower.hasPrefix(prefix) {
            working = String(working.dropFirst(prefix.count))
            break
        }
        working = collapseWhitespace(working)
        if let firstSentence = firstSentence(working), !firstSentence.isEmpty {
            working = firstSentence
        }
        working = limitWords(working, maxWords: 8)
        return truncate(working.isEmpty ? collapsed : working, maxLength: maxLength)
    }

    /// Layer 1: prefer plan/criterion titles when present; else clarified summary; else goal.
    static func structured(
        goal: String,
        clarifiedSummary: String,
        criteria: [Criterion],
        plan: [PlanStep]
    ) -> String {
        resolved(goal: goal, clarifiedSummary: clarifiedSummary, criteria: criteria, plan: plan).title
    }

    /// Same title resolution as `structured`, plus the provenance that must be stored on the session.
    /// Summary-only titles are `.structured` (not `.provisional`) so goal edits do not clobber them.
    static func resolved(
        goal: String,
        clarifiedSummary: String,
        criteria: [Criterion],
        plan: [PlanStep]
    ) -> (title: String, source: SessionTitleSource) {
        if let step = plan.first(where: { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return (truncate(collapseWhitespace(step.title), maxLength: maxLength), .structured)
        }
        if let criterion = criteria.first(where: { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return (truncate(collapseWhitespace(criterion.title), maxLength: maxLength), .structured)
        }
        let summary = collapseWhitespace(clarifiedSummary)
        if !summary.isEmpty {
            return (provisional(from: summary), .structured)
        }
        return (provisional(from: goal), .provisional)
    }

    /// Parse a model title response; returns nil when unusable so callers fall back.
    static func parseLLMTitle(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let data = trimmed.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let title = object["title"] as? String {
            return sanitizeLLMTitle(title)
        }

        // Tolerate fenced or prose-wrapped JSON.
        if let start = trimmed.firstIndex(of: "{"),
           let end = trimmed.lastIndex(of: "}"),
           start < end {
            let slice = String(trimmed[start...end])
            if let data = slice.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let title = object["title"] as? String {
                return sanitizeLLMTitle(title)
            }
        }

        // Bare title line without JSON.
        let firstLine = trimmed.split(whereSeparator: \.isNewline).first.map(String.init) ?? trimmed
        let stripped = firstLine
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'`"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sanitizeLLMTitle(stripped)
    }

    static func sanitizeLLMTitle(_ title: String) -> String? {
        let working = collapseWhitespace(title)
        let lower = working.lowercased()
        let bannedPrefixes = [
            "alright", "sure", "here", "i need", "i'll", "i will", "the title",
            "title:", "concise title", "okay", "ok,",
        ]
        for prefix in bannedPrefixes where lower.hasPrefix(prefix) {
            return nil
        }
        guard (2...maxLength).contains(working.count) else { return nil }
        // Reject sentences that look like model preamble.
        if working.count > 40, working.contains(" title ") { return nil }
        return truncate(working, maxLength: maxLength)
    }

    static func shouldAutoUpdate(source: SessionTitleSource, locked: Bool) -> Bool {
        !locked && source != .manual
    }

    // MARK: - helpers

    static func collapseWhitespace(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func firstSentence(_ text: String) -> String? {
        let delimiters = CharacterSet(charactersIn: ".!?")
        if let range = text.rangeOfCharacter(from: delimiters) {
            let sentence = String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            if sentence.count >= 8 { return sentence }
        }
        return nil
    }

    private static func limitWords(_ text: String, maxWords: Int) -> String {
        let words = text.split(whereSeparator: { $0.isWhitespace })
        guard words.count > maxWords else { return text }
        return words.prefix(maxWords).joined(separator: " ")
    }

    static func truncate(_ text: String, maxLength: Int) -> String {
        let collapsed = collapseWhitespace(text)
        guard collapsed.count > maxLength else { return collapsed.isEmpty ? emptyTitle : collapsed }
        let end = collapsed.index(collapsed.startIndex, offsetBy: max(1, maxLength - 1))
        return String(collapsed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}
