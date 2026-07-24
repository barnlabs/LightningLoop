# LightningLoop brand guide

LightningLoop is BarnLabs’ open-source product for disciplined agent work. The product should feel precise, calm, and evidence-led—not provider-led, speculative, or loud.

## Name and hierarchy

| Element | Approved treatment |
|---|---|
| Product | **LightningLoop** — one word, title case. Lead with it in headings, app chrome, repository copy, and release notes. |
| Steward | **BarnLabs** — the open-source project steward. Use the supplied symbol/wordmark as a distinct secondary signature. |
| Tagline | **Fast models. Strict evidence.** |
| Short description | **A BarnLabs app for disciplined, evidence-led agent work on macOS and the terminal.** |

Use the product name before the steward: “LightningLoop is a BarnLabs open-source project,” not the reverse. Keep provider and runtime names in technical attribution, compatibility, dependency, or notice copy. They are neither the product identity nor a claim of sponsorship.

Do not invent contact details, social accounts, locations, customers, performance guarantees, release availability, or provider endorsements.

## Visual system

The existing artwork is canonical for this repository. Do not regenerate, redraw, crop, or raster-edit it without an explicitly approved art direction and an image-editing review.

| Asset | Location | Use |
|---|---|---|
| LightningLoop icon | `LightningLoop/Resources/AppIconMaster.png` | Repository README and source icon master. The supplied 1254 × 1254 PNG is the reference. |
| macOS app icon set | `LightningLoop/Resources/Assets.xcassets/AppIcon.appiconset/` | App packaging only; retain every checked-in size. |
| BarnLabs symbol | `LightningLoop/Resources/Assets.xcassets/BarnLabsSymbol.imageset/barnlabs-symbol.svg` | Secondary BarnLabs signature in app chrome; preserve its vector/template treatment. |

The icon’s loop/bolt form belongs to LightningLoop. The BarnLabs mark remains separate: do not fuse the marks, imply a new corporate logo, or use the BarnLabs symbol as a substitute app icon.

## Color and accessibility

| Role | Light appearance | Dark appearance | Approved use |
|---|---:|---:|---|
| Ink | `#062A24` | — | Primary text and dense information on paper. |
| Forest | `#0A1F1A` | `#0A1F1A` | Dark surface and light-appearance interactive accent. |
| Mint | — | `#2DD4AA` | Dark-surface interactive accent, highlights, and the BarnLabs signature. |
| Signal gold | `#77580A` | `#F5C843` | Completion/review signal; never the sole carrier of status. |
| Paper | `#F6F3EA` | — | Warm light surface/reference material. |

`AccentColor` and `SignalGold` resolve by appearance in the asset catalog. That intentionally uses forest and accessible gold for light surfaces, and the existing mint and gold on forest surfaces. The measured normal-text contrast pairs are: ink/paper **13.87:1**, forest/paper **15.47:1**, accessible-gold/paper **5.94:1**, mint/forest **9.08:1**, and gold/forest **10.81:1**.

Never communicate stage, success, failure, or ownership with color alone. Pair color with a plain-language label and, where appropriate, an icon. Keep body copy on system foreground colors or the contrast-safe roles above; reserve bright mint and gold for dark surfaces, indicators, and larger graphical elements.

## Product and repository writing

- Start with the user job and the evidence boundary: clarify, challenge, gather proof, and pause rather than pretend certainty.
- Use direct sentence-case labels: “New Loop,” “Ask Clarifying Questions,” and “Open Settings.”
- Keep security and privacy boundaries plain: never request keys, private prompts, personal files, runtime state, or public exploit details in GitHub templates.
- State current release limits exactly. Source builds are available; a signed/notarized public binary release is not.
- Keep the README product-first. Its final technical-attribution section may name the pinned runtime dependency and must link to `NOTICE.md`; do not turn the opening, headings, or badges into runtime/provider marketing.

## Proposed GitHub presentation

The following is a recommended, **not applied**, public-repository presentation. It is intentionally limited to facts supported by this repository and does not add a homepage, social link, contact address, or release claim.

| Field | Proposed value |
|---|---|
| Repository description | `LightningLoop is a BarnLabs app for disciplined, evidence-led agent work on macOS and the terminal.` |
| Topics | `macos`, `swiftui`, `cli`, `developer-tools`, `agent-orchestration` |
| Homepage | Leave unset until an official product URL is verified and approved. |

See [the GitHub review packet](GITHUB_REVIEW_2026-07-20.md) for the observed settings, proposed remote commands, ownership gates, and rollback boundary.
