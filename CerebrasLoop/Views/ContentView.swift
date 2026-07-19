import SwiftUI

struct ContentView: View {
    let model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView(model: model)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            if let session = model.selectedSession {
                SessionDetailView(model: model, session: session)
                    .id(session.id)
            } else {
                ContentUnavailableView("No loop selected", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let stage = model.selectedSession?.stage {
                    StatusPill(stage: stage)
                }
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .help("CerebrasLoop Settings")
            }
        }
    }
}
