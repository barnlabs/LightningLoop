import AppKit
import CryptoKit
import Foundation

enum ArtifactCurrentEvidenceState: Equatable {
    case verified
    case failed
    case unavailable
    case tampered
    case unreadable
}

struct ArtifactCurrentEvidence: Equatable {
    let state: ArtifactCurrentEvidenceState
    let data: Data?
}

/// Reads mutable workspace files as untrusted input and returns data only when it
/// still matches the immutable evidence hash captured by the harness.
struct ArtifactEvidenceReader {
    static let maximumEvidenceBytes = 10 * 1_048_576
    static let maximumReportFiles = 2_048
    static let maximumReportBytes = 134_217_728
    private let workspacePath: String?

    init(workspacePath: String?) {
        self.workspacePath = workspacePath
    }

    func reportState(_ report: ArtifactExecutionReport, sourcePaths: [String]) -> ArtifactCurrentEvidenceState {
        guard report.passed else { return .failed }
        guard report.files.count <= Self.maximumReportFiles else { return .unavailable }
        var reportBytes = 0
        for evidence in report.files {
            guard evidence.bytes >= 0,
                  evidence.bytes <= Self.maximumReportBytes - reportBytes else { return .unavailable }
            reportBytes += evidence.bytes
            let state = inspect(
                relativePath: evidence.path,
                expectedSHA256: evidence.sha256,
                expectedBytes: evidence.bytes
            ).state
            guard state == .verified else { return state }
        }
        for preview in report.previews ?? [] {
            guard preview.passed else { return .failed }
            guard let evidence = report.files.first(where: { $0.path == preview.previewPath }) else {
                return .unavailable
            }
            let state = inspect(
                relativePath: evidence.path,
                expectedSHA256: evidence.sha256,
                expectedBytes: evidence.bytes,
                requireDecodableImage: true
            ).state
            guard state == .verified else { return state }
        }
        for path in sourcePaths {
            guard let evidence = report.files.first(where: { $0.path == path }) else {
                return .unavailable
            }
            let state = inspect(
                relativePath: evidence.path,
                expectedSHA256: evidence.sha256,
                expectedBytes: evidence.bytes,
                maximumBytes: 524_288,
                requireUTF8Text: true
            ).state
            guard state == .verified else { return state }
        }
        return .verified
    }

    func inspect(
        relativePath: String,
        expectedSHA256: String,
        expectedBytes: Int? = nil,
        maximumBytes: Int = ArtifactEvidenceReader.maximumEvidenceBytes,
        requireDecodableImage: Bool = false,
        requireUTF8Text: Bool = false
    ) -> ArtifactCurrentEvidence {
        let boundedMaximumBytes = min(maximumBytes, Self.maximumEvidenceBytes)
        guard boundedMaximumBytes >= 0,
              expectedBytes.map({ $0 >= 0 && $0 <= boundedMaximumBytes }) ?? true,
              let url = resolvedURL(relativePath),
              let fileSize = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
            return ArtifactCurrentEvidence(state: .unavailable, data: nil)
        }
        if let expectedBytes, fileSize != expectedBytes {
            return ArtifactCurrentEvidence(state: .tampered, data: nil)
        }
        let readMaximumBytes = expectedBytes ?? boundedMaximumBytes
        guard fileSize <= boundedMaximumBytes,
              let data = boundedData(contentsOf: url, maximumBytes: readMaximumBytes) else {
            return ArtifactCurrentEvidence(state: expectedBytes == nil ? .unavailable : .tampered, data: nil)
        }
        if let expectedBytes, data.count != expectedBytes {
            return ArtifactCurrentEvidence(state: .tampered, data: nil)
        }

        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == expectedSHA256.lowercased() else {
            return ArtifactCurrentEvidence(state: .tampered, data: nil)
        }
        if requireDecodableImage, NSImage(data: data) == nil {
            return ArtifactCurrentEvidence(state: .unreadable, data: nil)
        }
        if requireUTF8Text, (data.contains(0) || String(data: data, encoding: .utf8) == nil) {
            return ArtifactCurrentEvidence(state: .unreadable, data: nil)
        }
        return ArtifactCurrentEvidence(state: .verified, data: data)
    }

    private func resolvedURL(_ relativePath: String) -> URL? {
        guard let workspacePath,
              !relativePath.isEmpty,
              !relativePath.hasPrefix("/"),
              !relativePath.split(separator: "/").contains("..") else { return nil }

        let root = URL(fileURLWithPath: workspacePath, isDirectory: true).standardizedFileURL
        let rootValues = try? root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues?.isDirectory == true, rootValues?.isSymbolicLink != true else { return nil }

        var candidate = root
        for component in relativePath.split(separator: "/") {
            candidate.appendPathComponent(String(component))
            let values = try? candidate.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values?.isSymbolicLink != true else { return nil }
        }
        candidate = candidate.standardizedFileURL
        guard candidate.path.hasPrefix(root.path + "/") else { return nil }
        let values = try? candidate.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values?.isRegularFile == true, values?.isSymbolicLink != true else { return nil }
        return candidate
    }

    private func boundedData(contentsOf url: URL, maximumBytes: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var result = Data()
        while result.count < maximumBytes {
            let remaining = maximumBytes - result.count
            do {
                let chunk = try handle.read(upToCount: min(remaining, 64 * 1_024)) ?? Data()
                guard !chunk.isEmpty else { return result }
                result.append(chunk)
            } catch {
                return nil
            }
        }
        do {
            let extra = try handle.read(upToCount: 1) ?? Data()
            return extra.isEmpty ? result : nil
        } catch {
            return nil
        }
    }
}
