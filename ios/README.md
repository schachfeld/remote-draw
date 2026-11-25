# Remote Draw iPad app

A native iPad app (Swift, PencilKit) that pairs with the Remote Draw LearnHarness
plugin and is the only place where ink is drawn. The desktop shows a picture of the
ink and attaches it to the learner's next submission.

Everything the app sends and receives is specified in
[`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md).

## Layout

| Path | What it is |
| --- | --- |
| `RemoteDraw.xcodeproj` | The app project. Open this in Xcode. iPadOS 17 or newer |
| `RemoteDraw/` | The app: screens, the PencilKit canvas, the Keychain store |
| `RemoteDrawKit/` | A Swift package with everything about the connection that needs no UIKit: pairing code, handshake, messages, WebSocket, Bonjour lookup, reconnecting. Tested on the Mac |
| `Info.plist` | The keys Xcode cannot generate: the Bonjour service and the `remotedraw://` link |

| File in `RemoteDraw/` | Role |
| --- | --- |
| `AppModel.swift` | Pairing state, connection state, whether a pad is open |
| `CanvasViewController.swift` | The sheet. Applies `pad` and `clear`, sends `preview` and `ink` |
| `InkRenderer.swift` | `PKDrawing` to the transparent PNG the desktop shows |
| `StrokeObserver.swift` | Watches Pencil touches for the live preview without taking them from PencilKit |
| `PairingScreen.swift` | QR scanner and the field for a pasted pairing link |
| `PadScreen.swift` | The canvas plus the notices ("Open Remote Draw on the desktop", "Looking for …") |
| `PairingStore.swift` | The pairing (with the device key) in the Keychain |

## Running it on an iPad

1. Open `RemoteDraw.xcodeproj`. Signing is automatic. Choose your own team in Xcode. The app uses
   bundle ID `io.github.schachfeld.remotedraw`.
2. Select the iPad as the run destination and press Run.
3. Install and enable the plugin in LearnHarness (see the repository README).
4. In LearnHarness, **Settings → Remote Draw → Pair an iPad**, and scan the code in the
   app. The iPad asks for camera and local-network access; allow both.
5. Open a teaching session, press **Remote draw**, and draw on the iPad.

The pairing link can also be pasted as text on the pairing screen, and scanning the QR
code with the Camera app opens Remote Draw through the `remotedraw://` link.

## How it behaves

- **Pencil draws, fingers pan and pinch-zoom.** The sheet is 4000 × 4000 points and the
  question picture lies read-only under the ink.
- **No pad open or no connection:** a notice covers the sheet and no ink is accepted.
  The sheet is kept, so the same sheet coming back loses nothing.
- **Finding the Mac:** Bonjour first (two seconds), then the addresses from the QR code,
  the one that worked last first. This is what makes a tailnet work.
- **Reconnecting:** after 1 s, 2 s, 4 s, then every 5 s, and at once when the app comes
  to the front. A dead link is noticed within about 20 seconds through WebSocket pings.
- **Theme:** canvas, tool picker and rendered ink use the desktop theme from `pad`, not
  the iPad's own appearance.
- **Ink pictures** are rendered off the main thread, one at a time, always from the
  newest drawing.
- **The screen stays awake** while a pad is open.
- **Forget** in the menu at the top left removes the pairing on the iPad only. Remove
  the device in the plugin settings as well.

The transport is behind the `Transport` protocol in `RemoteDrawKit`, so a USB link can
be added as a second implementation without touching the rest.

## Tests

```sh
cd ios/RemoteDrawKit
swift test
```

The unit tests run the connection logic against a scripted desktop and check the
handshake proofs against values computed with Node, as the plugin does.

`LiveTests` talks to the real plugin service over the network and is skipped unless a
pairing link is given. `plugin/scripts/dev-desktop.ts` runs that service without
LearnHarness and plays the app window:

```sh
cd plugin
npx tsx scripts/dev-desktop.ts          # port 47610; then type: open, pair
# in a second terminal
cd ios/RemoteDrawKit
REMOTE_DRAW_PAIRING_URI='remotedraw://pair?…' swift test --filter LiveTests
```

The same script is the quickest way to try the app itself: type `pair`, give the app
the printed link, then `open`, `theme light`, `clear`, `new` or `close`. It logs every
preview and saves every received ink picture.

## TestFlight

Needs an app record for `io.github.schachfeld.remotedraw` in App Store Connect and an
App Store Connect API key in `~/.appstoreconnect/private_keys/`. Raise
`CURRENT_PROJECT_VERSION` for every upload.

```sh
cd ios
auth=(-allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<key ID>.p8 \
      -authenticationKeyID <key ID> -authenticationKeyIssuerID <issuer ID>)
xcodebuild -project RemoteDraw.xcodeproj -scheme RemoteDraw -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/tf/RemoteDraw.xcarchive "${auth[@]}" archive
xcodebuild -exportArchive -archivePath build/tf/RemoteDraw.xcarchive -exportPath build/tf/export \
  -exportOptionsPlist ExportOptions.plist "${auth[@]}"
xcrun altool --upload-app -t ios -f build/tf/export/RemoteDraw.ipa --apiKey <key ID> --apiIssuer <issuer ID>
```

## Simulator

The simulator has no Pencil and no camera, so there a finger (the mouse) draws and the
pairing link has to be pasted. On a real iPad only the Pencil draws.

## Not verified yet

Checked in the simulator against the real plugin service: pairing, reconnecting with
the stored key, the question picture, drawing with live preview, light and dark
rendering, clear, close and reopen, restoring a stored drawing, and a lost connection.

Still open, because they need the real iPad:

- Apple Pencil input: the live preview while PencilKit draws, palm rejection, and
  that fingers only pan.
- The QR scanner.
- Bonjour discovery and the local-network prompt on the iPad, and the macOS firewall
  prompt when LearnHarness opens its port.
- The whole path through LearnHarness itself; so far the plugin's window part has only
  met the fake iPad, and this app only the stand-in desktop.

