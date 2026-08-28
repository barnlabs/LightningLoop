import Foundation

/// What the Evidence Lab may attempt to display after hash verification.
/// Classification is extension-only and never a claim that bytes are trusted.
enum ArtifactViewerKind: Equatable, Sendable {
    case image
    case sceneKitModel
    case glbOrGltf
    case none
}

enum ArtifactViewerPolicy {
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]
    static let sceneKitExtensions: Set<String> = ["obj", "usdz", "scn", "dae"]
    static let glbExtensions: Set<String> = ["glb", "gltf"]

    static func kind(forRelativePath path: String) -> ArtifactViewerKind {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        if imageExtensions.contains(ext) { return .image }
        if sceneKitExtensions.contains(ext) { return .sceneKitModel }
        if glbExtensions.contains(ext) { return .glbOrGltf }
        return .none
    }

    /// Viewers receive bytes only when the current workspace file still matches
    /// the reviewed evidence hash. Any other state is a refusal, not a preview.
    static func canRender(_ state: ArtifactCurrentEvidenceState) -> Bool {
        state == .verified
    }

    static func refusal(for state: ArtifactCurrentEvidenceState) -> String {
        switch state {
        case .verified: "Current bytes match the reviewed evidence."
        case .failed: "The persisted verification failed. Bytes are withheld."
        case .unavailable: "The reviewed evidence file is missing. Bytes are withheld."
        case .tampered: "Current bytes differ from the reviewed hash. Bytes are withheld."
        case .unreadable: "Bytes match the hash but cannot be decoded. Nothing is rendered."
        }
    }
}
