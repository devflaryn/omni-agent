// The page's only way out: the `net` bridge, which talks to the one hub this build names and to nothing else.
//
// Why native and not the web view's own fetch and WebSocket: the page's origin is omni-agent://app, and a browser engine tells the
// hub so in an Origin header, which the hub refuses unless it was told about that origin. From here there is no Origin header, as
// from the desktop app, so the app works with the hub as deployed. It also means the page's policy can forbid every connection.
//
// What the page can ask (ui/phone-net.js holds the other end):
//   {op: "post", path, body}   one JSON POST to the hub, only to /api/salt or /api/login. Reply {value: {status, body}}.
//   {op: "open", id}           a WebSocket to the hub's /ws. Events come back as globalThis.__omniNet(id, kind, data), kind being
//                              "open", "message" (text) or "close" (the close code: the hub's own 44xx codes mean something).
//   {op: "send", id, text}     one text frame. Replies once it has gone.
//   {op: "close", id}          closes it.
// Each page load starts with no sockets: whatever the last load opened is closed.
//
// Trust: a release build trusts the hub's certificate as iOS does, and nothing else. A debug build launched for a test hub with
// -OmniHubCA trusts that one throwaway CA for that hub only (see Hub in WebShell.swift); none of that code is in a release build.
import Foundation
import WebKit

final class HubLink: NSObject, URLSessionWebSocketDelegate {
    static let posts: Set<String> = ["/api/salt", "/api/login"]
    /// The hub's own ceiling on a frame is lower; this only keeps URLSession's 1 MB default from cutting a long chat page.
    static let maxMessage = 32 * 1024 * 1024
    static let maxBody = 64 * 1024

    let hub: URL
    weak var webView: WKWebView?
    private var session: URLSession!
    private var sockets: [Int: URLSessionWebSocketTask] = [:]
    #if DEBUG
    private let testCA: SecCertificate?
    #endif

    #if DEBUG
    init(hub: URL, testCA: SecCertificate? = nil) {
        self.hub = hub
        self.testCA = testCA
        super.init()
        start()
    }
    #else
    init(hub: URL) {
        self.hub = hub
        super.init()
        start()
    }
    #endif

    private func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    /// The hub's address for a path. Only the hub's own scheme, host and port: the page names a path and nothing else.
    func url(_ path: String, socket: Bool = false) -> URL? {
        guard var parts = URLComponents(url: hub, resolvingAgainstBaseURL: false) else { return nil }
        if socket { parts.scheme = parts.scheme == "http" ? "ws" : "wss" }
        parts.path = path
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    func pageLoaded() {
        for task in sockets.values { task.cancel(with: .goingAway, reason: nil) }
        sockets.removeAll()
    }

    func answer(_ body: Any, reply: @escaping ([String: Any]) -> Void) {
        guard let ask = body as? [String: Any], let op = ask["op"] as? String else { return reply(["error": "Not a request."]) }
        switch op {
        case "post":
            guard let path = ask["path"] as? String, HubLink.posts.contains(path), let text = ask["body"] as? String, text.utf8.count <= HubLink.maxBody, let target = url(path) else {
                return reply(["error": "The app sends nothing like that to the hub."])
            }
            var request = URLRequest(url: target)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(text.utf8)
            session.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    guard error == nil, let http = response as? HTTPURLResponse else { return reply(["error": "The hub cannot be reached."]) }
                    reply(["value": ["status": http.statusCode, "body": String(data: data ?? Data(), encoding: .utf8) ?? ""]])
                }
            }.resume()
        case "open":
            guard let id = ask["id"] as? Int, sockets[id] == nil, let target = url("/ws", socket: true) else { return reply(["error": "Not a socket the app can open."]) }
            let task = session.webSocketTask(with: target)
            task.maximumMessageSize = HubLink.maxMessage
            sockets[id] = task
            task.resume()
            receive(id, task)
            reply(["value": NSNull()])
        case "send":
            guard let id = ask["id"] as? Int, let text = ask["text"] as? String, let task = sockets[id] else { return reply(["error": "That socket is not open."]) }
            task.send(.string(text)) { error in
                DispatchQueue.main.async { reply(error == nil ? ["value": NSNull()] : ["error": "The frame did not go."]) }
            }
        case "close":
            guard let id = ask["id"] as? Int else { return reply(["error": "Not a socket."]) }
            if let task = sockets[id] {
                task.cancel(with: .normalClosure, reason: nil)
                finish(id, 1000)
            }
            reply(["value": NSNull()])
        default:
            reply(["error": "Nothing here answers \(op)."])
        }
    }

    private func receive(_ id: Int, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.sockets[id] === task else { return }
                switch result {
                case .success(.string(let text)):
                    self.deliver(id, "message", text)
                    self.receive(id, task)
                case .success:
                    task.cancel(with: .unsupportedData, reason: nil)
                    self.finish(id, 1003)
                case .failure:
                    self.finish(id, task.closeCode == .invalid ? 1006 : task.closeCode.rawValue)
                }
            }
        }
    }

    private func id(of task: URLSessionTask) -> Int? {
        sockets.first { $0.value === task }?.key
    }

    private func finish(_ id: Int, _ code: Int) {
        guard sockets.removeValue(forKey: id) != nil else { return }
        deliver(id, "close", code)
    }

    private func deliver(_ id: Int, _ kind: String, _ data: Any?) {
        webView?.callAsyncJavaScript("globalThis.__omniNet?.(id, kind, data)", arguments: ["id": id, "kind": kind, "data": data ?? NSNull()], in: nil, in: .page, completionHandler: nil)
    }

    // MARK: URLSession

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        if let id = id(of: webSocketTask) { deliver(id, "open", nil) }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if let id = id(of: webSocketTask) { finish(id, closeCode == .invalid ? 1006 : closeCode.rawValue) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let socket = task as? URLSessionWebSocketTask, let id = id(of: socket) else { return }
        finish(id, socket.closeCode == .invalid ? 1006 : socket.closeCode.rawValue)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        #if DEBUG
        if let ca = testCA, challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           challenge.protectionSpace.host == hub.host, let trust = challenge.protectionSpace.serverTrust {
            // The throwaway CA, alone: not the system's roots as well.
            SecTrustSetAnchorCertificates(trust, [ca] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
            var error: CFError?
            if SecTrustEvaluateWithError(trust, &error) { return completionHandler(.useCredential, URLCredential(trust: trust)) }
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        #endif
        completionHandler(.performDefaultHandling, nil)
    }
}
