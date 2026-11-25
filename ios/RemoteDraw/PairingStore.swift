import Foundation
import RemoteDrawKit
import Security
import UIKit

/// Keeps the pairing, which contains the secret device key, in the Keychain.
enum PairingStore {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.github.schachfeld.remotedraw",
        kSecAttrAccount as String: "pairing",
    ]

    static func load() -> Pairing? {
        var result: CFTypeRef?
        let request = query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { $1 }
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    /// False when the Keychain refused; the pairing then only lasts until the app quits.
    @discardableResult
    static func save(_ pairing: Pairing) -> Bool {
        guard let data = try? JSONEncoder().encode(pairing) else { return false }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Reconnecting must work after a restart without unlocking first; the key never leaves this iPad.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { return SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess }
        return status == errSecSuccess
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }

    /// The ID is created once and kept; the desktop lists paired iPads by it.
    static var device: DeviceIdentity {
        let key = "deviceId"
        let id: String
        if let stored = UserDefaults.standard.string(forKey: key) { id = stored }
        else {
            id = UUID().uuidString.lowercased()
            UserDefaults.standard.set(id, forKey: key)
        }
        return DeviceIdentity(id: id, name: UIDevice.current.name)
    }
}
