import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageAttachmentError: LocalizedError, Equatable {
    case limitReached
    case unsafeFile
    case unsupportedFormat
    case invalidSize
    case copyFailed

    var errorDescription: String? {
        switch self {
        case .limitReached: "A loop may include at most four images."
        case .unsafeFile: "Choose a regular local image file, not a link or directory."
        case .unsupportedFormat: "LightningLoop accepts PNG, JPEG, WebP, and GIF images."
        case .invalidSize: "Each image must be larger than zero bytes and no larger than 10 MB."
        case .copyFailed: "The image could not be copied into protected LightningLoop storage."
        }
    }
}

struct ImageAttachmentStore: Sendable {
    static let maximumCount = 4
    static let maximumBytes = 10 * 1_024 * 1_024

    private let rootURL: URL

    init(fileManager: FileManager = .default, rootURL: URL? = nil) {
        if let rootURL {
            self.rootURL = rootURL
        } else {
            let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            self.rootURL = support.appendingPathComponent("LightningLoop/attachments", isDirectory: true)
        }
    }

    func importImage(from source: URL, sessionID: UUID, existingCount: Int) throws -> ImageAttachment {
        guard existingCount < Self.maximumCount else { throw ImageAttachmentError.limitReached }
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw ImageAttachmentError.unsafeFile }
        guard let size = values.fileSize, (1...Self.maximumBytes).contains(size) else { throw ImageAttachmentError.invalidSize }
        guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil),
              let typeIdentifier = CGImageSourceGetType(imageSource) as String?,
              let type = UTType(typeIdentifier),
              let mime = type.preferredMIMEType,
              ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(mime) else {
            throw ImageAttachmentError.unsupportedFormat
        }
        let directory = rootURL.appendingPathComponent(sessionID.uuidString, isDirectory: true)
        let extensionName = type.preferredFilenameExtension ?? source.pathExtension.lowercased()
        let destination = directory.appendingPathComponent("\(UUID().uuidString).\(extensionName)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            try FileManager.default.copyItem(at: source, to: destination)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        } catch {
            throw ImageAttachmentError.copyFailed
        }
        return .init(fileURL: destination, displayName: source.lastPathComponent, mimeType: mime, byteCount: size)
    }

    func remove(_ attachment: ImageAttachment) {
        guard attachment.fileURL.standardizedFileURL.path.hasPrefix(rootURL.standardizedFileURL.path + "/") else { return }
        try? FileManager.default.removeItem(at: attachment.fileURL)
    }
}
