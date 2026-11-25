import XCTest
@testable import RemoteDrawKit

/// Plays the desktop at the other end of a transport.
private final class FakeTransport: Transport {
    var onEvent: ((TransportEvent) -> Void)?
    let host: String
    var sent: [String] = []
    var started = false, cancelled = false
    /// Called for every text the client sends.
    var onSend: ((String) -> Void)?
    var onStart: (() -> Void)?

    init(host: String) { self.host = host }
    func start() { started = true; onStart?() }
    func send(_ text: String) { sent.append(text); onSend?(text) }
    func cancel() { cancelled = true; onEvent = nil }
    func deliver(_ json: String) { onEvent?(.text(json)) }
    func close(_ code: Int?) { let handler = onEvent; onEvent = nil; handler?(.closed(code: code)) }
}

private final class FakeNetwork: TransportFactory {
    var transports: [FakeTransport] = []
    var configure: (FakeTransport) -> Void = { _ in }
    func makeTransport(host: String, port: Int) -> Transport {
        let transport = FakeTransport(host: host)
        configure(transport)
        transports.append(transport)
        return transport
    }
}

private struct FakeDiscovery: Discovering {
    var result: Address?
    func find(serverId: String, timeout: TimeInterval, completion: @escaping (Address?) -> Void) -> () -> Void {
        var cancelled = false
        DispatchQueue.main.async { if !cancelled { completion(result) } }
        return { cancelled = true }
    }
}

final class LinkClientTests: XCTestCase {
    private let device = DeviceIdentity(id: "0b9d2c1e-aaaa-bbbb-cccc-1234567890ab", name: "Test iPad")
    private let serverId = "server-1", serverNonce = "serverNonce_0123456789"
    private let code = Data(repeating: 7, count: 32)
    private var network: FakeNetwork!
    private var states: [LinkClient.State] = []

    override func setUp() { network = FakeNetwork(); states = [] }

    private func client(discovery: Discovering? = nil) -> LinkClient {
        var timing = LinkClient.Timing()
        timing.retryDelays = [0.02]; timing.busyDelay = 0.02; timing.handshakeTimeout = 0.1; timing.discoveryTimeout = 0.05
        let client = LinkClient(device: device, transports: network, discovery: discovery, timing: timing)
        client.onState = { [unowned self] in states.append($0) }
        return client
    }

    private func fields(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
    }

