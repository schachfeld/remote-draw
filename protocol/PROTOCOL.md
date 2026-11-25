# Remote Draw protocol, version 1

The LearnHarness plugin (the **server**, on the Mac) and the iPad app (the **client**)
talk over one WebSocket connection. This file is the contract both sides build against.
`tools/fake-ipad-lib.mjs` is a second, independent implementation of the client side
and is used by the plugin's tests.

## Roles

- The **iPad** owns drawing and rendering. It runs PencilKit, renders the ink to a
  PNG, and sends that PNG plus PencilKit's saved drawing data after every change.
- The **desktop** shows the PNG, stores the latest PNG and drawing data per sheet,
  builds the image attached to a learner submission, and tells the iPad which sheet
  is open.
- Only one iPad is connected at a time. Several iPads can be paired.

## Transport

| Item | Value |
| --- | --- |
| URL | `ws://<host>:<port>/remote-draw/v1` |
| Default port | `47600` (changeable in the plugin settings) |
| Frames | Text frames, each one JSON object with a string `type` |
| Maximum frame size | 24 MiB |
| Keep-alive | The server sends a WebSocket ping every 15 s and drops a client that has not answered by the next one |
| Encryption | None. The link is authenticated, not encrypted |

Unknown fields in a message are ignored. A message with an unknown `type`, a missing
field or an invalid value is answered with `error` (`bad-message`) and the connection
is closed.

### Encodings

- **Secrets, nonces and proofs**: base64url without padding (`A–Z a–z 0–9 - _`).
- **PNG images and PencilKit drawing data**: standard base64 with padding.
- **Colours**: `#rrggbb`, lowercase or uppercase.
- **Numbers**: finite JSON numbers.

## Discovery

The server announces itself with Bonjour:

| Item | Value |
| --- | --- |
| Service type | `_remotedraw._tcp` |
| Port | the WebSocket port |
| TXT `v` | `1` |
| TXT `id` | the server ID (see pairing) |

The client looks for a service whose TXT `id` equals the server ID it stored at
pairing. If none is found (for example over a tailnet, where Bonjour does not work),
it tries the host addresses stored from the QR code.

## Pairing QR code

The plugin settings show a QR code containing this URI:

```
remotedraw://pair?v=1&id=<serverId>&name=<name>&port=<port>&hosts=<h1>,<h2>&code=<code>
```

| Parameter | Meaning |
| --- | --- |
| `v` | Protocol version, `1` |
| `id` | Server ID, a UUID that stays the same for this plugin installation |
| `name` | The Mac's host name, for display |
| `port` | WebSocket port |
| `hosts` | Comma-separated IPv4 addresses of the Mac at the time the code was made |
| `code` | Pairing code: 32 random bytes, base64url. Valid for 5 minutes, usable once |

All values are percent-encoded as usual for a URI query.

## Handshake

Every connection starts the same way. `\n` below is a single line-feed byte, and
`HMAC(key, text)` is HMAC-SHA256 over the UTF-8 bytes of `text`, encoded as base64url.
Nonces are used in the text exactly as the strings that were sent.

1. Server sends `hello`:

   ```json
   { "type": "hello", "v": 1, "serverId": "<uuid>", "nonce": "<serverNonce>" }
   ```

2. Client answers with **either** `pair` (first time) **or** `auth` (afterwards). It
   has 10 seconds; otherwise the server closes the connection.

### First time: `pair`

```json
{ "type": "pair", "deviceId": "<uuid>", "deviceName": "Study iPad",
  "nonce": "<clientNonce>", "proof": "<proof>" }
```

- `deviceId`: a UUID the app creates once and keeps. 8–64 characters of `A–Z a–z 0–9 -`.
- `deviceName`: 1–64 characters, shown in the plugin settings.
- `nonce`: 16–64 base64url characters, fresh random for every connection.
- `proof` = `HMAC(code, "remote-draw/v1/pair\n" + serverNonce + "\n" + clientNonce + "\n" + deviceId)`
  where `code` is the 32 decoded bytes of the QR pairing code.

