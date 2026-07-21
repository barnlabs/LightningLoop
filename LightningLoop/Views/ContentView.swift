import SwiftUI

struct ContentView: View {
    let model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView(model: model)
                .navigationSplitViewColumnWidth(min: 250, ideal: 282, max: 340)
        } detail: {
            if let session = model.selectedSession {
                SessionDetailView(model: model, session: session)
                    .id(session.id)
            } else {
                ContentUnavailableView("No loop selected", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .help("LightningLoop Settings")
            }
        }
    }
}
