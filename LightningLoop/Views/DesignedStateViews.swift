import SwiftUI

struct DesignedEmptyState: View {
    let title: String
    let detail: String
    var symbol: String = "arrow.trianglehead.2.clockwise.rotate.90"
    var guidance: String? = nil
    var identifier: String? = nil

    var body: some View {
        SurfaceCard {
            VStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(LoopBrand.mint)
                    .accessibilityHidden(true)
                VStack(spacing: 6) {
                    Text(title).font(.title3.bold())
                    Text(detail)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 520)
                }
                if let guidance {
                    Text(guidance)
                        .font(.callout.weight(.medium))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 480)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(28)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier ?? "designed.empty")
    }
}

struct ProviderStatusBanner: View {
    let model: AppModel

    var body: some View {
        if let readiness = model.loopReadinessMessage {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: model.supportsAutomaticResearch ? "bolt.slash.fill" : "wifi.slash")
                    .foregroundStyle(.orange)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.supportsAutomaticResearch ? DesignedCopy.providerOfflineTitle : DesignedCopy.harnessOfflineTitle)
                        .font(.subheadline.weight(.semibold))
                    Text(readiness)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                SettingsLink {
                    Text("Open Settings")
                }
                .accessibilityIdentifier("open.settings.readiness")
            }
            .padding(12)
            .background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(.orange.opacity(0.22))
            }
            .accessibilityIdentifier("provider.status.banner")
        }
    }
}

struct ProviderIdentityChip: View {
    let model: AppModel

    var body: some View {
        let profile = model.providerProfile
        let ready = model.hasAPIKey
        HStack(spacing: 8) {
            Image(systemName: ready ? "bolt.fill" : "bolt.slash")
                .foregroundStyle(ready ? LoopBrand.gold : .orange)
            VStack(alignment: .leading, spacing: 1) {
                Text(profile.requiresProviderSelection ? "Choose a provider" : profile.displayName)
                    .font(.caption.weight(.semibold))
                if !profile.requiresProviderSelection {
                    Text(profile.modelName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.45), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ready ? "\(profile.displayName), ready" : "\(profile.displayName), not ready")
        .accessibilityIdentifier("provider.identity.chip")
    }
}
