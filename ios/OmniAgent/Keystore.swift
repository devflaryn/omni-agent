// The page's `keystore` bridge: what ui/keychain-store.js keeps, kept in the iOS Keychain on this phone only.
//
// The rules, each held by OmniAgentTests/KeystoreTests.swift:
// - Five names and nothing else: keys, session, log, state, alerts. Text in, text or null out.
// - `keys` is answered once per page load. The page imports the private keys as CryptoKeys it cannot export and keeps them, so it
//   never needs a second read; code that runs in the page later cannot ask for the bytes. A new page load (the shell calls
//   `pageLoaded()` when a main-frame navigation commits) starts again with the same bundled code, which reads them first.
// - `keys` is written only as a first identity: when this page load's read of `keys` found none, and once. Page code that removes
//   the keys cannot then put its own in the same load: after "Forget this phone" the page loads again (ui/phone.js) before it
//   makes new ones.
// - A Keychain that cannot answer is an error, never "none". If it read as none, the page would make new keys and the phone would
//   lose its place on the account.
// - Items are kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly and not synchronizable: never in iCloud, never in a backup that
//   restores onto another phone.
import Foundation
import Security

enum KeystoreError: Error, CustomStringConvertible {
    case keychain(OSStatus)
    case notText

    var description: String {
        switch self {
        case .keychain(let status): return "The Keychain did not answer (\(status))."
        case .notText: return "The Keychain held something that is not text."
        }
    }
}

/// Where the text is kept. `read` returns nil only when there is no item, and throws for anything else.
protocol SecretStore {
    func read(_ name: String) throws -> String?
    func write(_ name: String, _ value: String) throws
    func delete(_ name: String) throws
}

/// The real store: generic passwords under one service, on this device only.
struct Keychain: SecretStore {
    let service: String

    private func query(_ name: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    func read(_ name: String) throws -> String? {
        var ask = query(name)
        ask[kSecReturnData as String] = true
        ask[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(ask as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeystoreError.keychain(status) }
        guard let data = found as? Data, let text = String(data: data, encoding: .utf8) else { throw KeystoreError.notText }
        return text
    }

    func write(_ name: String, _ value: String) throws {
        let fields: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(name) as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(name).merging(fields) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeystoreError.keychain(status) }
    }

    func delete(_ name: String) throws {
        let status = SecItemDelete(query(name) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeystoreError.keychain(status) }
    }
}

/// Answers the page's messages. Each reply is {value} or {error}; ui/phone.js turns {error} into a rejection.
final class KeystoreBridge {
    static let names: Set<String> = ["keys", "session", "log", "state", "alerts"]

    private let store: SecretStore
    private var keysAnswered = false
    /// What this load's one read of `keys` found: nil before the read, then whether there were keys. A put needs `false`.
    private var keysAtLoad: Bool?
    private var keysWritten = false

    init(store: SecretStore) {
        self.store = store
    }

    /// A new document in the main frame: its code is the bundle's, fresh, so it may read the keys once.
    func pageLoaded() {
        keysAnswered = false
        keysAtLoad = nil
        keysWritten = false
    }

    func answer(_ body: Any) -> [String: Any] {
        guard let message = body as? [String: Any], let op = message["op"] as? String else { return refuse("Not a request.") }
        switch op {
        case "get", "put", "remove": break
        default: return refuse("Nothing here answers \(op).")
        }
        guard let name = message["name"] as? String, Self.names.contains(name) else { return refuse("The Keychain store keeps nothing by that name.") }
        do {
            switch op {
            case "get":
                if name == "keys" && keysAnswered { return refuse("This phone's keys are read once per page load, and they were.") }
                let text = try store.read(name)
                if name == "keys" {
                    keysAnswered = true
                    keysAtLoad = text != nil
                }
                return ["value": text ?? NSNull()]
            case "put":
                guard let value = message["value"] as? String else { return refuse("Only text is kept.") }
                if name == "keys" {
                    guard keysAtLoad == false, !keysWritten else {
                        return refuse("This phone's keys were just deleted, and new ones are made only on a fresh start. Close Omni, open it again, and sign in.")
                    }
                    if try store.read("keys") != nil { return refuse("This phone already has keys. They are never replaced, only forgotten.") }
                }
                try store.write(name, value)
                if name == "keys" { keysWritten = true }
                return ["value": NSNull()]
            default:
                try store.delete(name)
                return ["value": NSNull()]
            }
        } catch {
            return refuse(String(describing: error))
        }
    }

    private func refuse(_ why: String) -> [String: Any] { ["error": why] }
}