    /// A desktop that knows `key` (or the pairing code) and answers honestly.
    private func honestServer(key: Data? = nil, serverId: String? = nil, pad: String = #"{"type":"pad","open":false}"#) -> (FakeTransport) -> Void {
        { [self] transport in
            transport.onStart = { [self] in
                DispatchQueue.main.async { transport.deliver(#"{"type":"hello","v":1,"serverId":"\#(serverId ?? self.serverId)","nonce":"\#(self.serverNonce)"}"#) }
            }
            transport.onSend = { [self] text in
                let message = fields(text)
                guard let type = message["type"] as? String, type == "pair" || type == "auth",
                      let nonce = message["nonce"] as? String, let deviceId = message["deviceId"] as? String else { return }
                let deviceKey = key ?? Handshake.mac(key: code, purpose: .key, serverNonce: serverNonce, clientNonce: nonce, deviceId: deviceId)
                let proofKey = type == "pair" ? code : deviceKey
                let expected = Handshake.proof(key: proofKey, purpose: type == "pair" ? .pair : .auth, serverNonce: serverNonce, clientNonce: nonce, deviceId: deviceId)
                guard message["proof"] as? String == expected else {
                    transport.deliver(#"{"type":"error","code":"unauthorized","message":"Pair it again."}"#)
                    return transport.close(4003)
                }
                let proof = Handshake.proof(key: deviceKey, purpose: .server, serverNonce: serverNonce, clientNonce: nonce, deviceId: deviceId)
                let answer = type == "pair" ? "paired" : "ready"
                transport.deliver(#"{"type":"\#(answer)","proof":"\#(proof)"}"#)
                transport.deliver(pad)
            }
        }
    }

    private func wait(_ what: String, _ condition: @escaping () -> Bool) {
        let done = expectation(description: what)
        func poll() { if condition() { done.fulfill() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.005, execute: poll) } }
        poll()
        wait(for: [done], timeout: 2)
    }

    private func pairing(key: Data = Data(repeating: 9, count: 32), hosts: [String] = ["192.0.2.10"]) -> Pairing {
        Pairing(deviceId: device.id, serverId: serverId, name: "Mac", port: 47600, hosts: hosts, deviceKey: key)
    }

    func testPairsStoresTheKeyAndReceivesThePad() {
        network.configure = honestServer(pad: ##"{"type":"pad","open":true,"sheet":{"id":"a_1","theme":"light","backgroundColor":"#ffffff"}}"##)
        let client = client()
        var stored: [Pairing] = [], pads: [Sheet?] = []
        client.onPairing = { stored.append($0) }
        client.onPad = { pads.append($0) }
        client.pair(invite: PairingInvite(serverId: serverId, name: "Mac", port: 47600, hosts: ["192.0.2.10", "100.64.0.7"], code: code))
        wait("pad") { pads.count == 1 }
        XCTAssertEqual(states, [.connecting, .connected])
        XCTAssertEqual(pads, [Sheet(id: "a_1", theme: .light, backgroundColor: "#ffffff")])
        let sent = fields(network.transports[0].sent[0])
        XCTAssertEqual(sent["deviceName"] as? String, "Test iPad")
        let nonce = sent["nonce"] as! String
        XCTAssertEqual(stored, [Pairing(deviceId: device.id, serverId: serverId, name: "Mac", port: 47600, hosts: ["192.0.2.10", "100.64.0.7"],
                                        deviceKey: Handshake.mac(key: code, purpose: .key, serverNonce: serverNonce, clientNonce: nonce, deviceId: device.id))])
        XCTAssertTrue(client.send(.ink(Ink(sheet: "a_1", through: 0, theme: .light, drawing: Data([1]), image: nil))))
        XCTAssertEqual(fields(network.transports[0].sent[1])["type"] as? String, "ink")
    }

    func testAnExpiredCodeStopsWithTheDesktopMessage() {
        network.configure = honestServer()
        let client = client()
        client.pair(invite: PairingInvite(serverId: serverId, name: "Mac", port: 47600, hosts: ["192.0.2.10"], code: Data(repeating: 1, count: 32)))
        wait("stop") { self.states.last == .stopped(.pairingFailed("Pair it again.")) }
        XCTAssertFalse(client.send(.auth(deviceId: "d", nonce: "n", proof: "p")))
    }

    func testTriesTheNextAddressAndRemembersTheOneThatWorked() {
        let key = Data(repeating: 9, count: 32)
        network.configure = { [self] transport in
            if transport.host == "192.0.2.10" { transport.onStart = { DispatchQueue.main.async { transport.close(nil) } } }
            else { honestServer(key: key)(transport) }
        }
        let client = client()
        var stored: [Pairing] = []
        client.onPairing = { stored.append($0) }
        client.connect(pairing: pairing(key: key, hosts: ["192.0.2.10", "100.64.0.7"]))
        wait("connected") { client.state == .connected }
        XCTAssertEqual(network.transports.map(\.host), ["192.0.2.10", "100.64.0.7"])
        XCTAssertEqual(stored.map(\.hosts), [["100.64.0.7", "192.0.2.10"]])
    }

    func testPrefersTheBonjourAddress() {
        let key = Data(repeating: 9, count: 32)
        network.configure = honestServer(key: key)
        let client = client(discovery: FakeDiscovery(result: Address(host: "192.0.2.99", port: 50000)))
        var stored: [Pairing] = []
        client.onPairing = { stored.append($0) }
        client.connect(pairing: pairing(key: key))
        wait("connected") { client.state == .connected }
        XCTAssertEqual(network.transports.map(\.host), ["192.0.2.99"])
        XCTAssertEqual(stored.first?.port, 50000)
        XCTAssertEqual(stored.first?.hosts, ["192.0.2.99", "192.0.2.10"])
    }

    func testDropsAServerThatCannotProveTheKey() {
        // The impostor answers every auth with a made-up proof.
        network.configure = { [self] transport in
            transport.onStart = { [self] in DispatchQueue.main.async { transport.deliver(#"{"type":"hello","v":1,"serverId":"\#(self.serverId)","nonce":"\#(self.serverNonce)"}"#) } }
            transport.onSend = { _ in transport.deliver(#"{"type":"ready","proof":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#); transport.deliver(#"{"type":"pad","open":false}"#) }
        }
        let client = client()
        var pads = 0
        client.onPad = { _ in pads += 1 }
        client.connect(pairing: pairing())
        wait("gave up on the address") { self.states.contains(.waiting(.unreachable)) }
        XCTAssertEqual(pads, 0)
        XCTAssertFalse(states.contains(.connected))
        XCTAssertTrue(network.transports[0].cancelled)
        client.disconnect()
    }

    func testSkipsAnAddressThatNowBelongsToAnotherDesktop() {
        let key = Data(repeating: 9, count: 32)
        network.configure = { [self] transport in honestServer(key: key, serverId: transport.host == "192.0.2.10" ? "someone-else" : nil)(transport) }
        let client = client()
        client.connect(pairing: pairing(key: key, hosts: ["192.0.2.10", "100.64.0.7"]))
        wait("connected") { client.state == .connected }
        XCTAssertTrue(network.transports[0].sent.isEmpty, "no proof is sent to a stranger")
    }

    func testReconnectsAfterALostConnection() {
        let key = Data(repeating: 9, count: 32)
        network.configure = honestServer(key: key)
        let client = client()
        client.connect(pairing: pairing(key: key))
        wait("connected") { client.state == .connected }
        network.transports[0].close(1006)
        wait("reconnected") { self.network.transports.count == 2 && client.state == .connected }
        XCTAssertEqual(states, [.connecting, .connected, .waiting(.unreachable), .connecting, .connected])
    }

    func testRetriesWhileAnotherIPadIsConnected() {
        let key = Data(repeating: 9, count: 32)
        network.configure = { [self] transport in
            guard network.transports.isEmpty else { return honestServer(key: key)(transport) }
            transport.onStart = { [self] in DispatchQueue.main.async { transport.deliver(#"{"type":"hello","v":1,"serverId":"\#(self.serverId)","nonce":"\#(self.serverNonce)"}"#) } }
            transport.onSend = { _ in transport.deliver(#"{"type":"error","code":"busy","message":"Another iPad is connected."}"#); transport.close(4009) }
        }
        let client = client()
        client.connect(pairing: pairing(key: key))
        wait("connected") { client.state == .connected }
        XCTAssertEqual(states, [.connecting, .waiting(.busy), .connecting, .connected])
    }

    func testCloseCodesThatEndTheSession() {
        let key = Data(repeating: 9, count: 32)
        for (code, expected) in [(4010, LinkClient.StopReason.forgotten), (4002, .unsupportedVersion), (4001, .replaced)] {
            setUp()
            network.configure = honestServer(key: key)
            let client = client()
            client.connect(pairing: pairing(key: key))
            wait("connected") { client.state == .connected }
            network.transports[0].close(code)
            XCTAssertEqual(client.state, .stopped(expected))
            let attempts = network.transports.count
            client.retryNow()
            XCTAssertEqual(network.transports.count, expected == .replaced ? attempts + 1 : attempts, "only a replaced session can be resumed")
            client.disconnect()
        }
    }

    func testAnUnknownDeviceIsNotRetried() {
        network.configure = honestServer(key: Data(repeating: 9, count: 32))
        let client = client()
        client.connect(pairing: pairing(key: Data(repeating: 3, count: 32)))
        wait("stop") { self.states.last == .stopped(.unauthorized("Pair it again.")) }
        let attempts = network.transports.count
        let quiet = expectation(description: "no retry")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { quiet.fulfill() }
        wait(for: [quiet], timeout: 1)
        XCTAssertEqual(network.transports.count, attempts)
    }

    func testANewerProtocolVersionStops() {
        network.configure = { transport in
            transport.onStart = { DispatchQueue.main.async { transport.deliver(#"{"type":"hello","v":2,"serverId":"server-1","nonce":"n"}"#) } }
        }
        let client = client()
        client.connect(pairing: pairing())
        wait("stop") { client.state == .stopped(.unsupportedVersion) }
        XCTAssertTrue(network.transports[0].sent.isEmpty)
    }

    func testASilentAddressTimesOut() {
        let key = Data(repeating: 9, count: 32)
        network.configure = { [self] transport in if transport.host != "192.0.2.10" { honestServer(key: key)(transport) } }
        let client = client()
        client.connect(pairing: pairing(key: key, hosts: ["192.0.2.10", "100.64.0.7"]))
        wait("connected") { client.state == .connected }
        XCTAssertTrue(network.transports[0].cancelled)
    }
}
