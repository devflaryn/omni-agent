// Omni Agent.app: a native window on Omni's own local server.
//
// The app runs `node <bundle>/Contents/Resources/app/mac/launch.mjs` (the system's Node, found the way a Terminal would find it),
// waits for its one OMNI-READY line, and shows the page it names in a WKWebView. That line carries the window token, which only this
// window ever sees. Quitting closes the server's stdin, which stops it and its children; anything left in its process group after a
// grace period is killed. Closing the window only hides it: the Mac stays reachable from the account's other devices until Cmd-Q.
//
// Built by mac/make-app.sh with swiftc alone (no Xcode project). Test hook: OMNI_SHELL_AUTOMATION=<dir> (see Automation below).
import AppKit
import Darwin
import WebKit

let appName = "Omni Agent"
let defaults = UserDefaults.standard
let env = ProcessInfo.processInfo.environment
let fm = FileManager.default
let homeDir = env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()

// MARK: - Colours: the page's own ground colour, so the title bar and the first frame never flash another one.

enum Theme: String { case dark, light, system }

func groundColor(dark: Bool) -> NSColor {
    dark ? NSColor(srgbRed: 0x21 / 255.0, green: 0x21 / 255.0, blue: 0x21 / 255.0, alpha: 1) : .white
}

let systemGround = NSColor(name: nil) { appearance in
    groundColor(dark: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
}

// MARK: - Finding Node

/// The PATH a login shell would have: an app started from the Dock gets launchd's bare PATH, without Homebrew, nvm or npm's bin.
func loginShellPath() -> String? {
    let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: shell)
    p.arguments = ["-l", "-c", "printf '%s' \"$PATH\""]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let done = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in done.signal() }
    if done.wait(timeout: .now() + 4) == .timedOut { p.terminate(); return nil }
    let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return text.isEmpty ? nil : text
}

