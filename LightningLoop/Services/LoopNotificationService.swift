import Foundation
import UserNotifications

enum LoopNotificationService {
    static let preferenceKey = "loopNotificationsEnabled"

    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) == true
    }

    static func send(title: String, body: String) async {
        guard UserDefaults.standard.bool(forKey: preferenceKey) else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = String(title.prefix(80))
        content.body = String(body.prefix(300))
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
