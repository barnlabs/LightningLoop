import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !ProcessInfo.processInfo.isUnitTestHost else { return }
#if DEBUG
        writeLaunchVerificationReceiptIfRequested()
#endif
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

#if DEBUG
    private func writeLaunchVerificationReceiptIfRequested() {
        let environment = ProcessInfo.processInfo.environment
        guard let token = environment["LIGHTNINGLOOP_LAUNCH_VERIFY_TOKEN"],
              token.range(of: #"\A[A-Fa-f0-9-]{36}\z"#, options: .regularExpression) != nil,
              let rawPath = environment["LIGHTNINGLOOP_LAUNCH_VERIFY_RECEIPT"] else { return }
        let receiptURL = URL(fileURLWithPath: rawPath).standardizedFileURL
        let temporaryDirectory = FileManager.default.temporaryDirectory.standardizedFileURL
        guard receiptURL.deletingLastPathComponent() == temporaryDirectory,
              receiptURL.lastPathComponent.hasPrefix("lightningloop-launch-receipt.") else { return }
        let receipt = "\(ProcessInfo.processInfo.processIdentifier)\n\(token)\n"
        try? Data(receipt.utf8).write(to: receiptURL, options: .atomic)
    }
#endif
}

@main
struct LightningLoopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.isUnitTestHost {
                Color.clear.frame(width: 1, height: 1)
            } else if ProcessInfo.processInfo.isUIFixtureSettings {
                SettingsView(model: model)
                    .accessibilityIdentifier("lightningloop.settings.fixture")
                    .fixtureCaptureIfRequested()
            } else {
                ContentView(model: model)
                    .accessibilityIdentifier("lightningloop.root")
                    .frame(minWidth: 980, minHeight: 680)
                    .fixtureCaptureIfRequested()
            }
        }
        .defaultSize(width: 1220, height: 820)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Loop") { model.newSession() }
                    .keyboardShortcut("n")
            }
            CommandMenu("Loop") {
                Button("Ask Clarifying Questions") { model.startClarification() }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(model.isRunning || model.selectedSession?.stage != .draft)
                Button("Cancel Current Run") { model.cancelCurrentOperation() }
                    .keyboardShortcut(".", modifiers: [.command])
                    .disabled(!model.isRunning)
            }
        }

        Settings {
            SettingsView(model: model)
        }
    }
}

private extension View {
    @ViewBuilder
    func fixtureCaptureIfRequested() -> some View {
#if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["LIGHTNINGLOOP_UI_TESTING"] == "1",
           let rawCapturePath = environment["LIGHTNINGLOOP_UI_CAPTURE_PATH"] {
            let captureURL = URL(fileURLWithPath: rawCapturePath).standardizedFileURL
            let temporaryDirectory = FileManager.default.temporaryDirectory.standardizedFileURL
            if captureURL.deletingLastPathComponent() == temporaryDirectory,
               captureURL.lastPathComponent.hasPrefix("lightningloop-ui-capture.") {
                self.background(
                    FixtureWindowCaptureProbe(captureURL: captureURL)
                        .frame(width: 1, height: 1)
                )
            } else {
                self
            }
        } else {
            self
        }
#else
        self
#endif
    }
}

#if DEBUG
private struct FixtureWindowCaptureProbe: NSViewRepresentable {
    let captureURL: URL

    func makeNSView(context: Context) -> FixtureWindowCaptureView {
        FixtureWindowCaptureView(captureURL: captureURL)
    }

    func updateNSView(_ nsView: FixtureWindowCaptureView, context: Context) {}
}

private final class FixtureWindowCaptureView: NSView {
    private let captureURL: URL
    private var captureScheduled = false

    init(captureURL: URL) {
        self.captureURL = captureURL
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard !captureScheduled, let window else { return }
        captureScheduled = true
        let scenario = ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_SCENARIO"]
        let size = scenario?.hasPrefix("settings-") == true
            ? CGSize(width: 700, height: 740)
            : CGSize(width: 1220, height: 820)
        window.appearance = NSAppearance(named: .darkAqua)
        window.setContentSize(size)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self, weak window] in
            guard let self, let window, let view = window.contentView else { return }
            window.setContentSize(size)
            view.wantsLayer = true
            view.layer?.backgroundColor = NSColor.underPageBackgroundColor.cgColor
            view.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self, weak window] in
                guard let self, let window, let contentView = window.contentView else { return }
                contentView.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                guard let bitmap = contentView.bitmapImageRepForCachingDisplay(in: contentView.bounds) else { return }
                contentView.cacheDisplay(in: contentView.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: self.captureURL, options: .atomic)
            }
        }
    }
}
#endif

private extension ProcessInfo {
    var isUnitTestHost: Bool {
        environment["XCTestConfigurationFilePath"] != nil
            && environment["LIGHTNINGLOOP_UI_TESTING"] != "1"
    }

    var isUIFixtureSettings: Bool {
#if DEBUG
        environment["LIGHTNINGLOOP_UI_TESTING"] == "1"
            && environment["LIGHTNINGLOOP_UI_SCENARIO"]?.hasPrefix("settings-") == true
#else
        false
#endif
    }
}
