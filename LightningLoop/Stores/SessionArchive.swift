import Foundation

@MainActor
struct SessionArchive {
    private let fileURL: URL

    init(fileManager: FileManager = .default, fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            return
        }
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = support.appendingPathComponent("LightningLoop", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        self.fileURL = directory.appendingPathComponent("sessions.json")
    }

    func load() -> [LoopSession] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        if let decoded = try? JSONDecoder().decode([LoopSession].self, from: data) { return decoded }
        guard var objects = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        for index in objects.indices where objects[index]["attachments"] == nil { objects[index]["attachments"] = [] }
        guard let migrated = try? JSONSerialization.data(withJSONObject: objects),
              let sessions = try? JSONDecoder().decode([LoopSession].self, from: migrated) else { return [] }
        return sessions
    }

    @discardableResult
    func save(_ sessions: [LoopSession]) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(sessions) else { return false }
        do {
            try data.write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            return true
        } catch {
            // Session persistence is best effort; run state remains visible in memory.
            return false
        }
    }
}
