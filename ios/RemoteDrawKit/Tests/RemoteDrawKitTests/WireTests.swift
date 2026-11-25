import XCTest
@testable import RemoteDrawKit

final class WireTests: XCTestCase {
    func testParsesThePairingURI() throws {
        let code = Base64URL.encode(Data(repeating: 7, count: 32))
        // The plugin builds the query with URLSearchParams: commas become %2C and spaces "+".
        let invite = try PairingInvite(uri: "remotedraw://pair?v=1&id=0b9d2c1e-aaaa&name=Study+Mac%21&port=47600&hosts=192.0.2.10%2C100.64.0.7&code=\(code)\n")
        XCTAssertEqual(invite, PairingInvite(serverId: "0b9d2c1e-aaaa", name: "Study Mac!", port: 47600,
                                             hosts: ["192.0.2.10", "100.64.0.7"], code: Data(repeating: 7, count: 32)))
    }

    func testRejectsOtherAndDamagedCodes() {
        let code = Base64URL.encode(Data(repeating: 7, count: 32))
        XCTAssertThrowsError(try PairingInvite(uri: "https://example.com")) { XCTAssertEqual($0 as? PairingInvite.ParseError, .notRemoteDraw) }
        XCTAssertThrowsError(try PairingInvite(uri: "remotedraw://pair?v=2&id=a&name=b&port=1&code=\(code)")) {
            XCTAssertEqual($0 as? PairingInvite.ParseError, .unsupportedVersion)
        }
        XCTAssertThrowsError(try PairingInvite(uri: "remotedraw://pair?v=1&name=b&port=1&code=\(code)")) {
            XCTAssertEqual($0 as? PairingInvite.ParseError, .missing("id"))
        }
        XCTAssertThrowsError(try PairingInvite(uri: "remotedraw://pair?v=1&id=a&name=b&port=1&code=abc")) {
            XCTAssertEqual($0 as? PairingInvite.ParseError, .invalid("code"))
        }
        XCTAssertThrowsError(try PairingInvite(uri: "remotedraw://pair?v=1&id=a&name=b&port=99999&code=\(code)")) {
            XCTAssertEqual($0 as? PairingInvite.ParseError, .invalid("port"))
        }
    }

    /// Expected values computed with Node's `createHmac`, as the plugin does.
    func testProofsMatchThePlugin() {
        let code = Data(repeating: 7, count: 32)
        let serverNonce = "serverNonce_0123456789", clientNonce = "clientNonce_0123456789", deviceId = "0b9d2c1e-aaaa-bbbb-cccc-1234567890ab"
        func proof(_ key: Data, _ purpose: Handshake.Purpose) -> String {
            Handshake.proof(key: key, purpose: purpose, serverNonce: serverNonce, clientNonce: clientNonce, deviceId: deviceId)
        }
        let key = Handshake.mac(key: code, purpose: .key, serverNonce: serverNonce, clientNonce: clientNonce, deviceId: deviceId)
        XCTAssertEqual(proof(code, .pair), "6o9RHOS7WsQwQJwPykyxpb9CE4MUDCUCfF4AXepF0As")
        XCTAssertEqual(Base64URL.encode(key), "R_WtpIGQZJLqjsfnJAlOxOAyW_N7yWaUkb8Ln7_6EkQ")
        XCTAssertEqual(proof(key, .auth), "wLg2wS4ZlSZ3MWiGQV2iX3N6UwbqzI4YgeslP81HzuU")
        XCTAssertEqual(proof(key, .server), "T4B8f_I6s8lVWxZC9Y95hHpMzOTrGfrt16L2vFsXmAE")
        XCTAssertEqual(Base64URL.decode("R_WtpIGQZJLqjsfnJAlOxOAyW_N7yWaUkb8Ln7_6EkQ"), key)
        XCTAssertTrue(Handshake.matches("abc", "abc"))
        XCTAssertFalse(Handshake.matches("abc", "abd"))
        XCTAssertFalse(Handshake.matches("abc", "abcd"))
        let nonce = Handshake.newNonce()
        XCTAssertEqual(nonce.count, 32)
        XCTAssertNotEqual(nonce, Handshake.newNonce())
    }

    func testReadsServerMessages() throws {
        XCTAssertEqual(try ServerMessage(json: #"{"type":"hello","v":1,"serverId":"s","nonce":"n","extra":true}"#), .hello(version: 1, serverId: "s", nonce: "n"))
        XCTAssertEqual(try ServerMessage(json: #"{"type":"ready","proof":"p"}"#), .ready(proof: "p"))
        XCTAssertEqual(try ServerMessage(json: #"{"type":"pad","open":false}"#), .pad(nil))
        XCTAssertEqual(try ServerMessage(json: #"{"type":"clear","sheet":"a_1"}"#), .clear(sheet: "a_1"))
        XCTAssertEqual(try ServerMessage(json: #"{"type":"error","code":"busy","message":"Another iPad is connected."}"#),
                       .error(code: "busy", message: "Another iPad is connected."))
        XCTAssertEqual(try ServerMessage(json: #"{"type":"later"}"#), .unknown(type: "later"))
        XCTAssertThrowsError(try ServerMessage(json: "[]"))
        XCTAssertThrowsError(try ServerMessage(json: #"{"type":"pad","open":true}"#))

        let png = Data([137, 80, 78, 71]).base64EncodedString(), drawing = Data([1, 2, 3]).base64EncodedString()
        let pad = try ServerMessage(json: """
        {"type":"pad","open":true,"sheet":{"id":"k3J9x-2","theme":"dark","backgroundColor":"#1c1c1e",
          "reference":{"x":1665,"y":200,"width":670,"height":312.5,"png":"\(png)"},"drawing":"\(drawing)"}}
        """)
        XCTAssertEqual(pad, .pad(Sheet(id: "k3J9x-2", theme: .dark, backgroundColor: "#1c1c1e",
                                       reference: Picture(rect: SheetRect(x: 1665, y: 200, width: 670, height: 312.5), png: Data([137, 80, 78, 71])),
                                       drawing: Data([1, 2, 3]))))
    }

    func testWritesClientMessages() throws {
        func object(_ message: ClientMessage) throws -> NSDictionary {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(message.json.utf8)) as? NSDictionary)
        }
        XCTAssertEqual(try object(.auth(deviceId: "d", nonce: "n", proof: "p")), ["type": "auth", "deviceId": "d", "nonce": "n", "proof": "p"])
        let preview = Preview(sheet: "s", stroke: 7, color: "#ffffff", width: 3, points: [(1700.504, 640.25), (1702, 641)], end: false)
        XCTAssertEqual(try object(.preview(preview)), ["type": "preview", "sheet": "s", "stroke": 7, "color": "#ffffff", "width": 3,
                                                        "points": [[1700.5, 640.25], [1702, 641]], "end": false, "cancelled": false])
        let empty = Ink(sheet: "s", through: 0, theme: .light, drawing: Data([1, 2, 3]), image: nil)
        XCTAssertEqual(try object(.ink(empty)), ["type": "ink", "sheet": "s", "through": 0, "theme": "light", "drawing": "AQID"])
        let ink = Ink(sheet: "s", through: 7, theme: .dark, drawing: Data([1, 2, 3]),
                      image: Picture(rect: SheetRect(x: 1690, y: 630, width: 420, height: 180), png: Data([137, 80, 78, 71])))
        XCTAssertEqual(try object(.ink(ink))["image"] as? NSDictionary, ["x": 1690, "y": 630, "width": 420, "height": 180, "png": "iVBORw=="])
    }
}
