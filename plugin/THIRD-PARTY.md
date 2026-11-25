# Attribution and licenses

## LearnHarness Drawing Pad (adapted source)

The question-reference capture, font embedding, theme recolouring, session sheet
lifetime, submission interception and practice-problem tracking are adapted from the
Drawing Pad core plugin of LearnHarness:

- Repository: https://github.com/amosblomqvist/learnharness
- Path: `plugins/drawing-pad/` (release v0.7.0)
- License: AGPL-3.0-only, the same license as this plugin.

Drawing Pad in turn credits the handwriting contribution at
https://github.com/hrdkj/learnharness (branch `codex/handwriting-contribution`,
commit `48dd022`, AGPL-3.0-only) for its frozen background composition.

## Bundled packages

All MIT licensed unless the copied licence file says otherwise. Each package's
licence is copied to `dist/licenses/` during the build.

- html-to-image 1.11.13 — captures the plugin-owned question reference.
- qrcode-generator 2.0.4 — draws the pairing QR code.
- ws 8.23.0 — WebSocket server for the iPad connection.
- bonjour-service 1.4.4 and its dependencies — announces the plugin on the local network.
