import Foundation

/// Product-facing empty, error, offline, and long-history copy.
/// Kept out of view bodies so XCTest can pin the words without launching SwiftUI.
enum DesignedCopy {
    static let productName = "LightningLoop"
    static let tagline = "Fast models. Strict evidence."
    static let steward = "BarnLabs"

    static let noLoopSelectedTitle = "Start a loop"
    static let noLoopSelectedDetail = "LightningLoop clarifies, challenges, implements, and reviews until Gold — or pauses honestly."
    static let noLoopSelectedGuidance = "⌘N opens a new draft. Settings holds the provider and any LightningLoop-managed key."

    static let emptyLoopsTitle = "No loops yet"
    static let emptyLoopsDetail = "History stays on this Mac. ⌘N starts a draft."

    static let longHistoryFilterLabel = "Filter loops"
    static let longHistoryShowing = "Showing filtered loops"
    static let longHistoryEmptyTitle = "No loops match"
    static let longHistoryEmptyDetail = "Clear the filter to see the full local history."

    static let providerOfflineTitle = "Provider not ready"
    static let harnessOfflineTitle = "Runtime unavailable"
    static let harnessOfflineDetail = "You can draft a goal. Clarification, execution, and Gold stay blocked until the shared LightningLoop runtime is present."

    static let emptyCriteriaTitle = "No acceptance contract yet"
    static let emptyCriteriaDetail = "Criteria appear after clarification. Nothing here is inferred from a model claim."
    static let emptyPlanTitle = "No reviewed plan yet"
    static let emptyPlanDetail = "The plan tab stays empty until a reviewer has challenged a draft."
    static let emptyReviewsTitle = "No reviews yet"
    static let emptyReviewsDetail = "Harsh review records land here. Exhaustion pauses; it never becomes Gold."
    static let emptyTraceTitle = "No handoffs yet"
    static let emptyTraceDetail = "The agent trace fills as each bounded duty completes."

    static let browserEmptyTitle = "Nothing loaded"
    static let browserEmptyDetail = "Open a reviewed 127.0.0.1 Evidence Lab URL or one reputable HTTPS primary source. Everything else is refused."
    static let browserRefusedTitle = "Refused"
    static let browserInvalidURL = "Enter a valid URL."
    static let browserNotReputable = "Refused: not a reputable primary source or reviewed artifact."

    static let unverifiedBytes = "Unverified bytes are never shown."
    static let keyNeverEchoed = "The key is never shown after you save it. It stays in Keychain and never enters provider.json, logs, or a loop."
    static let justFreeLabel = "Just-free mode"
    static let justFreeDetail = "Pin a zero-cost OpenRouter model. A later paid model fails closed. LightningLoop never invents a price."

    static let collapsedTracePrefix = "Show earlier handoffs"
}
