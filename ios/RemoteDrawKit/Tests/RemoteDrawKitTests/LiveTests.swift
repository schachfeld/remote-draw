import XCTest
@testable import RemoteDrawKit

/// Talks to a real plugin service over the network. Skipped unless a pairing URI
/// is given:
///
///     cd plugin && npx tsx scripts/dev-desktop.ts      # then type: open, pair
///     REMOTE_DRAW_PAIRING_URI='remotedraw://pair?…' swift test --filter LiveTests
final class LiveTests: XCTestCase {
    func testPairsDrawsAndReconnectsAgainstTheRealService() throws {
        guard let uri = ProcessInfo.processInfo.environment["REMOTE_DRAW_PAIRING_URI"] else {
            throw XCTSkip("Set REMOTE_DRAW_PAIRING_URI to run against a real desktop.")
        }
        let invite = try PairingInvite(uri: uri)
        let device = DeviceIdentity(id: UUID().uuidString.lowercased(), name: "Swift live test")
        var pairing: Pairing?, sheet: Sheet?

        func session(_ start: (LinkClient) -> Void) -> LinkClient {
            let client = LinkClient(device: device)
            client.log = { print("link:", $0) }
            client.onPairing = { pairing = $0 }
            let pad = expectation(description: "pad")
            pad.assertForOverFulfill = false
            client.onPad = { sheet = $0; pad.fulfill() }
            start(client)
            wait(for: [pad], timeout: 15)
            XCTAssertEqual(client.state, .connected)
            return client
        }

        var client = session { $0.pair(invite: invite) }
        let stored = try XCTUnwrap(pairing)
        XCTAssertEqual(stored.serverId, invite.serverId)
        XCTAssertEqual(stored.deviceKey.count, 32)
        let open = try XCTUnwrap(sheet, "open a pad on the desktop first")
        XCTAssertNotNil(open.reference)

        let points = (0..<40).map { (x: 1700 + Double($0) * 6, y: 700 + sin(Double($0) / 4) * 16) }
        XCTAssertTrue(client.send(.preview(Preview(sheet: open.id, stroke: 1, color: "#ffffff", width: 3, points: points, end: false))))
        XCTAssertTrue(client.send(.preview(Preview(sheet: open.id, stroke: 1, color: "#ffffff", width: 3, points: [], end: true))))
        // A 1x1 transparent PNG stands in for the rendered ink.
        let png = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="))
        let drawing = Data("live test drawing".utf8)
        XCTAssertTrue(client.send(.ink(Ink(sheet: open.id, through: 1, theme: open.theme, drawing: drawing,
                                           image: Picture(rect: SheetRect(x: 1700, y: 680, width: 240, height: 40), png: png)))))
        let flushed = expectation(description: "sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { flushed.fulfill() }
        wait(for: [flushed], timeout: 2)
        client.disconnect()

        // A second connection authenticates with the stored key and gets the drawing back.
        sheet = nil
        client = session { $0.connect(pairing: stored) }
        XCTAssertEqual(sheet?.id, open.id)
        XCTAssertEqual(sheet?.drawing, drawing)
        client.disconnect()
    }
}
