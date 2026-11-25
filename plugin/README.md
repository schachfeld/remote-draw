# Remote Draw plugin

A trusted-local LearnHarness Community plugin. Draw on an iPad with Apple Pencil in the
Remote Draw app; the drawing appears live in LearnHarness and is sent with your next
message or answer. See the [repository README](../README.md) and the
[protocol](../protocol/PROTOCOL.md).

## Use

1. Enable Remote Draw in **Settings → Community plugins**.
2. In **Settings → Remote Draw**, choose **Pair an iPad** and scan the QR code with the
   app. This is needed once per iPad.
3. In a teaching or practice session press **Remote draw** in the top bar
   (Cmd/Ctrl+Shift+R). The iPad shows the current question; draw there.
4. Submit as usual. **Remote draw (unsent)** means a drawing will go with your next
   submission.

Only the iPad draws. On the desktop, drag to move the view and use **Clear** to empty
the sheet on both devices. Sending follows Drawing Pad's rules: in teaching the sheet is
cleared once a submission carrying it was accepted; in practice the board is kept, sent
again only when it changed, and reset when a new problem is posed.

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
