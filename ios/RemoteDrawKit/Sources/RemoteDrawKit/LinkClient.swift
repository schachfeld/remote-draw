import Foundation

/// The client side of PROTOCOL.md: finds the Mac, runs the handshake, keeps the
/// connection up and hands `pad` and `clear` to the app. Main thread only.
public final class LinkClient {
    public enum WaitReason: Equatable {
        /// The Mac was not found or the connection broke.
        case unreachable
        /// Another paired iPad is connected.
        case busy
    }

    public enum StopReason: Equatable {
        /// The desktop does not know this iPad (any more).
        case unauthorized(String)
        /// The pairing code was wrong, used or expired.
        case pairingFailed(String)
        /// The device was removed in the plugin settings.
        case forgotten
        case unsupportedVersion
        /// The same device connected again from somewhere else.
        case replaced
    }

    public enum State: Equatable {
        case idle
        case connecting
        case connected
        /// Not connected; trying again by itself.
        case waiting(WaitReason)
        /// Not connected and not trying again.
        case stopped(StopReason)
    }

    public struct Timing {
        /// Delays before reconnecting; the last one repeats.
        public var retryDelays: [TimeInterval] = [1, 2, 4, 5]
        public var busyDelay: TimeInterval = 5
        public var discoveryTimeout: TimeInterval = 2
        /// Per address, from opening the socket to `paired` or `ready`.
        public var handshakeTimeout: TimeInterval = 6
        public init() {}
    }

    public private(set) var state: State = .idle
    public var onState: ((State) -> Void)?
    public var onPad: ((Sheet?) -> Void)?
    public var onClear: ((String) -> Void)?
    /// A new pairing, or a known one whose working address changed. Store it.
    public var onPairing: ((Pairing) -> Void)?
    public var log: (String) -> Void = { _ in }

    private enum Mode { case pair(PairingInvite), auth(Pairing) }
    private struct Pending { var clientNonce: String; var expectedProof: String; var key: Data }

    private let device: DeviceIdentity
    private let transports: TransportFactory
    private let discovery: Discovering?
    private let timing: Timing
    private var mode: Mode?
    /// Grows whenever the current attempt is abandoned, so late callbacks know.
    private var epoch = 0
    private var transport: Transport?
    private var cancelDiscovery: (() -> Void)?
    private var pending: Pending?
    private var serverError: (code: String, message: String)?
    private var failures = 0

    public init(device: DeviceIdentity, transports: TransportFactory = WebSocketTransportFactory(),
                discovery: Discovering? = BonjourDiscovery(), timing: Timing = Timing()) {
        self.device = device; self.transports = transports; self.discovery = discovery; self.timing = timing
    }

    /// Connect with a stored pairing and stay connected.
    public func connect(pairing: Pairing) {
        mode = .auth(pairing); failures = 0
        attempt()
    }

    /// Pair with the code from a QR scan. Success arrives through `onPairing`.
    public func pair(invite: PairingInvite) {
        mode = .pair(invite); failures = 0
        attempt()
    }

    public func disconnect() {
        mode = nil
        abandon()
        set(.idle)
    }

    /// Skip the remaining wait, for example when the app comes to the front.
    public func retryNow() {
        guard mode != nil else { return }
        switch state {
        case .waiting, .stopped(.replaced): failures = 0; attempt()
        default: break
        }
    }

    /// False when not connected; the message is dropped.
    @discardableResult
    public func send(_ message: ClientMessage) -> Bool {
        guard state == .connected, let transport else { return false }
        transport.send(message.json)
        return true
    }

    // MARK: Connecting

    private func abandon() {
        epoch += 1
        cancelDiscovery?(); cancelDiscovery = nil
        transport?.cancel(); transport = nil
        pending = nil; serverError = nil
    }

    private func set(_ next: State) {
        guard next != state else { return }
        state = next
        onState?(next)
    }

    private func attempt() {
        abandon()
        guard let mode else { return }
        set(.connecting)
        let serverId: String, hosts: [String], port: Int
        switch mode {
        case .pair(let invite): (serverId, hosts, port) = (invite.serverId, invite.hosts, invite.port)
        case .auth(let pairing): (serverId, hosts, port) = (pairing.serverId, pairing.hosts, pairing.port)
        }
        let epoch = epoch
        let stored = hosts.map { Address(host: $0, port: port) }
        guard let discovery else { return tryNext(stored, epoch: epoch) }
        cancelDiscovery = discovery.find(serverId: serverId, timeout: timing.discoveryTimeout) { [weak self] found in
            guard let self, epoch == self.epoch else { return }
            self.cancelDiscovery = nil
            var candidates = stored
            if let found { candidates.removeAll { $0 == found }; candidates.insert(found, at: 0) }
            self.tryNext(candidates, epoch: epoch)
        }
    }

