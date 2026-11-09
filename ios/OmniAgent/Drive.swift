// DEBUG BUILDS ONLY: how a test drives the page in the simulator. Nothing here is compiled into a release build.
//
// Launched with `-OmniDrive http://127.0.0.1:<port>`, the app asks that address for a script (GET /next), runs it in the page
// with callAsyncJavaScript, and sends back the result (POST /result). The page's console errors, uncaught errors and policy
// violations go to POST /log. The address is the test's own, on loopback, reached by an ssh tunnel from the PC running the test.
#if DEBUG
import Foundation
import WebKit

final class Drive: NSObject, WKScriptMessageHandler {
    private let base: URL
    private weak var webView: WKWebView?

    /// Watches the page: errors, rejections, policy violations, and how many sockets it opened.
    private static let watcher = """
    (() => {
      const send = (kind, text) => { try { window.webkit.messageHandlers.debuglog.postMessage({ kind, text: String(text).slice(0, 4000) }); } catch {} };
      for (const level of ["error", "warn"]) { const real = console[level]; console[level] = (...args) => { send(level, args.map((a) => a?.stack ?? String(a)).join(" ")); real.apply(console, args); }; }
      addEventListener("error", (e) => send("exception", `${e.message} @ ${e.filename}:${e.lineno}`));
      addEventListener("unhandledrejection", (e) => send("rejection", e.reason?.stack ?? e.reason));
      document.addEventListener("securitypolicyviolation", (e) => send("csp", `${e.violatedDirective} ${e.blockedURI}`));
      window.__wsMade = 0;
      const Real = WebSocket;
      window.WebSocket = class extends Real { constructor(...args) { super(...args); window.__wsMade++; } };
    })();
    """

    static func attach(to webView: WKWebView, config: WKWebViewConfiguration) -> Drive? {
        guard let text = UserDefaults.standard.string(forKey: "OmniDrive"), let base = URL(string: text) else { return nil }
        let drive = Drive(base: base, webView: webView)
        config.userContentController.addUserScript(WKUserScript(source: watcher, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        config.userContentController.add(drive, contentWorld: .page, name: "debuglog")
        Task { @MainActor in await drive.loop() }
        return drive
    }

    private init(base: URL, webView: WKWebView) {
        self.base = base
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("omni-page %@", String(describing: message.body))
        post("log", message.body)
    }

    private func post(_ path: String, _ body: Any) {
        guard JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        URLSession.shared.dataTask(with: request).resume()
    }

    @MainActor private func loop() async {
        var next = URLRequest(url: base.appendingPathComponent("next"))
        next.timeoutInterval = 60
        while true {
            do {
                let (data, response) = try await URLSession.shared.data(for: next)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let command = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = command["id"] as? Int, let js = command["js"] as? String, let webView
                else { continue }
                var reply: [String: Any] = ["id": id]
                do {
                    let value = try await webView.callAsyncJavaScript(js, arguments: [:], in: nil, contentWorld: .page)
                    reply["value"] = (value as? String) ?? NSNull()
                } catch {
                    let info = (error as NSError).userInfo
                    reply["error"] = (info["WKJavaScriptExceptionMessage"] as? String) ?? String(describing: error)
                }
                post("result", reply)
            } catch {
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }
}
#endif
