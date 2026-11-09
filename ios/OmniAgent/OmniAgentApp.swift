// Omni Agent for iPhone: a shell around the bundled UI (see WebShell.swift). It is a client on the account, approved as `full`, and
// hosts nothing. Its code is installed, so a hacked server cannot swap it.
import SwiftUI

@main
struct OmniAgentApp: App {
    @StateObject private var look = Look.shared

    var body: some Scene {
        WindowGroup {
            WebShellView()
                .background(Color(uiColor: look.ground).ignoresSafeArea())
                .ignoresSafeArea()
                .preferredColorScheme(look.scheme)
        }
    }
}

/// The page's theme, as ui/theme.js reports it: Dark (the default), Light, or System. The status bar and the colour around the page
/// follow it. The last choice is kept, so the next launch starts in the right colours before the page has loaded.
final class Look: ObservableObject {
    static let shared = Look()
    private static let key = "theme"

    @Published private(set) var choice: String

    private init() {
        choice = UserDefaults.standard.string(forKey: Look.key) ?? "dark"
    }

    /// nil follows the phone: the page's System.
    var scheme: ColorScheme? {
        switch choice {
        case "light": return .light
        case "system": return nil
        default: return .dark
        }
    }

    /// The page's own background in each theme (theme.js's theme-color), so nothing flashes around it.
    var ground: UIColor {
        UIColor { traits in
            let dark: Bool
            switch self.choice {
            case "light": dark = false
            case "system": dark = traits.userInterfaceStyle != .light
            default: dark = true
            }
            return dark ? UIColor(red: 0x21 / 255, green: 0x21 / 255, blue: 0x21 / 255, alpha: 1) : .white
        }
    }

    func set(choice: String) {
        guard ["dark", "light", "system"].contains(choice), choice != self.choice else { return }
        self.choice = choice
        UserDefaults.standard.set(choice, forKey: Look.key)
    }
}
