import Foundation
import Network

public enum TransportEvent: Equatable {
    case text(String)
    /// Delivered exactly once. `code` is the WebSocket close code if the peer sent one.
    case closed(code: Int?)
}

/// One connection to the desktop that carries text frames. The WebSocket over
/// Wi-Fi is the only implementation today; a USB link would be a second one.
public protocol Transport: AnyObject {
    /// Called on the main queue.
    var onEvent: ((TransportEvent) -> Void)? { get set }
    func start()
    func send(_ text: String)
    /// Closes without delivering `closed`.
    func cancel()
}

public protocol TransportFactory {
    func makeTransport(host: String, port: Int) -> Transport
}

public struct WebSocketTransportFactory: TransportFactory {
    public init() {}
    public func makeTransport(host: String, port: Int) -> Transport { WebSocketTransport(host: host, port: port) }
}

/// Plain `ws://` through Network.framework, which is not subject to App
/// Transport Security and reports the server's close code.
public final class WebSocketTransport: Transport {
    public static let maximumMessageSize = 24 * 1024 * 1024
    /// The client pings so a dead link is noticed without waiting for TCP.
    static let pingInterval: TimeInterval = 10

    public var onEvent: ((TransportEvent) -> Void)?
    private let connection: NWConnection
    private var finished = false
    private var pingTimer: Timer?
    private var awaitingPong = false

    public init(host: String, port: Int) {
        let literal = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = Self.maximumMessageSize
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 5
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        let url = URL(string: "ws://\(literal):\(port)\(webSocketPath)") ?? URL(string: "ws://invalid.invalid\(webSocketPath)")!
        connection = NWConnection(to: .url(url), using: parameters)
    }

    public func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.receive()
                self.pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingInterval, repeats: true) { [weak self] _ in self?.ping() }
            // `.waiting` means there is no route right now. The caller has other
            // addresses to try and its own retry delays, so do not sit here.
            case .failed, .waiting, .cancelled: self.finish(code: nil)
            default: break
            }
        }
        connection.start(queue: .main)
    }

    public func send(_ text: String) {
        guard !finished else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
            if error != nil { self?.finish(code: nil) }
        })
    }

    public func cancel() {
        onEvent = nil
        finish(code: nil)
    }

    private func receive() {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self, !self.finished else { return }
            if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch metadata.opcode {
                case .text:
                    if let content { self.onEvent?(.text(String(decoding: content, as: UTF8.self))) }
                case .close:
                    return self.finish(code: Self.number(metadata.closeCode))
                default: break
                }
            }
            if error != nil || (content == nil && context == nil) { return self.finish(code: nil) }
            self.receive()
        }
    }

    private func ping() {
        guard !finished else { return }
        if awaitingPong { return finish(code: nil) }
        awaitingPong = true
        let metadata = NWProtocolWebSocket.Metadata(opcode: .ping)
        metadata.setPongHandler(.main) { [weak self] error in
            if error == nil { self?.awaitingPong = false } else { self?.finish(code: nil) }
        }
        let context = NWConnection.ContentContext(identifier: "ping", metadata: [metadata])
        connection.send(content: Data(), contentContext: context, isComplete: true, completion: .idempotent)
    }

    private func finish(code: Int?) {
        guard !finished else { return }
        finished = true
        pingTimer?.invalidate(); pingTimer = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        let handler = onEvent
        onEvent = nil
        handler?(.closed(code: code))
    }

    private static func number(_ code: NWProtocolWebSocket.CloseCode) -> Int? {
        switch code {
        case .protocolCode(let defined): return Int(defined.rawValue)
        case .applicationCode(let value), .privateCode(let value): return Int(value)
        @unknown default: return nil
        }
    }
}
