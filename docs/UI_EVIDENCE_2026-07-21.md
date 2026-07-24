# macOS UI evidence — 2026-07-21

This record binds the current screenshots to one locally built Debug app. It is visual product evidence, not a signed-release, provider-entitlement, VoiceOver, or live automation claim.

## Build identity

- Project: `LightningLoop.xcodeproj`
- Scheme/configuration: `LightningLoop` / Debug
- App executable: `.build/DerivedData/Build/Products/Debug/LightningLoop.app/Contents/MacOS/LightningLoop`
- Executable shape: Mach-O 64-bit arm64
- Debug stub SHA-256: `93a28b4b1d5f1f4dae59b26985eafdc9b3a10f38824c549c6f5c7b5bcd729353`
- Debug implementation dylib SHA-256: `8c4836eb16cb31045b3d3332b247b5f71cb4dbc94bb95c21ef05af62f20607e6`

The DEBUG-only capture route creates an isolated `AppModel.live()` with `LIGHTNINGLOOP_UI_TESTING=1`, process-local archive/provider/ledger/attachment paths, and a credential reader that always returns `nil`. It renders the real production views in a fixed dark appearance and writes the `NSHostingView` bitmap directly. Scenario fixtures cannot load user session history, read Keychain, contact a provider, mutate a managed overlay, or prove runtime access. The route is excluded from Release builds by `#if DEBUG`; a final Release-string scan found none of the fixture or launch-receipt environment names.

## Current captures

| Surface | Capture time (America/New_York) | Pixels | SHA-256 | Scope |
|---|---:|---:|---|---|
| [First-run goal and output-mode surface](screenshots/lightningloop-current-new-loop.png) | 2026-07-21 16:55:29 | 2440 × 1640 | `577e46c12f1d0c0f63618a4c745dcc178471d3708fdc4980da08f9b450703232` | Process-isolated blank session; runtime unavailable and setup guidance visible |
| [Working/clarifying surface](screenshots/lightningloop-current-working.png) | 2026-07-21 16:55:31 | 2440 × 1640 | `729ec19890b320aedb6514d65fbd598add60c824e3bdae46e43685cf7d31573d` | Deterministic non-linear progress fixture with cancellation affordance |
| [Blocked loop surface](screenshots/lightningloop-current-blocked-history.png) | 2026-07-21 16:55:32 | 2440 × 1640 | `14dde4b1fb581b75576876e724cc09803ef0f9c43cc3a4edceb23224a2b2b359` | Deterministic paused/model-missing fixture; prior state preserved and retry guidance visible |
| [Provider/model settings](screenshots/lightningloop-current-settings-model.png) | 2026-07-21 16:55:34 | 1400 × 1380 | `4efc70fa06f1ed8e4c96570057f6f300af0072e00b251fd190fcd055bb402f8a` | Credential-free runtime-catalog metadata fixture; does not prove sign-in or entitlement |
| [Update and maintenance settings](screenshots/lightningloop-current-settings-update.png) | 2026-07-21 16:55:35 | 1400 × 1380 | `199559a9332939c9621a7067d437d18ec59a509d695964fd496373724e2d17e8` | Explicit `UNCONFIGURED` channel and source-rebuild guidance; automatic installation remains off |

## Reachable-state audit

- Primary entry: the goal, optional images, setup blocker, primary action, text-only/workspace permission boundary, and four-stage loop overview have distinct hierarchy.
- Provider missing: the app names whether the runtime, provider selection, exact catalog entry, or official provider access is blocking a run instead of reducing every case to “provider setup required.”
- Loading: the clarifying view explains the current duty, avoids a false percentage, and keeps Cancel Run visible.
- Blocked/error: an empty deliverable no longer displays an indefinite spinner after work has stopped. Paused and failed states use explicit symbols, preserved-status copy, Settings recovery, and a gated Try Again action.
- Settings/model: built-in model choices are visibly catalog-owned and include model ID plus image/text capability. Credentials remain delegated to the official runtime flow.
- Permission/output mode: text-only is the safe default; workspace and bounded command execution remain separately disclosed and gated.
- Update surface: the app says automatic updates are off, labels the channel `UNCONFIGURED`, and links to the verified source-rebuild procedure. It does not imply that signed distribution exists.

## Live automation limitation

`./script/build_and_run.sh --verify` separately proves a normal app-bundle launch from the current project build. The final run rejected any exact-path process present before launch, passed a unique token and temporary receipt path through `open`, and accepted only the stable exact executable PID `30506` that wrote the matching receipt. Live XCUITest is not current on this host: Xcode reports `The test runner failed to initialize for UI testing` with underlying error `Authentication canceled. System authentication is running.` The Computer Use bridge also failed to start its native pipe. No accessibility or authentication control was weakened. These built-binary deterministic fixtures therefore supplement—but do not replace—the still-required live keyboard, focus, VoiceOver, and full interaction journey.
