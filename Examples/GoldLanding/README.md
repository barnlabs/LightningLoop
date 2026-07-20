# Gold Landing example

Audience: developers and product builders evaluating LightningLoop. Job: explain the speed-plus-review thesis, show the strict loop, and ground the claim in a real generated artifact. Medium: dependency-free static HTML/CSS. Invariants: BarnLabs identity, prominent non-affiliation notice, no invented performance numbers, no external assets, keyboard-visible focus, reduced-motion support, and useful layouts from 320px through wide desktop.

Serve the `Examples` directory with any local static server and open `/GoldLanding/`.

Fresh browser proof from 2026-07-19 used isolated headless Chrome device metrics at true 375 × 900 and 1280 × 1000 CSS pixels. At both widths, `documentElement.scrollWidth` equaled the viewport width and the load logs contained no console, resource, or network failure. The page has no scripts or external assets, exposes a skip link and visible focus style, and disables animation under reduced-motion preference.

- [375 px proof](../../docs/screenshots/lightningloop-landing-375.png)
- [1280 px proof](../../docs/screenshots/lightningloop-landing-1280.png)
