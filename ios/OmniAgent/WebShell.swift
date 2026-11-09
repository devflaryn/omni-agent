// The one screen: a WKWebView showing the bundled page, with four bridges.
//
// - The main frame shows omni-agent://app/phone.html and nothing else. A link the person taps to anywhere else opens in Safari;
//   anything else that tries to navigate away is dropped. No frames, no new windows, no file:// access.
// - The page makes no network request of its own: its policy allows only its own origin (BundleScheme.swift). Everything it says to
//   the hub goes through `net` (HubLink.swift), which talks to the one hub this build names and nothing else.
// - `keystore` keeps what ui/keychain-store.js keeps in the iOS Keychain (Keystore.swift).
// - `shell` answers which hub, the phone's name, and a haptic tap. `omniShell` hears the theme from ui/theme.js.
// - Every bridge answers only the main frame of this page's own origin.
// - confirm(), alert() and prompt() are native alerts, since the page asks before it signs out or forgets this phone.
import SwiftUI
import UIKit
import WebKit

/// The hub this build talks to. A release build has the one real hub and nothing can change it. A debug build may be launched with
/// `-OmniHub <https url>` and `-OmniHubCA <base64 DER>` for a throwaway hub in a test: that CA, and only it, is then trusted for
/// that hub (HubLink.swift). None of this is compiled into a release build.
enum Hub {
    static let release = URL(string: "https://tomcamp.tech")!

    static var current: URL {
        #if DEBUG
        if let text = UserDefaults.standard.string(forKey: "OmniHub"), let url = URL(string: text), url.scheme == "https", url.host != nil,
           url.path.isEmpty || url.path == "/", url.query == nil, url.user == nil {
            return url
        }
        #endif
        return release
    }

    #if DEBUG
    /// The throwaway CA a test hub's certificate is signed by, or nil.
    static var testCA: SecCertificate? {
        guard current != release, let text = UserDefaults.standard.string(forKey: "OmniHubCA"), let der = Data(base64Encoded: text) else { return nil }
        return SecCertificateCreateWithData(nil, der as CFData)
    }
    #endif

    /// The origin as the page names it: scheme, host and a port only when it is not the default.
    static func origin(_ url: URL) -> String {
        var text = "\(url.scheme ?? "https")://\(url.host ?? "")"
        if let port = url.port, port != 443 { text += ":\(port)" }
        return text
    }
}

struct WebShellView: UIViewRepresentable {
    func makeCoordinator() -> Shell { Shell() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Holds a bridge weakly: WKUserContentController keeps a strong reference to what it is handed.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: Shell?
    init(_ target: Shell) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(["error": "The app is closing."], nil) }
        target.received(message, reply: replyHandler)
    }
}

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: Shell?
    init(_ target: Shell) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.heard(message)
    }
}

final class Shell: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let keystore: KeystoreBridge
    private let net: HubLink
    private let hub = Hub.current
    #if DEBUG
    private var drive: Drive?
    #endif

    override init() {
        keystore = KeystoreBridge(store: Keychain(service: "tech.tomcamp.omniagent.keystore"))
        #if DEBUG
        net = HubLink(hub: hub, testCA: Hub.testCA)
        #else
        net = HubLink(hub: hub)
        #endif
        let web = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleScheme(root: web), forURLScheme: BundlePage.scheme)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.dataDetectorTypes = []
        config.allowsInlineMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        config.suppressesIncrementalRendering = true // no half-styled first paint
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        for name in ["keystore", "shell", "net"] {
            config.userContentController.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: name)
        }
        config.userContentController.add(WeakHandler(self), contentWorld: .page, name: "omniShell")
        net.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        paint()
        // The page draws under the bars and keeps its controls clear of them with env(safe-area-inset-*), as on Safari.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        #if DEBUG
        webView.isInspectable = true
        drive = Drive.attach(to: webView, config: config)
        #endif
        webView.load(URLRequest(url: BundlePage.start))
    }

    private func paint() {
        webView.backgroundColor = Look.shared.ground
        webView.scrollView.backgroundColor = Look.shared.ground
    }

    private func fromThisPage(_ message: WKScriptMessage) -> Bool {
        let origin = message.frameInfo.securityOrigin
        return message.webView === webView && message.frameInfo.isMainFrame && origin.protocol == BundlePage.scheme && origin.host == BundlePage.host && origin.port == 0
    }

    fileprivate func received(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard fromThisPage(message) else { return reply(["error": "Only this app's page may ask."], nil) }
        switch message.name {
        case "keystore": reply(keystore.answer(message.body), nil)
        case "net": net.answer(message.body) { reply($0, nil) }
        default: reply(answerShell(message.body), nil)
        }
    }

    private func answerShell(_ body: Any) -> [String: Any] {
        guard let ask = body as? [String: Any], let op = ask["op"] as? String else { return ["error": "Not a request."] }
        switch op {
        case "hub": return ["value": Hub.origin(hub)]
        case "deviceName": return ["value": UIDevice.current.name]
        case "haptic":
            UINotificationFeedbackGenerator().notificationOccurred(ask["kind"] as? String == "warning" ? .warning : .success)
            return ["value": NSNull()]
        default: return ["error": "Nothing here answers \(op)."]
        }
    }

    /// ui/theme.js: {theme, choice}.
    fileprivate func heard(_ message: WKScriptMessage) {
        guard fromThisPage(message), let body = message.body as? [String: Any], let choice = body["choice"] as? String else { return }
        Look.shared.set(choice: choice)
        paint()
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if action.targetFrame?.isMainFrame == true, BundlePage.isStart(url), !action.shouldPerformDownload { return decisionHandler(.allow) }
        openOutside(url, action)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.isForMainFrame && response.canShowMIMEType ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        keystore.pageLoaded()
        net.pageLoaded()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: BundlePage.start))
    }

    /// window.open and target=_blank: never a second web view here.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openOutside(url, action) }
        return nil
    }

    /// Only a link the person tapped, and only to a web address, goes to Safari. Scripts cannot send the person away.
    private func openOutside(_ url: URL, _ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        UIApplication.shared.open(url)
    }

    // MARK: alert, confirm, prompt

    private func present(_ alert: UIAlertController, otherwise: () -> Void) {
        var top = webView.window?.rootViewController
        while let shown = top?.presentedViewController { top = shown }
        guard let top else { return otherwise() }
        top.present(alert, animated: true)
    }

    /// The page's confirm texts are "Question?\n\nWhat it means.": the first line is the title.
    private func split(_ message: String) -> (String?, String) {
        let parts = message.components(separatedBy: "\n\n")
        return parts.count > 1 ? (parts[0], parts.dropFirst().joined(separator: "\n\n")) : (nil, message)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let (title, text) = split(message)
        let alert = UIAlertController(title: title, message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, otherwise: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let (title, text) = split(message)
        let alert = UIAlertController(title: title, message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in completionHandler(true) })
        present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert) { completionHandler(nil) }
    }
}
