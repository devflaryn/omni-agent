// The bridge's rules (Keystore.swift), the page's address rules (BundleScheme.swift), and the real Keychain in the simulator.
import Security
import XCTest
@testable import OmniAgent

/// A store in memory, which can be told to fail as a locked or broken Keychain does.
final class MemoryStore: SecretStore {
    var items: [String: String] = [:]
    var failing: OSStatus?
    var reads = 0

    func read(_ name: String) throws -> String? {
        reads += 1
        if let failing { throw KeystoreError.keychain(failing) }
        return items[name]
    }
    func write(_ name: String, _ value: String) throws {
        if let failing { throw KeystoreError.keychain(failing) }
        items[name] = value
    }
    func delete(_ name: String) throws {
        if let failing { throw KeystoreError.keychain(failing) }
        items[name] = nil
    }
}

final class KeystoreBridgeTests: XCTestCase {
    private func bridge(_ store: MemoryStore = MemoryStore()) -> KeystoreBridge {
        KeystoreBridge(store: store)
    }

    func testKeysAreAnsweredOncePerPageLoad() {
        let store = MemoryStore()
        store.items["keys"] = "{\"sign\":\"secret\"}"
        let b = bridge(store)
        XCTAssertEqual(b.answer(["op": "get", "name": "keys"])["value"] as? String, "{\"sign\":\"secret\"}")
        let second = b.answer(["op": "get", "name": "keys"])
        XCTAssertNil(second["value"], "a second read in the same load gets nothing")
        XCTAssertNotNil(second["error"] as? String, "and is told so, as an error")
        XCTAssertEqual(store.reads, 1, "the refused read never reached the Keychain")
        b.pageLoaded()
        XCTAssertEqual(b.answer(["op": "get", "name": "keys"])["value"] as? String, "{\"sign\":\"secret\"}", "a new page load reads once again")
    }

    func testNoKeysIsAnAnswerAndCountsAsTheRead() {
        let b = bridge()
        let first = b.answer(["op": "get", "name": "keys"])
        XCTAssertTrue(first["value"] is NSNull, "none is null")
        XCTAssertNil(first["error"])
        XCTAssertNotNil(b.answer(["op": "get", "name": "keys"])["error"], "still once per load")
    }

    func testOtherNamesAreReadAsOftenAsAsked() {
        let store = MemoryStore()
        store.items["log"] = "[]"
        let b = bridge(store)
        for _ in 0..<3 { XCTAssertEqual(b.answer(["op": "get", "name": "log"])["value"] as? String, "[]") }
    }

    func testAKeychainFailureIsAnErrorNeverNone() {
        let store = MemoryStore()
        store.failing = errSecInteractionNotAllowed // locked before the first unlock
        let b = bridge(store)
        for name in KeystoreBridge.names {
            let reply = b.answer(["op": "get", "name": name])
            XCTAssertNil(reply["value"], "\(name): no value at all, not null")
            XCTAssertTrue((reply["error"] as? String)?.contains("\(errSecInteractionNotAllowed)") == true, "\(name): the status is named")
        }
        XCTAssertNotNil(b.answer(["op": "put", "name": "log", "value": "[]"])["error"])
        XCTAssertNotNil(b.answer(["op": "remove", "name": "log"])["error"])
    }

    func testAFailedReadOfKeysDoesNotUseUpTheLoad() {
        let store = MemoryStore()
        store.items["keys"] = "k"
        store.failing = errSecInteractionNotAllowed
        let b = bridge(store)
        XCTAssertNotNil(b.answer(["op": "get", "name": "keys"])["error"])
        store.failing = nil
        XCTAssertEqual(b.answer(["op": "get", "name": "keys"])["value"] as? String, "k", "nothing was handed out, so the page may ask again")
    }

    func testKeysAreWrittenOnlyAsAFirstIdentity() {
        let store = MemoryStore()
        let b = bridge(store)
        XCTAssertNotNil(b.answer(["op": "put", "name": "keys", "value": "unread"])["error"], "not before this load read that there are none")
        XCTAssertTrue(b.answer(["op": "get", "name": "keys"])["value"] is NSNull)
        XCTAssertNil(b.answer(["op": "put", "name": "keys", "value": "first"])["error"], "none at this load's read: a first identity")
        XCTAssertNotNil(b.answer(["op": "put", "name": "keys", "value": "attacker"])["error"], "never replaced")
        XCTAssertEqual(store.items["keys"], "first")
        b.pageLoaded()
        XCTAssertEqual(b.answer(["op": "get", "name": "keys"])["value"] as? String, "first")
        XCTAssertNotNil(b.answer(["op": "put", "name": "keys", "value": "attacker"])["error"], "a load that found keys writes none")
        XCTAssertEqual(store.items["keys"], "first")
    }

