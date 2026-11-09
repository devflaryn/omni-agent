// The page, served from the app's own bundle at omni-agent://app/, never from a server.
//
// SPIKE (2026-11-04, simulator iPhone 17 on iOS 27.0, Xcode 27.1): the custom scheme works, so there is no loopback listener. The page
// at omni-agent://app/phone.html is a secure context (origin "omni-agent://app"). crypto.subtle has Ed25519 and X25519, pkcs8 export
// and import, and a key imported non-extractable refuses export. A module Worker (the login worker) runs scrypt. The policy below
// is enforced, each with a securitypolicyviolation event: an inline <script>, eval, new Function, an <iframe>, and a fetch or a
// WebSocket to anywhere but this origin.
//
// What is served: only the files the build copied into `web/` (dist/ui, as `node scripts/build-ui.mjs --phone` lists them), by a
// single plain name. No folder walk, no "..", no other host. Every answer carries the policy, which is the web page's
// (hub/static.mjs, webPolicy) with nothing to connect to but this origin: the page's only way to the hub is the `net` bridge.
import Foundation
import WebKit

enum BundlePage {
    static let scheme = "omni-agent"
    static let host = "app"
    static let start = URL(string: "omni-agent://app/phone.html")!

    /// The one document the main frame may show.
    static func isStart(_ url: URL) -> Bool {
        url.scheme == scheme && url.host == host && url.port == nil && url.user == nil && url.path == "/phone.html" && url.query == nil && url.fragment == nil
    }

    /// A plain file name from the bundle, or nil.
    static func fileName(_ url: URL) -> String? {
        guard url.scheme == scheme, url.host == host, url.port == nil, url.user == nil else { return nil }
        let name = String(url.path.dropFirst())
        guard !name.isEmpty, name.count < 100, name.first != ".",
              name.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-").contains($0) })
        else { return nil }
        return name
    }

    static let policy = [
        "default-src 'none'",
        "script-src 'self'",
        "worker-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].joined(separator: "; ")

    static let types = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "webmanifest": "application/manifest+json",
    ]

    static let headers = [
        "Content-Security-Policy": policy,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    ]
}

final class BundleScheme: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        guard let name = BundlePage.fileName(url),
              let type = BundlePage.types[(name as NSString).pathExtension.lowercased()],
              let body = try? Data(contentsOf: root.appendingPathComponent(name, isDirectory: false))
        else {
            let missing = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: BundlePage.headers.merging(["Content-Length": "0"]) { $1 })!
            task.didReceive(missing)
            task.didFinish()
            return
        }
        let fields = BundlePage.headers.merging(["Content-Type": type, "Content-Length": String(body.count)]) { $1 }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: fields)!)
        task.didReceive(body)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
