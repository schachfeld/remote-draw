# Remote Draw

Draw on an iPad with Apple Pencil and have the drawing appear live in LearnHarness,
where it is sent along with your next message or answer.

| Folder | What it is |
| --- | --- |
| [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) | The messages the plugin and the iPad app exchange. Both sides build against it. |
| [`plugin/`](plugin/) | The LearnHarness plugin (TypeScript). |
| [`tools/`](tools/) | `fake-ipad.mjs` plays the iPad, for testing the plugin without one. |
| [`ios/`](ios/) | The iPad app (Swift, PencilKit). |

## Status

1. **Done:** protocol, the plugin's background service (WebSocket server, Bonjour,
   pairing, relay to app windows), the fake iPad, tests.
2. **Done:** the plugin's window part: the pad, the pairing QR code and settings.
   Checked in a real LearnHarness instance against the fake iPad.
3. **Done:** the iPad app. Checked in the iPad simulator against the plugin's
   background service. See [`ios/README.md`](ios/README.md).
4. **Next:** first run on a real iPad with Apple Pencil against LearnHarness.
5. USB connection.

## Installing the plugin into LearnHarness

Build it, then copy `plugin/dist/` to `<plugins directory>/remote-draw/dist/`. The
plugins directory is shown in LearnHarness under **Settings → Community plugins**.
Refresh the list there, enable Remote Draw, and restart LearnHarness after later
updates. See [`plugin/README.md`](plugin/README.md) for use.

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

In **Settings → Remote Draw** choose **Pair an iPad**, copy the `remotedraw://pair?...`
text shown next to the QR code and run, from the repository root:

```sh
node tools/fake-ipad.mjs pair 'remotedraw://pair?...'
node tools/fake-ipad.mjs run
```

`run` draws a few squiggles whenever a pad opens on the desktop.

## Trying the iPad app without LearnHarness

`plugin/scripts/dev-desktop.ts` runs the plugin's background service on its own and
plays the app window. It needs `npm install` in `plugin/`, but no LearnHarness:

```sh
cd plugin
npx tsx scripts/dev-desktop.ts
```

Type `pair` for a pairing link and `open` to open a pad. See
[`ios/README.md`](ios/README.md#tests).
