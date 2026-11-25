import Foundation

/// The protocol version this client speaks.
public let protocolVersion = 1
/// Path of the WebSocket endpoint on the Mac.
public let webSocketPath = "/remote-draw/v1"
/// Bonjour service type the plugin announces.
public let bonjourServiceType = "_remotedraw._tcp"

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while standard.count % 4 != 0 { standard.append("=") }
        return Data(base64Encoded: standard)
    }
}

/// What the pairing QR code says.
public struct PairingInvite: Equatable {
    public var serverId: String
    public var name: String
    public var port: Int
    public var hosts: [String]
    /// The 32 decoded bytes of the pairing code.
    public var code: Data

    public enum ParseError: Error, Equatable, LocalizedError {
        case notRemoteDraw
        case unsupportedVersion
        case missing(String)
        case invalid(String)

        public var errorDescription: String? {
            switch self {
            case .notRemoteDraw: return "This is not a Remote Draw pairing code."
            case .unsupportedVersion: return "This pairing code needs a newer version of the app."
            case .missing(let field), .invalid(let field): return "The pairing code is damaged (\(field)). Show a new one and try again."
            }
        }
    }

    public static let scheme = "remotedraw"

    public init(serverId: String, name: String, port: Int, hosts: [String], code: Data) {
        self.serverId = serverId; self.name = name; self.port = port; self.hosts = hosts; self.code = code
    }

    /// Parses `remotedraw://pair?v=1&id=…&name=…&port=…&hosts=…&code=…`.
    public init(uri: String) throws {
        let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == Self.scheme, components.host?.lowercased() == "pair"
        else { throw ParseError.notRemoteDraw }
        // The plugin writes the query in form encoding, where a space is "+".
        var values: [String: String] = [:]
        for pair in (components.percentEncodedQuery ?? "").split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (text: Substring) in
                text.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(text)
            }
            if let key = parts.first, values[decode(key)] == nil { values[decode(key)] = parts.count > 1 ? decode(parts[1]) : "" }
        }
        func value(_ key: String) throws -> String {
            guard let value = values[key], !value.isEmpty else { throw ParseError.missing(key) }
            return value
        }
        guard try value("v") == String(protocolVersion) else { throw ParseError.unsupportedVersion }
        serverId = try value("id")
        name = try value("name")
        guard let port = Int(try value("port")), (1...65535).contains(port) else { throw ParseError.invalid("port") }
        self.port = port
        hosts = (values["hosts"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        guard let code = Base64URL.decode(try value("code")), code.count == 32 else { throw ParseError.invalid("code") }
        self.code = code
    }
}

/// What the app keeps after pairing. Contains the secret device key, so it
/// belongs in the Keychain.
public struct Pairing: Codable, Equatable {
    public var deviceId: String
    public var serverId: String
    public var name: String
    public var port: Int
    /// Addresses to try when Bonjour finds nothing; the one that worked last comes first.
    public var hosts: [String]
    /// 32 raw bytes.
    public var deviceKey: Data

    public init(deviceId: String, serverId: String, name: String, port: Int, hosts: [String], deviceKey: Data) {
        self.deviceId = deviceId; self.serverId = serverId; self.name = name
        self.port = port; self.hosts = hosts; self.deviceKey = deviceKey
    }
}

/// Who this iPad is to the desktop.
public struct DeviceIdentity: Equatable {
    public var id: String
    public var name: String

    /// `name` is trimmed and cut to the 64 characters the protocol allows.
    public init(id: String, name: String) {
        self.id = id
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.name = trimmed.isEmpty ? "iPad" : String(trimmed.prefix(64))
    }
}
