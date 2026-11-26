# Remote Draw plugin

A trusted-local LearnHarness Community plugin. Draw on an iPad with Apple Pencil in the
Remote Draw app; the drawing appears live in LearnHarness and is sent with your next
message or answer. See the [repository README](../README.md) and the
[protocol](../protocol/PROTOCOL.md).

## Use

1. Enable Remote Draw in **Settings → Community plugins**.
2. In **Settings → Remote Draw**, choose **Pair an iPad** and scan the QR code with the
   app. This is needed once per iPad.
3. Open a teaching or practice session. The iPad shows the current question; draw
   there. The pad does not have to be open on the desktop.
4. Submit as usual. **Remote draw (unsent)** means a drawing will go with your next
   submission in this session.
5. To see the drawing on the desktop, press **Remote draw** in the top bar
   (Cmd/Ctrl+Shift+R).

Only the iPad draws. On the desktop, drag to move the view and use **Clear** to empty
the sheet on both devices. Sending follows Drawing Pad's rules: in teaching the sheet is
cleared once a submission carrying it was accepted; in practice the board is kept, sent
again only when it changed, and reset when a new problem is posed.

### Drawing without the pad

While an iPad is connected and no pad is open, the session page in front has a sheet of
its own. A drawing belongs to the session it was made in and is only sent with a
submission there; switching sessions keeps it, and coming back shows it again on the
iPad. A sheet without ink follows the question as it changes; once there is ink, the
question picture on it stays as it was.

Showing the question on the iPad without the pad needs a LearnHarness version with
`ctx.app.currentSession()` (newer than 0.7.0). On older versions the plugin reads the
session from the page address instead and the iPad gets a blank sheet; press
**Remote draw** before drawing if you want the question on it.

Unsent drawings live in the app window's memory. Reloading or restarting LearnHarness
loses them on the desktop.

## Network

The plugin listens on port 47600 (changeable in its settings) on all network interfaces
and announces itself with Bonjour. Connections are authenticated with a key exchanged
through the QR code, but not encrypted. macOS may ask once whether LearnHarness may
accept incoming connections; allow it.

## Development

See the [repository README](../README.md#plugin-development).

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE) and [`THIRD-PARTY.md`](THIRD-PARTY.md).