/// The PATH the server and its agents get, and the node binary to run. Nil node: not installed anywhere we know.
func resolveNode() -> (node: String?, path: String) {
    var dirs: [String] = []
    if let login = loginShellPath() { dirs += login.split(separator: ":").map(String.init) }
    dirs += ["/opt/homebrew/bin", "/usr/local/bin", "\(homeDir)/.volta/bin", "\(homeDir)/.local/bin"]
    for base in ["\(homeDir)/.nvm/versions/node", "\(homeDir)/.fnm/node-versions", "\(homeDir)/.local/share/fnm/node-versions"] {
        let versions = ((try? fm.contentsOfDirectory(atPath: base)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        for v in versions { dirs += ["\(base)/\(v)/bin", "\(base)/\(v)/installation/bin"] }
    }
    dirs += (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
    var seen = Set<String>()
    dirs = dirs.filter { !$0.isEmpty && seen.insert($0).inserted }
    let path = dirs.joined(separator: ":")
    if let forced = env["OMNI_NODE"], fm.isExecutableFile(atPath: forced) { return (forced, path) }
    let node = dirs.map { "\($0)/node" }.first { fm.isExecutableFile(atPath: $0) }
    return (node, path)
}

// MARK: - The server process

final class Server {
    enum Event { case ready(URL, attached: Bool), failed(String), exited(Int32) }

    private(set) var pid: pid_t = 0
    private var stdinWrite: Int32 = -1
    private var exitSource: DispatchSourceProcess?
    private var buffer = Data()
    private var log: FileHandle?
    private var announced = false
    var running: Bool { pid > 0 }
    let onEvent: (Event) -> Void

    init(onEvent: @escaping (Event) -> Void) { self.onEvent = onEvent }

    func start(node: String, script: String, args: [String], environment: [String: String], logURL: URL) throws {
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        log = try? FileHandle(forWritingTo: logURL)
        _ = try? log?.seekToEnd()
        log?.write("\n--- \(appName) \(Date()) ---\n".data(using: .utf8)!)

        var inPipe: [Int32] = [0, 0], outPipe: [Int32] = [0, 0]
        guard pipe(&inPipe) == 0, pipe(&outPipe) == 0 else { throw NSError(domain: "omni", code: 1, userInfo: [NSLocalizedDescriptionKey: "pipe() failed"]) }
        let logFD = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0)
        posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
        posix_spawn_file_actions_adddup2(&actions, logFD >= 0 ? logFD : outPipe[1], 2)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        // Its own process group, so whatever it leaves behind can be found and stopped; and no other descriptor of ours leaks in.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)

        let argv = ([node, script] + args).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attr)
        }
        var child: pid_t = 0
        let rc = posix_spawn(&child, node, &actions, &attr, argv, envp)
        close(inPipe[0]); close(outPipe[1])
        if logFD >= 0 { close(logFD) }
        guard rc == 0 else {
            close(inPipe[1]); close(outPipe[0])
            throw NSError(domain: "omni", code: Int(rc), userInfo: [NSLocalizedDescriptionKey: "Could not start \(node): \(String(cString: strerror(rc)))"])
        }
        pid = child
        stdinWrite = inPipe[1]
        _ = fcntl(stdinWrite, F_SETFD, FD_CLOEXEC)

        let out = FileHandle(fileDescriptor: outPipe[0], closeOnDealloc: true)
        out.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.take(chunk) }
        }
        let source = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var status: Int32 = 0
            waitpid(child, &status, 0)
            self.exitSource?.cancel()
            self.exitSource = nil
            // Anything still in its group (an agent it could not stop) goes with it.
            kill(-child, SIGTERM)
            self.pid = 0
            self.closeStdin()
            self.onEvent(.exited(status))
        }
        exitSource = source
        source.resume()
    }

    private func take(_ chunk: Data) {
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            let text = String(decoding: line, as: UTF8.self)
            if !announced, text.hasPrefix("OMNI-READY "), let obj = json(text.dropFirst(11)), let s = obj["url"] as? String, let url = URL(string: s) {
                announced = true // never logged: it holds the window token
                onEvent(.ready(url, attached: obj["attached"] as? Bool ?? false))
            } else if text.hasPrefix("OMNI-FAIL "), let obj = json(text.dropFirst(10)) {
                onEvent(.failed(obj["message"] as? String ?? "The server did not start."))
            } else {
                log?.write(line + Data([0x0A]))
            }
        }
    }

    private func json(_ s: Substring) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any]
    }

    private func closeStdin() {
        if stdinWrite >= 0 { close(stdinWrite); stdinWrite = -1 }
    }

    /// Asks the server to stop (its stdin closes), then kills its group if it has not gone within `grace` seconds.
    func stop(grace: TimeInterval = 8, then done: @escaping () -> Void) {
        guard pid > 0 else { done(); return }
        let target = pid
        closeStdin()
        let deadline = Date().addingTimeInterval(grace)
        func check() {
            if pid == 0 { done(); return }
            if Date() > deadline {
                kill(-target, SIGKILL)
                kill(target, SIGKILL)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { done() }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: check)
        }
        check()
    }
}

// MARK: - The window