    func testRemoveThenPutInTheSameLoadIsRefused() {
        let store = MemoryStore()
        store.items["keys"] = "mine"
        let b = bridge(store)
        XCTAssertEqual(b.answer(["op": "get", "name": "keys"])["value"] as? String, "mine")
        XCTAssertNil(b.answer(["op": "remove", "name": "keys"])["error"], "forgetting removes them")
        XCTAssertNotNil(b.answer(["op": "put", "name": "keys", "value": "chosen"])["error"], "page code cannot remove and then choose the keys")
        XCTAssertNil(store.items["keys"], "nothing was written")
        // Forget this phone: the page loads again, finds none, and makes a first identity.
        b.pageLoaded()
        XCTAssertTrue(b.answer(["op": "get", "name": "keys"])["value"] is NSNull)
        XCTAssertNil(b.answer(["op": "put", "name": "keys", "value": "new"])["error"])
        XCTAssertEqual(store.items["keys"], "new")
    }

    func testAFailedReadOfKeysAllowsNoPut() {
        let store = MemoryStore()
        store.failing = errSecInteractionNotAllowed
        let b = bridge(store)
        XCTAssertNotNil(b.answer(["op": "get", "name": "keys"])["error"])
        store.failing = nil
        XCTAssertNotNil(b.answer(["op": "put", "name": "keys", "value": "x"])["error"], "a Keychain that could not answer never counts as none")
        XCTAssertNil(store.items["keys"])
    }

    func testOnlyTheFiveNamesAndOnlyText() {
        let store = MemoryStore()
        let b = bridge(store)
        for name in ["", "keys ", "KEYS", "other", "../keys"] {
            XCTAssertNotNil(b.answer(["op": "get", "name": name])["error"], name)
            XCTAssertNotNil(b.answer(["op": "put", "name": name, "value": "x"])["error"], name)
        }
        XCTAssertNotNil(b.answer(["op": "get"])["error"], "no name")
        XCTAssertNotNil(b.answer(["op": "put", "name": "log", "value": 5])["error"], "not text")
        XCTAssertNotNil(b.answer(["op": "steal", "name": "keys"])["error"])
        XCTAssertNotNil(b.answer("keys")["error"])
        XCTAssertTrue(store.items.isEmpty)
    }

    func testTheKeychainBridgeAnswersNothingElse() {
        for op in ["hub", "deviceName", "post", "open"] { XCTAssertNotNil(bridge().answer(["op": op])["error"], op) }
    }
}

final class HubLinkTests: XCTestCase {
    func testThePageNamesAPathOnTheOneHubAndNothingElse() {
        let link = HubLink(hub: URL(string: "https://tomcamp.tech")!)
        XCTAssertEqual(link.url("/api/salt")?.absoluteString, "https://tomcamp.tech/api/salt")
        XCTAssertEqual(link.url("/ws", socket: true)?.absoluteString, "wss://tomcamp.tech/ws")
        let test = HubLink(hub: URL(string: "https://192.168.0.35:4790")!)
        XCTAssertEqual(test.url("/ws", socket: true)?.absoluteString, "wss://192.168.0.35:4790/ws")
        XCTAssertEqual(HubLink.posts, ["/api/salt", "/api/login"], "registration, invites and recovery are never sent from the phone")
    }

    func testRefusesAnyOtherRequest() {
        let link = HubLink(hub: URL(string: "https://tomcamp.tech")!)
        let asks: [Any] = [
            ["op": "post", "path": "/api/register", "body": "{}"],
            ["op": "post", "path": "https://evil.example/api/login", "body": "{}"],
            ["op": "post", "path": "/api/login"],
            ["op": "post", "path": "/api/login", "body": String(repeating: "x", count: HubLink.maxBody + 1)],
            ["op": "send", "id": 1, "text": "x"],
            ["op": "fetch", "url": "https://evil.example"],
            "post",
        ]
        for ask in asks {
            var replied: [String: Any]?
            link.answer(ask) { replied = $0 }
            XCTAssertNotNil(replied?["error"], String(describing: ask))
        }
    }

