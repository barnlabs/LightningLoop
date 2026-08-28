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
                VStack(spacing: 22) {
                    LoopLogo(size: 72)
                    DesignedEmptyState(
                        title: DesignedCopy.noLoopSelectedTitle,
                        detail: DesignedCopy.noLoopSelectedDetail,
                        guidance: DesignedCopy.noLoopSelectedGuidance,
                        identifier: "no.loop.selected"
                    )
                    .frame(maxWidth: 640)
                }
                .padding(36)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                ProviderIdentityChip(model: model)
            }
            ToolbarItem(placement: .primaryAction) {
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .help("LightningLoop Settings")
                .accessibilityIdentifier("toolbar.settings")
            }
        }
    }
}
