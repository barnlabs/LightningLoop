# LightningLoop Web — two ways to use it

## Option 1: Web (no download — easiest)

A hosted static version runs entirely in your browser. You paste your own
API key, it calls your provider directly. No server, nothing to install.

> **URL:** once merged and GitHub Pages is enabled, the live URL is:
> `https://barnlabs.github.io/LightningLoop/`

To enable Pages on your fork: **Settings → Pages → Source: GitHub Actions.**

The files live in `Harness/web/static/` and deploy automatically via
`.github/workflows/deploy-pages.yml`.

## Option 2: Desktop app (download and run)

Self-contained executables — no Node, no terminal, no install.

1. Download the file for your platform from the [Releases page](https://github.com/barnlabs/LightningLoop/releases):
   - **Windows**: `lightningloop-windows-x64.exe` — double-click to run
   - **macOS** (Apple Silicon): `lightningloop-darwin-arm64` — `chmod +x` then run it
2. Your browser opens automatically to `http://localhost:7777`
3. Enter **your own** API key in Settings — it stays in your browser only

Releases are built automatically from tags (`v*`) via
`.github/workflows/release.yml` using Bun's `--compile`.

## Your own key, always

Both options require you to bring your own API key. It's stored in your
browser's localStorage and sent directly to your provider — it never
touches any server you don't control. There are no built-in defaults.

## Option 3: Run from source / self-host

See the [web README](./README.md) for local development and the one-click
Render deploy button.

---

See [`REDESIGN.md`](./REDESIGN.md) for the 4-stroke architecture.
