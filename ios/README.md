# Remote Draw iPad app

Not written yet. This file is the brief for building it on a Mac.

## What it is

A native iPad app (Swift, PencilKit) that pairs with the Remote Draw LearnHarness
plugin and is the only place where ink is drawn. The desktop shows a picture of the
ink and attaches it to the learner's next submission.

Everything the app sends and receives is specified in
[`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md). Build against that file, not
against the plugin source. [`../tools/fake-ipad-lib.mjs`](../tools/fake-ipad-lib.mjs)
is a small working client (handshake, pairing, previews, ink) to compare against.

## Decisions already made

| Topic | Decision |
| --- | --- |
| Canvas | `PKCanvasView` with the full `PKToolPicker` (all Apple tools and colours) |
| Input | Pencil draws (`drawingPolicy = .pencilOnly`); fingers pan and pinch-zoom |
| Sheet | 4000 × 4000 points; the question picture is read-only under the ink |
| Ownership | The iPad draws and renders. After every change it sends a PNG of the ink plus `PKDrawing.dataRepresentation()`; the desktop stores both and sends the drawing data back when the sheet is opened again |
| Live preview | While the Pencil is down, send the touch points (about 30 messages per second) so the desktop can show a simple line |
| Theme | The canvas appearance follows the desktop theme sent in `pad`; PencilKit's black/white adaptation must match it |
| No pad open | Show "Open Remote Draw on the desktop" and accept no ink |
| Pairing | Scan the QR code from the plugin settings once; store the device key in the Keychain; reconnect automatically afterwards |
| Finding the Mac | Bonjour (`_remotedraw._tcp`, TXT `id` = server ID), falling back to the host addresses from the QR code (needed over a tailnet) |
| Devices | Several iPads can be paired, one connected at a time; handle the `busy` error |
| Connection | Wi-Fi or tailnet, authenticated but not encrypted. USB comes later; keep the transport behind one small interface so it can be added |
| Minimum OS | iPadOS 17 |
| Signing | Paid Apple developer account |

## App behaviour not covered by the protocol

- Info.plist needs `NSCameraUsageDescription` (QR scan), `NSLocalNetworkUsageDescription`
  and `NSBonjourServices` = `_remotedraw._tcp`.
- The connection is plain `ws://`; App Transport Security must allow it for local
  network and tailnet addresses.
- Keep the screen awake while a pad is open.
- When a new sheet opens, scroll so the question picture is at the top of the screen.

## Trying it against the desktop

1. Install and enable the plugin in LearnHarness (see the repository README).
2. **Settings → Remote Draw → Pair an iPad**, scan the code.
3. Open a teaching session, press **Remote draw**, and draw on the iPad.

## Not verified yet

The plugin was developed on Linux against the fake iPad only. First contact with real
hardware should check: Bonjour discovery from the iPad, the macOS firewall prompt when
the plugin opens its port, and PencilKit's rendering in light and dark themes.
