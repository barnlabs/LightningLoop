import Foundation

enum LoopHistoryFilter {
    static func visible(sessions: [LoopSession], query: String) -> [LoopSession] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return sessions }
        return sessions.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
    }
}