    private func tryNext(_ candidates: [Address], epoch: Int) {
        guard epoch == self.epoch else { return }
        transport?.cancel(); transport = nil
        pending = nil; serverError = nil
        guard let address = candidates.first else { return wait(.unreachable) }
        let rest = Array(candidates.dropFirst())
        log("Trying \(address.host):\(address.port)")
        let transport = transports.makeTransport(host: address.host, port: address.port)
        self.transport = transport
        transport.onEvent = { [weak self, weak transport] event in
            guard let self, let transport, transport === self.transport, epoch == self.epoch else { return }
            switch event {
            case .text(let text): self.receive(text, from: address, rest: rest, epoch: epoch)
            case .closed(let code): self.closed(code, rest: rest, epoch: epoch)
            }
        }
        transport.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + timing.handshakeTimeout) { [weak self, weak transport] in
            guard let self, let transport, transport === self.transport, epoch == self.epoch, self.state != .connected else { return }
            self.log("No answer from \(address.host)")
            self.tryNext(rest, epoch: epoch)
        }
    }

    private func receive(_ text: String, from address: Address, rest: [Address], epoch: Int) {
        guard let mode, let message = try? ServerMessage(json: text) else { return log("Ignored a message that could not be read.") }
        switch message {
        case .hello(let version, let serverId, let serverNonce):
            guard state != .connected, pending == nil else { return }
            guard version == protocolVersion else { return stop(.unsupportedVersion) }
            let clientNonce = Handshake.newNonce()
            let deviceId: String, key: Data, expectedServerId: String
            switch mode {
            case .pair(let invite):
                deviceId = device.id; expectedServerId = invite.serverId
                key = Handshake.mac(key: invite.code, purpose: .key, serverNonce: serverNonce, clientNonce: clientNonce, deviceId: deviceId)
            case .auth(let pairing):
                deviceId = pairing.deviceId; expectedServerId = pairing.serverId; key = pairing.deviceKey
            }
            // A stored address may belong to another Mac by now; it gets no proof.
            guard serverId == expectedServerId else { return tryNext(rest, epoch: epoch) }
            func proof(_ key: Data, _ purpose: Handshake.Purpose) -> String {
                Handshake.proof(key: key, purpose: purpose, serverNonce: serverNonce, clientNonce: clientNonce, deviceId: deviceId)
            }
            pending = Pending(clientNonce: clientNonce, expectedProof: proof(key, .server), key: key)
            switch mode {
            case .pair(let invite):
                transport?.send(ClientMessage.pair(deviceId: deviceId, deviceName: device.name, nonce: clientNonce, proof: proof(invite.code, .pair)).json)
            case .auth:
                transport?.send(ClientMessage.auth(deviceId: deviceId, nonce: clientNonce, proof: proof(key, .auth)).json)
            }
        case .paired(let proof), .ready(let proof):
            guard state != .connected, let pending else { return }
            // Without this check any machine on the network could pose as the Mac.
            guard Handshake.matches(pending.expectedProof, proof) else {
                log("\(address.host) failed to prove it knows the device key.")
                return tryNext(rest, epoch: epoch)
            }
            self.pending = nil
            failures = 0
            var pairing: Pairing
            switch mode {
            case .pair(let invite):
                pairing = Pairing(deviceId: device.id, serverId: invite.serverId, name: invite.name, port: invite.port,
                                  hosts: invite.hosts, deviceKey: pending.key)
            case .auth(let known): pairing = known
            }
            let before = pairing
            pairing.port = address.port
            pairing.hosts.removeAll { $0 == address.host }
            pairing.hosts.insert(address.host, at: 0)
            self.mode = .auth(pairing)
            if case .pair = mode { onPairing?(pairing) } else if pairing != before { onPairing?(pairing) }
            set(.connected)
        case .pad(let sheet):
            if state == .connected { onPad?(sheet) }
        case .clear(let sheet):
            if state == .connected { onClear?(sheet) }
        case .error(let code, let message):
            serverError = (code, message)
            log("Desktop reported \(code): \(message)")
        case .unknown(let type):
            log("Ignored unknown message type \(type).")
        }
    }

    private func closed(_ code: Int?, rest: [Address], epoch: Int) {
        let message = serverError?.message ?? ""
        let wasConnected = state == .connected
        transport = nil
        log("Connection closed\(code.map { " (\($0))" } ?? "")")
        switch code {
        case 4003:
            if case .pair = mode { stop(.pairingFailed(message.isEmpty ? "The pairing code is wrong or has expired." : message)) }
            else { stop(.unauthorized(message.isEmpty ? "This iPad is not paired with this desktop." : message)) }
        case 4009: wait(.busy)
        case 4010: stop(.forgotten)
        case 4002: stop(.unsupportedVersion)
        case 4001: stop(.replaced)
        default:
            if wasConnected { wait(.unreachable) } else { tryNext(rest, epoch: epoch) }
        }
    }

    private func wait(_ reason: WaitReason) {
        abandon()
        set(.waiting(reason))
        let delay = reason == .busy ? timing.busyDelay : timing.retryDelays[min(failures, timing.retryDelays.count - 1)]
        failures += 1
        let epoch = epoch
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, epoch == self.epoch else { return }
            self.attempt()
        }
    }

    private func stop(_ reason: StopReason) {
        abandon()
        switch reason {
        case .replaced: break // `retryNow` may pick the pairing up again.
        default: mode = nil
        }
        set(.stopped(reason))
    }
}
