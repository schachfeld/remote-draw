# Remote Draw

Draw on an iPad with Apple Pencil and have the drawing appear live in LearnHarness,
where it is sent along with your next message or answer.

| Folder | What it is |
| --- | --- |
| [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) | The messages the plugin and the iPad app exchange. Both sides build against it. |
| [`plugin/`](plugin/) | The LearnHarness plugin (TypeScript). |
| [`tools/`](tools/) | `fake-ipad.mjs` plays the iPad, for testing the plugin without one. |
| [`ios/`](ios/) | The iPad app (Swift, PencilKit). Not written yet. |

## Status

1. **Done:** protocol, the plugin's background service (WebSocket server, Bonjour,
   pairing, relay to app windows), the fake iPad, tests.
2. **Next:** the plugin's window part (the pad, QR code and settings in LearnHarness).
3. The iPad app.
4. USB connection.

Until step 2 is built the plugin has no button or settings in LearnHarness.

## Plugin development

Needs Node 22 or newer and a LearnHarness source checkout for the API types.

```sh
cd plugin
npm run sdk -- /path/to/learnharness   # default: ~/projects/learnharness
npm install
npm run typecheck
npm test
npm run build                          # writes plugin/dist/
```

## Trying the connection without an iPad

With the plugin running and a pairing QR code open, copy the code's
`remotedraw://pair?...` text and run, from the repository root:

```sh
node tools/fake-ipad.mjs pair 'remotedraw://pair?...'
node tools/fake-ipad.mjs run
```

`run` draws a few squiggles whenever a pad opens on the desktop.
