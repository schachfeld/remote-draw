import CryptoKit
import Foundation

/// The HMAC proofs of the handshake in PROTOCOL.md.
public enum Handshake {
    public enum Purpose: String { case pair, key, auth, server }

    /// HMAC-SHA256 over `remote-draw/v1/<purpose>\n<serverNonce>\n<clientNonce>\n<deviceId>`.
    public static func mac(key: Data, purpose: Purpose, serverNonce: String, clientNonce: String, deviceId: String) -> Data {
        let text = "remote-draw/v1/\(purpose.rawValue)\n\(serverNonce)\n\(clientNonce)\n\(deviceId)"
        return Data(HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: SymmetricKey(data: key)))
    }

    public static func proof(key: Data, purpose: Purpose, serverNonce: String, clientNonce: String, deviceId: String) -> String {
        Base64URL.encode(mac(key: key, purpose: purpose, serverNonce: serverNonce, clientNonce: clientNonce, deviceId: deviceId))
    }

    /// A fresh nonce: 24 random bytes, 32 base64url characters.
    public static func newNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return Base64URL.encode(Data((0..<24).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    /// Comparison whose duration does not depend on where the texts differ.
    public static func matches(_ expected: String, _ received: String) -> Bool {
        let a = Array(expected.utf8), b = Array(received.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