    func testHubOrigin() {
        XCTAssertEqual(Hub.origin(URL(string: "https://tomcamp.tech")!), "https://tomcamp.tech")
        XCTAssertEqual(Hub.origin(URL(string: "https://192.168.0.35:4790/")!), "https://192.168.0.35:4790")
    }
}

final class BundlePageTests: XCTestCase {
    func testOnlyPlainNamesOnTheAppsOwnHost() {
        XCTAssertEqual(BundlePage.fileName(URL(string: "omni-agent://app/phone.js")!), "phone.js")
        XCTAssertEqual(BundlePage.fileName(URL(string: "omni-agent://app/login-worker.js?x=1")!), "login-worker.js")
        for text in ["omni-agent://app/", "omni-agent://app/../Info.plist", "omni-agent://app/a/b.js", "omni-agent://app/.hidden",
                     "omni-agent://other/phone.js", "omni-agent://app:1/phone.js", "https://app/phone.js", "omni-agent://app/%2e%2e%2fx",
                     "omni-agent://u@app/phone.js"] {
            XCTAssertNil(BundlePage.fileName(URL(string: text)!), text)
        }
    }

    func testTheMainFrameShowsOnlyTheStart() {
        XCTAssertTrue(BundlePage.isStart(URL(string: "omni-agent://app/phone.html")!))
        for text in ["omni-agent://app/index.html", "omni-agent://app/", "https://tomcamp.tech/", "omni-agent://evil/phone.html", "about:blank",
                     "omni-agent://app/phone.html?x=1", "omni-agent://app/phone.html?", "omni-agent://app/phone.html#top", "omni-agent://app/phone.html#",
                     "omni-agent://u@app/phone.html", "omni-agent://app:2/phone.html"] {
            XCTAssertFalse(BundlePage.isStart(URL(string: text)!), text)
        }
    }

    func testThePolicyIsTheWebPagesWithNothingToConnectTo() {
        let policy = BundlePage.policy
        for part in ["default-src 'none'", "script-src 'self'", "worker-src 'self'", "style-src 'self'", "img-src 'self' blob: data:",
                     "media-src 'self' blob:", "connect-src 'self';", "frame-ancestors 'none'",
                     "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"] {
            XCTAssertTrue(policy.contains(part), part)
        }
        XCTAssertFalse(policy.contains("unsafe"), "no unsafe-inline, no unsafe-eval")
        XCTAssertFalse(policy.contains("http"), "no server at all: the hub is reached through the bridge")
    }

    func testAReleaseBuildHasTheOneRealHub() {
        XCTAssertEqual(Hub.release.absoluteString, "https://tomcamp.tech")
        #if !DEBUG
        XCTAssertEqual(Hub.current, Hub.release)
        #endif
    }
}

/// The real Keychain, in the simulator: an item written is read back, a missing one is none, and its protection is this device only.
final class KeychainTests: XCTestCase {
    private let keychain = Keychain(service: "tech.tomcamp.omniagent.tests.\(UUID().uuidString)")

    override func tearDown() {
        for name in KeystoreBridge.names { try? keychain.delete(name) }
    }

    func testWriteReadReplaceDelete() throws {
        XCTAssertNil(try keychain.read("log"))
        try keychain.write("log", "[1]")
        XCTAssertEqual(try keychain.read("log"), "[1]")
        try keychain.write("log", "[1,2]")
        XCTAssertEqual(try keychain.read("log"), "[1,2]")
        try keychain.delete("log")
        XCTAssertNil(try keychain.read("log"))
        try keychain.delete("log")
    }

    func testThisDeviceOnlyAndNeverSynced() throws {
        try keychain.write("state", "{}")
        let ask: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychain.service, kSecAttrAccount as String: "state",
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        var found: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(ask as CFDictionary, &found), errSecSuccess)
        let attributes = try XCTUnwrap(found as? [String: Any])
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertNotEqual(attributes[kSecAttrSynchronizable as String] as? Bool, true)
    }
}
