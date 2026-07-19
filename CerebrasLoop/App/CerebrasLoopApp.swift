import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !ProcessInfo.processInfo.isRunningTests else { return }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}

@main
struct CerebrasLoopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.isRunningTests {
                Color.clear.frame(width: 1, height: 1)
            } else {
                ContentView(model: model)
                    .frame(minWidth: 980, minHeight: 680)
            }
        }
        .defaultSize(width: 1220, height: 820)
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
    var isRunningTests: Bool {
        environment["XCTestConfigurationFilePath"] != nil
    }
}
