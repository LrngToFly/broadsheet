// Broadsheet Admin: a menu-bar item (like a Windows tray icon) and an Admin window (docs/phase-3.md).
import AdminCore
import SwiftUI

@main
struct BroadsheetAdminApp: App {
    @State private var agent = AgentModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(agent: agent)
        } label: {
            Image(systemName: agent.state.symbol)
                .accessibilityLabel("The Broadsheet: \(agent.state.headline)")
        }

        Window("Broadsheet Admin", id: "admin") {
            AdminWindow(agent: agent)
                .frame(minWidth: 720, minHeight: 460)
        }
        .defaultSize(width: 900, height: 600)
    }
}

/// The menu that drops down from the menu-bar item.
struct MenuContent: View {
    let agent: AgentModel
    @Environment(\.openWindow) private var openWindow

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
        Button("Open Admin…") {
            openWindow(id: "admin")
            NSApp.activate()
        }
        .keyboardShortcut(",")
        Link("Open the Broadsheet", destination: URL(string: "https://lrngtofly.github.io/broadsheet/")!)
        Divider()
        Button("Quit Broadsheet Admin") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
