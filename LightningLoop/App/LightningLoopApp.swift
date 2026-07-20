import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !ProcessInfo.processInfo.isUnitTestHost else { return }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
#if DEBUG
        if ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_TESTING"] == "1",
           let capturePath = ProcessInfo.processInfo.environment["LIGHTNINGLOOP_UI_CAPTURE_PATH"] {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }),
                      let view = window.contentView,
                      let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: capturePath), options: .atomic)
            }
        }
#endif
    }
}

@main
struct LightningLoopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.isUnitTestHost {
                Color.clear.frame(width: 1, height: 1)
            } else {
                ContentView(model: model)
                    .accessibilityIdentifier("lightningloop.root")
                    .frame(minWidth: 980, minHeight: 680)
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

private extension ProcessInfo {
    var isUnitTestHost: Bool {
        environment["XCTestConfigurationFilePath"] != nil
            && environment["LIGHTNINGLOOP_UI_TESTING"] != "1"
    }
}