Both sides then derive the **device key** (32 raw bytes, not base64):

```
deviceKey = HMAC-SHA256(code, "remote-draw/v1/key\n" + serverNonce + "\n" + clientNonce + "\n" + deviceId)
```

The pairing code itself never travels over the network. The server stores the device
key under `deviceId`; the client stores it together with the server ID, name, port and
hosts. Pairing an already known `deviceId` replaces its key.

Server answers:

```json
{ "type": "paired", "proof": "<serverProof>" }
```

### Afterwards: `auth`

```json
{ "type": "auth", "deviceId": "<uuid>", "nonce": "<clientNonce>", "proof": "<proof>" }
```

- `proof` = `HMAC(deviceKey, "remote-draw/v1/auth\n" + serverNonce + "\n" + clientNonce + "\n" + deviceId)`

Server answers:

```json
{ "type": "ready", "proof": "<serverProof>" }
```

### Server proof

In both `paired` and `ready`:

```
serverProof = HMAC(deviceKey, "remote-draw/v1/server\n" + serverNonce + "\n" + clientNonce + "\n" + deviceId)
```

The client **must** check it and drop the connection if it is wrong; this is what
stops another machine on the network from posing as the Mac.

After `paired` or `ready` the connection is authenticated and the server immediately
sends a `pad` message with the current state.

### Errors and close codes

```json
{ "type": "error", "code": "busy", "message": "Another iPad is connected." }
```

After an `error` the server closes the connection.

| `code` | Close code | Meaning | What the app should do |
| --- | --- | --- | --- |
| `unauthorized` | 4003 | Wrong proof, unknown device, or no valid pairing code | Show "pair again"; do not retry automatically |
| `busy` | 4009 | A different paired iPad is connected | Show "another iPad is connected"; retry later |
| `bad-message` | 4008 | Invalid or unexpected message | Bug; log it, then reconnect |
| `unsupported-version` | 4002 | Reserved for future versions | Ask the user to update |
| – | 4001 | The same device connected again; this older connection is replaced | Nothing |
| – | 4010 | The device was removed in the plugin settings | Forget the pairing; show "pair again" |

On any other close or a network failure the app reconnects with a delay (1 s, 2 s,
4 s, then every 5 s).

## Sheet coordinates

A **sheet** is one drawing surface belonging to one LearnHarness session.

- A sheet is 4000 × 4000 points. The origin is the top-left corner, x grows to the
  right and y grows downwards. This is the PencilKit canvas content size.
- All rectangles and points in messages use these sheet coordinates.
- A rectangle is `{ "x": 0, "y": 0, "width": 0, "height": 0 }`.

## Messages from the server

### `pad`

Full state. Sent after the handshake and whenever the open pad, its sheet, its theme or
its question picture changes.

No pad is open on the desktop:

```json
{ "type": "pad", "open": false }
```

The app shows "Open Remote Draw on the desktop" and accepts no ink. It may keep the
last sheet in memory: if the next open pad has the same sheet ID, the "same sheet ID"
rule below applies and nothing is lost.

A pad is open:

```json
{ "type": "pad", "open": true, "sheet": {
    "id": "k3J9x-2",
    "theme": "dark",
    "backgroundColor": "#1c1c1e",
    "reference": { "x": 1665, "y": 200, "width": 670, "height": 312, "png": "<base64>" },
    "drawing": "<base64>"
} }
```

| Field | Meaning |
| --- | --- |
| `id` | Sheet ID, 1–128 characters of `A–Z a–z 0–9 _ -`. A new ID means a new sheet |
| `theme` | `light` or `dark`: the desktop app theme. The canvas and the rendered ink use this appearance |
| `backgroundColor` | Colour of the sheet behind question picture and ink |
| `reference` | Optional. The question picture and where it sits on the sheet. Read-only under the ink |
| `drawing` | Optional. PencilKit drawing data (`PKDrawing.dataRepresentation()`) the desktop stored for this sheet |

Rules for the app:

- **New sheet ID** (different from the one loaded): replace the canvas. Load `drawing`
  if present, otherwise start empty. Clear the undo history. Scroll so the question
  picture is at the top of the screen, or to the sheet centre if there is none. If a
  `drawing` was loaded, send a fresh `ink`, so the desktop's picture matches the
  current theme.
- **Same sheet ID** as the one loaded: keep the canvas and its undo history and ignore
  `drawing`. Apply the new `theme`, `backgroundColor` and `reference`. If the theme
  changed, render again and send a fresh `ink`.
- **First `pad` after connecting**, same sheet ID as the one loaded: also send a fresh
  `ink`. The last one may have been lost with the previous connection, and the iPad's
  drawing is the one that counts.

### `clear`

```json
{ "type": "clear", "sheet": "k3J9x-2" }
```

Empty the canvas of that sheet and clear its undo history, then answer with an `ink`
message for the now empty drawing (no `image`). That answer is what makes both sides
agree if a stroke was on its way while the desktop cleared. Ignore `clear` if another
sheet is loaded.

## Messages from the client

Both are accepted only while a pad is open, and only for the open sheet. A message for
any other sheet ID is silently ignored, because it may simply have crossed a `pad`
message on the wire.

### `preview`

The stroke that is being drawn right now, for the live line on the desktop.

```json
{ "type": "preview", "sheet": "k3J9x-2", "stroke": 7, "color": "#ffffff", "width": 3,
  "points": [[1700.5, 640.25], [1702, 641]], "end": false, "cancelled": false }
```

| Field | Meaning |
| --- | --- |
| `stroke` | Positive integer. Starts at 1 for each connection and grows by one per stroke |
| `color` | The ink colour as shown on the iPad in the current theme |
| `width` | Line width in points, greater than 0 and at most 100 |
| `points` | 0–512 new points since the last `preview` of this stroke |
| `end` | `true` in the last message of a stroke (finished or cancelled) |
| `cancelled` | Optional, default `false`. `true` together with `end` when the stroke left no ink (for example a palm rejection). The desktop removes its line at once |

A finished stroke's line stays on the desktop until an `ink` message whose `through`
covers it arrives. As a safety net the desktop also removes an ended line after 5
seconds.

Send about 30 messages per second while the Pencil is down. Send nothing for the
eraser, the lasso or the ruler.

### `ink`

The whole drawing after a change: a finished stroke, an erase, an undo or redo, a
lasso move, or a re-render after a theme change.

```json
{ "type": "ink", "sheet": "k3J9x-2", "through": 7, "theme": "dark",
  "drawing": "<base64>",
  "image": { "x": 1690, "y": 630, "width": 420, "height": 180, "png": "<base64>" } }
```

| Field | Meaning |
| --- | --- |
| `through` | The highest `stroke` number whose result is contained in this drawing; 0 if none yet on this connection. The desktop removes the preview lines up to this number |
| `theme` | The theme the PNG was rendered for |
| `drawing` | `PKDrawing.dataRepresentation()` of the whole drawing |
| `image` | The rendered ink and the sheet rectangle it covers. Left out when the drawing is empty |

Image rules:

- The PNG has a transparent background and contains only ink, never the question
  picture or the sheet background.
- `image` covers the drawing's bounds (`PKDrawing.bounds`), with positive width and
  height.
- Render at 2 pixels per point. If that would make a side longer than 4096 pixels,
  lower the scale so the longer side is 4096 pixels.
- Render with the appearance named in `theme`, so PencilKit's automatic black/white
  adaptation matches the desktop.

If changes arrive faster than they can be sent, skip the intermediate ones and send
only the newest.

## Security notes

- The pairing code is 256 random bits, single-use, and expires after 5 minutes.
- A device that does not know a device key cannot connect or inject ink, and a server
  that does not know it cannot pass the server proof.
- Messages after the handshake are neither encrypted nor individually signed. Someone
  able to read the network can see handwriting and question pictures. A tailnet
  connection is encrypted by Tailscale.
