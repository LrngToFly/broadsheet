// Broadsheet Admin: a menu-bar item (like a Windows tray icon) and an Admin window (docs/phase-3.md).
import AdminCore
import AppKit
import SwiftUI

@main
struct BroadsheetAdminApp: App {
    @NSApplicationDelegateAdaptor private var app: AppDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(agent: app.agent, openAdmin: { app.showAdmin() })
        } label: {
            Image(systemName: app.agent.state.symbol)
                .accessibilityLabel("The Broadsheet: \(app.agent.state.headline)")
        }
    }
}

/// Owns the Admin window, so it opens whenever you open the app yourself (Spotlight, Finder, the Dock), but not
/// when the app starts at login, when only the menu-bar item should appear.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let agent = AgentModel()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !launchedAsLoginItem() || CommandLine.arguments.contains("--admin") { showAdmin() }
    }

    /// Opened again while already running (e.g. from Spotlight): show the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showAdmin()
        return false
    }

    func showAdmin() {
        if window == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: AdminWindow(agent: agent).frame(minWidth: 720, minHeight: 460)))
            w.title = "Broadsheet Admin"
            w.setContentSize(NSSize(width: 900, height: 600))
            w.styleMask.insert([.resizable, .miniaturizable, .closable, .titled])
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("BroadsheetAdmin")
            if w.frame.origin == .zero { w.center() }
            window = w
        }
        // While the window is open the app shows in the Dock and ⌘-Tab, like any app; it goes back to the menu bar only
        // when the window closes.
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    /// Started by Login Items? (macOS marks that launch with the 'lgit' value on its open-application event.)
    private func launchedAsLoginItem() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == 0x6F61_7070 /* 'oapp' */ else { return false }
        return event.paramDescriptor(forKeyword: 0x7072_6F70 /* 'prop' */)?.enumCodeValue == 0x6C67_6974 /* 'lgit' */
    }
}

/// The menu that drops down from the menu-bar item.
struct MenuContent: View {
    let agent: AgentModel
    let openAdmin: () -> Void

    var body: some View {
        let s = agent.snapshot
        Text(agent.state.headline)
        if case .working(_, _, let title) = agent.state { Text(title) }
        if let last = s.runs.first {
            Text("Last run \(last.startedAt.formatted(.relative(presentation: .named))) · \(last.summary)")
            if !last.errors.isEmpty { Text("⚠️ \(last.errors.count) error\(last.errors.count == 1 ? "" : "s") in the last run") }
        }
        if s.pending > 0 { Text("\(s.pending) waiting for Gemma") }
        if let e = agent.lastError { Text("⚠️ \(e)") }

        Divider()
        Button("Run now") { agent.runNow() }
            .disabled(s.running)
        if s.pausedUntil != nil {
            Button("Resume") { agent.pause("off") }
        } else {
            Button("Pause for 1 hour") { agent.pause("1h") }
            Button("Pause until tomorrow") { agent.pause("tomorrow") }
        }

        Divider()
        Button("Open Admin…") { openAdmin() }
        .keyboardShortcut(",")
        if let reader = agent.locations.readerURL() {
            Link("Open the Broadsheet", destination: reader)
        }
        Divider()
        Button("Quit Broadsheet Admin") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