final class WebWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    let window: NSWindow
    let webView: WKWebView
    private let spinner = NSProgressIndicator()
    private var titleObservation: NSKeyValueObservation?
    var origin: (host: String, port: Int)?
    var shownOnce = false

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        config.userContentController.add(WeakHandler(self), name: "omniShell")

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground") // the window's ground shows until the page paints
        if #available(macOS 13.3, *) { webView.isInspectable = env["OMNI_INSPECTABLE"] == "1" }
        webView.alphaValue = 0

        window.title = appName
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.minSize = NSSize(width: 720, height: 520)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        webView.addSubview(spinner)
        NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: webView.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: webView.centerYAnchor)])
        applyTheme(Theme(rawValue: defaults.string(forKey: "theme") ?? "") ?? .dark, resolvedDark: nil)
        if !window.setFrameUsingName("OmniAgentMain") { window.center() }
        window.setFrameAutosaveName("OmniAgentMain")
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] wv, _ in
            let t = wv.title ?? ""
            self?.window.title = t.isEmpty ? appName : t // shown in the Window menu, Mission Control and the Dock's menu
        }
    }

    func showWaiting() {
        window.makeKeyAndOrderFront(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.webView.alphaValue == 0 else { return }
            self.spinner.startAnimation(nil)
        }
    }

    func load(_ url: URL) {
        if let host = url.host, let port = url.port { origin = (host, port) }
        webView.load(URLRequest(url: url))
    }

    // Theme: what the page chose. System leaves the window to follow macOS.
    func applyTheme(_ choice: Theme, resolvedDark: Bool?) {
        switch choice {
        case .system:
            window.appearance = nil
            window.backgroundColor = systemGround
        case .dark, .light:
            let dark = choice == .dark
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.backgroundColor = groundColor(dark: dark)
        }
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = window.backgroundColor }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "omniShell", let body = message.body as? [String: Any] else { return }
        if let raw = body["choice"] as? String, let choice = Theme(rawValue: raw) {
            defaults.set(raw, forKey: "theme")
            applyTheme(choice, resolvedDark: (body["theme"] as? String).map { $0 == "dark" })
        }
    }

    // Navigation: the app's own pages stay here; every other link opens in the default browser.
    private func isOurs(_ url: URL) -> Bool {
        if ["about", "blob", "data"].contains(url.scheme ?? "") { return true }
        guard let o = origin else { return false }
        return url.scheme == "http" && url.host == o.host && url.port == o.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if #available(macOS 11.3, *), action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isOurs(url) { decisionHandler(.allow); return }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if #available(macOS 11.3, *), !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") { decisionHandler(.download); return }
        decisionHandler(.allow)
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    @available(macOS 11.3, *)
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: homeDir)
        let name = (suggestedFilename as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var target = dir.appendingPathComponent(name)
        var n = 2
        while fm.fileExists(atPath: target.path) {
            target = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        completionHandler(target)
    }

    @available(macOS 11.3, *)
    func downloadDidFinish(_ download: WKDownload) {
        // The Dock's Downloads stack bounces, as for a browser download.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimation(nil)
        if webView.alphaValue == 0 { webView.animator().alphaValue = 1 }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // window.open and target=_blank: ours load here, the rest in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isOurs(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // alert(), confirm(), prompt() as sheets on this window.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // Closing the window hides it: this Mac stays a machine the account's other devices can reach. Cmd-Q stops it.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func run(js: String) { webView.evaluateJavaScript(js, completionHandler: nil) }
}

/// WKUserContentController holds its handlers strongly.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}

// MARK: - The app

final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: WebWindowController!
    var server: Server!
    var quitting = false
    var automation: Automation?
    let dataDir = URL(fileURLWithPath: env["OMNI_DATA_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? "\(homeDir)/Library/Application Support/\(appName)")
    var logURL: URL { dataDir.appendingPathComponent("omni.log") }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // One Omni Agent at a time: a second launch brings the first forward.
        let me = NSRunningApplication.current
        if let id = Bundle.main.bundleIdentifier,
           let other = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != me.processIdentifier }) {
            other.activate(options: [])
            exit(0)
        }
        NSApp.mainMenu = buildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = WebWindowController()
        controller.showWaiting()
        if let dir = env["OMNI_SHELL_AUTOMATION"], !dir.isEmpty { automation = Automation(dir: URL(fileURLWithPath: dir), app: self) }
        server = Server { [weak self] in self?.serverEvent($0) }
        NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    func startServer() {
        DispatchQueue.global(qos: .userInitiated).async {
            let (node, path) = resolveNode()
            DispatchQueue.main.async { self.spawn(node: node, path: path) }
        }
    }

    private func spawn(node: String?, path: String) {
        guard let node else {
            fail("Node.js was not found.", detail: "Omni Agent runs on Node 22 or newer. Install it with Homebrew (brew install node) or from nodejs.org, then open Omni Agent again.")
            return
        }
        guard let script = Bundle.main.resourceURL?.appendingPathComponent("app/mac/launch.mjs").path else { return }
        var childEnv = env
        childEnv["PATH"] = path
        childEnv.removeValue(forKey: "OMNI_SHELL_AUTOMATION")
        childEnv["OMNI_APP"] = "mac"
        do {
            try server.start(node: node, script: script, args: ["--data", dataDir.path], environment: childEnv, logURL: logURL)
        } catch {
            fail("The server could not be started.", detail: error.localizedDescription)
        }
    }

    func serverEvent(_ event: Server.Event) {
        switch event {
        case .ready(let url, _):
            controller.load(url)
        case .failed(let message):
            fail("Omni Agent could not start.", detail: message)
        case .exited(let status):
            if quitting { return }
            let a = NSAlert()
            a.messageText = "The Omni Agent server stopped."
            a.informativeText = "It exited with status \(status). Its log is \(logURL.path)."
            a.addButton(withTitle: "Start It Again")
            a.addButton(withTitle: "Quit")
            if a.runModal() == .alertFirstButtonReturn { startServer() } else { NSApp.terminate(nil) }
        }
    }

    func fail(_ title: String, detail: String) {
        quitting = true
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = title
        a.informativeText = detail
        a.addButton(withTitle: "Quit")
        a.addButton(withTitle: "Show Log")
        if a.runModal() == .alertSecondButtonReturn { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
        server.stop { NSApp.terminate(nil) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        guard server?.running == true else { return .terminateNow }
        server.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // Menu actions
    @objc func showWindow() { controller.window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func openSettings() { showWindow(); controller.run(js: "document.getElementById('btnSettings')?.click()") }
    @objc func newChat() { showWindow(); controller.run(js: "document.getElementById('brand')?.click()") }
    @objc func reload() { controller.webView.reload() }
    @objc func actualSize() { controller.webView.pageZoom = 1 }
    @objc func zoomIn() { controller.webView.pageZoom = min(3, controller.webView.pageZoom + 0.1) }
    @objc func zoomOut() { controller.webView.pageZoom = max(0.5, controller.webView.pageZoom - 0.1) }
    @objc func showLog() { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }

    func buildMenu() -> NSMenu {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = m
            main.addItem(holder)
            return m
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        let services = NSMenu(title: "Services")
        let servicesItem = item("Services", nil)
        servicesItem.submenu = services
        NSApp.servicesMenu = services
        _ = submenu(appName, [
            item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Settings…", #selector(openSettings), ",", target: self),
            .separator(),
            servicesItem,
            .separator(),
            item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("File", [
            item("New Chat", #selector(newChat), "n", target: self),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Delete", #selector(NSText.delete(_:))),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = submenu("View", [
            item("Reload", #selector(reload), "r", target: self),
            .separator(),
            item("Actual Size", #selector(actualSize), "0", target: self),
            item("Zoom In", #selector(zoomIn), "+", target: self),
            item("Zoom Out", #selector(zoomOut), "-", target: self),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let window = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item(appName, #selector(showWindow), "0", [.command, .option], target: self),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.windowsMenu = window
        let help = submenu("Help", [item("Show the Server Log", #selector(showLog), target: self)])
        NSApp.helpMenu = help
        return main
    }
}

// MARK: - Automation (tests and screenshots only)
//
// Off unless OMNI_SHELL_AUTOMATION names a folder at launch. Then the app writes window.json there ({ "pid", "window" }: the
// window number for `screencapture -l`), runs each <name>.js dropped in it as an async function body in the page, and writes
// <name>.out with { "ok", "value" | "error" }. <name>.cmd holds one native word: show, hide (as the close button does) or quit (as Cmd-Q does).
// Anyone who can set an app's environment at launch can already run code as this user, so this opens nothing new.

final class Automation {
    let dir: URL
    weak var app: AppDelegate?
    var timer: Timer?

    init(dir: URL, app: AppDelegate) {
        self.dir = dir
        self.app = app
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        writeInfo()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.poll() }
    }

    func writeInfo() {
        guard let w = app?.controller.window else { return }
        let info: [String: Any] = ["pid": getpid(), "window": w.windowNumber]
        if let d = try? JSONSerialization.data(withJSONObject: info) { try? d.write(to: dir.appendingPathComponent("window.json"), options: .atomic) }
    }

    func write(_ name: String, _ obj: [String: Any]) {
        let safe = JSONSerialization.isValidJSONObject(obj) ? obj : ["ok": obj["ok"] ?? false, "value": String(describing: obj["value"] ?? "")]
        if let d = try? JSONSerialization.data(withJSONObject: safe) { try? d.write(to: dir.appendingPathComponent("\(name).out"), options: .atomic) }
    }

    func poll() {
        guard let app, let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
        for f in files where ["js", "cmd"].contains(f.pathExtension) {
            guard let body = try? String(contentsOf: f, encoding: .utf8) else { continue }
            try? fm.removeItem(at: f)
            let name = f.deletingPathExtension().lastPathComponent
            if f.pathExtension == "cmd" {
                switch body.trimmingCharacters(in: .whitespacesAndNewlines) {
                case "show": app.showWindow()
                case "hide": app.controller.window.performClose(nil)
                case "quit": NSApp.terminate(nil)
                default: break
                }
                writeInfo()
                write(name, ["ok": true])
                continue
            }
            app.controller.webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
                switch result {
                case .success(let v): self?.write(name, ["ok": true, "value": v])
                case .failure(let e): self?.write(name, ["ok": false, "error": "\(e)"])
                }
            }
        }
    }
}

// MARK: - main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
