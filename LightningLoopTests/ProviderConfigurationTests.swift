import AppKit
import XCTest
@testable import LightningLoop

final class ProviderConfigurationTests: XCTestCase {
    func testCustomProviderRequiresCredentialFreeHTTPSAndBoundedLimits() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ProviderConfigurationStore(fileURL: root.appendingPathComponent("provider.json"))
        var profile = ProviderConfiguration.preset(.custom)
        profile.id = "fast-lab"
        profile.displayName = "Fast Lab"
        profile.baseURL = "https://inference.example.com/openai/v1/"
        profile.modelID = "lab/model-1"
        profile.modelName = "Lab Model"
        try store.save(profile)
        let loaded = store.load()
        XCTAssertEqual(loaded.id, "fast-lab")
        XCTAssertEqual(loaded.baseURL, "https://inference.example.com/openai/v1")
        XCTAssertEqual(loaded.credentialService, "com.barnlabs.LightningLoop.provider.custom.fast-lab.inference.example.com.apiKey")

        profile.baseURL = "https://secret@example.com/v1"
        XCTAssertThrowsError(try store.save(profile)) { XCTAssertEqual($0 as? ProviderConfigurationError, .unsafeURL) }
        profile.baseURL = "http://example.com/v1"
        XCTAssertThrowsError(try store.save(profile)) { XCTAssertEqual($0 as? ProviderConfigurationError, .unsafeURL) }
        profile.baseURL = "https://localhost/v1"
        XCTAssertThrowsError(try store.save(profile)) { XCTAssertEqual($0 as? ProviderConfigurationError, .unsafeURL) }
        profile.baseURL = "https://127.0.0.1/v1"
        XCTAssertThrowsError(try store.save(profile)) { XCTAssertEqual($0 as? ProviderConfigurationError, .unsafeURL) }
    }

    func testPresetEndpointCannotBeRedirectedThroughConfiguration() {
        let store = ProviderConfigurationStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        var profile = ProviderConfiguration.preset(.groq)
        profile.baseURL = "https://example.com/v1"
        XCTAssertThrowsError(try store.save(profile)) { XCTAssertEqual($0 as? ProviderConfigurationError, .wrongPresetURL) }
    }

    func testMissingProviderConfigurationRequiresExplicitSelection() {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("provider.json")
        let store = ProviderConfigurationStore(fileURL: fileURL)

        let onboarding = store.load()
        XCTAssertTrue(onboarding.requiresProviderSelection)
        XCTAssertEqual(onboarding.preset, .selectionRequired)
        XCTAssertEqual(onboarding.displayName, "Choose a provider")
        XCTAssertThrowsError(try store.loadValidated()) {
            XCTAssertEqual($0 as? ProviderConfigurationError, .providerSelectionRequired)
        }
    }

    func testOpenAICodexPresetUsesSharedMaximumOutputLimit() {
        let profile = ProviderConfiguration.preset(.openaiCodex)
        XCTAssertEqual(profile.maxOutputTokens, 131_072)
    }

    func testImageImportCopiesARealImageAndEnforcesTheRoundBound() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source.png")
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: 2,
            pixelsHigh: 2,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: source)
        let store = ImageAttachmentStore(rootURL: root.appendingPathComponent("attachments", isDirectory: true))
        let attachment = try store.importImage(from: source, sessionID: UUID(), existingCount: 0)
        XCTAssertEqual(attachment.mimeType, "image/png")
        XCTAssertTrue(FileManager.default.fileExists(atPath: attachment.fileURL.path))
        XCTAssertThrowsError(try store.importImage(from: source, sessionID: UUID(), existingCount: 4)) {
            XCTAssertEqual($0 as? ImageAttachmentError, .limitReached)
        }
    }
}
