import Foundation
import Network

public struct Address: Equatable, Hashable {
    public var host: String
    public var port: Int
    public init(host: String, port: Int) { self.host = host; self.port = port }
}

/// Finds the Mac that announces a given server ID.
public protocol Discovering {
    /// Calls `completion` exactly once on the main queue, with `nil` if nothing
    /// was found in time. The returned closure abandons the search silently.
    func find(serverId: String, timeout: TimeInterval, completion: @escaping (Address?) -> Void) -> () -> Void
}

/// Bonjour lookup of `_remotedraw._tcp` with a matching TXT `id`.
public struct BonjourDiscovery: Discovering {
    public init() {}

    public func find(serverId: String, timeout: TimeInterval, completion: @escaping (Address?) -> Void) -> () -> Void {
        let search = Search(serverId: serverId, completion: completion)
        search.start(timeout: timeout)
        return { search.finish(nil, silently: true) }
    }

    private final class Search {
        private let serverId: String
        private var completion: ((Address?) -> Void)?
        private let browser: NWBrowser
        private var resolver: NWConnection?

        init(serverId: String, completion: @escaping (Address?) -> Void) {
            self.serverId = serverId
            self.completion = completion
            browser = NWBrowser(for: .bonjourWithTXTRecord(type: bonjourServiceType, domain: nil), using: .tcp)
        }

        func start(timeout: TimeInterval) {
            browser.browseResultsChangedHandler = { [self] results, _ in
                guard resolver == nil, completion != nil else { return }
                let match = results.first { result in
                    if case .bonjour(let record) = result.metadata { return record.dictionary["id"] == serverId }
                    return false
                }
                if let match { resolve(match.endpoint) }
            }
            browser.stateUpdateHandler = { [self] state in
                if case .failed = state { finish(nil) }
            }
            browser.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [self] in finish(nil) }
        }

        /// The WebSocket needs a host and port for its URL. Opening a plain TCP
        /// connection to the service lets the system resolve it; IPv4 only, so
        /// the address needs no interface scope.
        private func resolve(_ endpoint: NWEndpoint) {
            let parameters = NWParameters.tcp
            (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
            let connection = NWConnection(to: endpoint, using: parameters)
            resolver = connection
            connection.stateUpdateHandler = { [self] state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint, let name = Self.text(host) {
                        finish(Address(host: name, port: Int(port.rawValue)))
                    } else { finish(nil) }
                case .failed, .waiting: finish(nil)
                default: break
                }
            }
            connection.start(queue: .main)
        }

        func finish(_ address: Address?, silently: Bool = false) {
            guard let completion else { return }
            self.completion = nil
            browser.cancel()
            resolver?.stateUpdateHandler = nil
            resolver?.cancel()
            if !silently { completion(address) }
        }

        private static func text(_ host: NWEndpoint.Host) -> String? {
            switch host {
            case .ipv4(let address): return address.rawValue.map(String.init).joined(separator: ".")
            case .name(let name, _): return name
            default: return nil
            }
        }
    }
}
