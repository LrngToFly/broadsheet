// The Admin window: a sidebar of pages. Status and Log (A1), Sources (A2), Sections (A3), Rules and Hidden (A4)…
import AdminCore
import SwiftUI

enum Page: String, CaseIterable, Identifiable {
    case status = "Status", sources = "Sources", sections = "Sections", rules = "Rules", hidden = "Hidden", log = "Log"
    var id: Self { self }
    var symbol: String {
        switch self {
        case .status: "gauge.with.dots.needle.33percent"
        case .sources: "newspaper"
        case .sections: "rectangle.split.3x1"
        case .rules: "line.3.horizontal.decrease.circle"
        case .hidden: "eye.slash"
        case .log: "doc.plaintext"
        }
    }
}

struct AdminWindow: View {
    let agent: AgentModel
    @State private var page: Page? = .status

    var body: some View {
        NavigationSplitView {
            List(Page.allCases, selection: $page) { p in
                Label(p.rawValue, systemImage: p.symbol)
            }
            .navigationSplitViewColumnWidth(170)
        } detail: {
            switch page ?? .status {
            case .status: StatusPage(agent: agent)
            case .sources: SourcesPage(agent: agent)
            case .sections: SectionsPage(agent: agent)
            case .rules: RulesPage(agent: agent)
            case .hidden: HiddenPage(agent: agent)
            case .log: LogPage(file: agent.command?.logFile.map { URL(fileURLWithPath: $0) } ?? agent.locations.log)
            }
        }
    }
}

// ---- Status ------------------------------------------------------------------------------------------

struct StatusPage: View {
    let agent: AgentModel

    var body: some View {
        let s = agent.snapshot
        Form {
            Section {
                LabeledContent("Now") {
                    Label(agent.state.headline, systemImage: agent.state.symbol)
                }
                if case .working(_, _, let title) = agent.state { LabeledContent("Gemma is reading", value: title) }
                if case .problem(let message) = agent.state { Text(message).foregroundStyle(.red) }
                LabeledContent("Schedule", value: s.installed ? "Every 15 minutes" : "Not scheduled (in Terminal: broadsheet install)")
                LabeledContent("Waiting for Gemma", value: s.pending == 0 ? "Nothing" : "\(s.pending) item\(s.pending == 1 ? "" : "s")")
                if let e = agent.lastError { Text(e).foregroundStyle(.red) }
                HStack {
                    Button("Run now") { agent.runNow() }.disabled(s.running)
                    if s.pausedUntil != nil {
                        Button("Resume") { agent.pause("off") }
                    } else {
                        Button("Pause for 1 hour") { agent.pause("1h") }
                        Button("Pause until tomorrow") { agent.pause("tomorrow") }
                    }
                }
            }

            Section("Recent runs") {
                if s.runs.isEmpty { Text("No runs yet.").foregroundStyle(.secondary) }
                ForEach(s.runs.prefix(20)) { r in RunRow(run: r) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Status")
    }
}

struct RunRow: View {
    let run: RunRecord
    @State private var showErrors = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(run.startedAt.formatted(date: .abbreviated, time: .shortened))
                    .monospacedDigit()
                if let end = run.finishedAt {
                    Text("· \(Int(end.timeIntervalSince(run.startedAt).rounded())) s").foregroundStyle(.secondary)
                }
                Spacer()
                if !run.errors.isEmpty {
                    Button("\(run.errors.count) error\(run.errors.count == 1 ? "" : "s")") { showErrors.toggle() }
                        .buttonStyle(.link)
                        .foregroundStyle(.red)
                }
            }
            Text(run.summary + (run.deferredReason.map { " · Gemma waited: \($0)" } ?? ""))
                .font(.callout)
                .foregroundStyle(.secondary)
            if showErrors {
                ForEach(run.errors, id: \.self) { Text($0).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            }
        }
    }
}

// ---- Log ---------------------------------------------------------------------------------------------

struct LogPage: View {
    let file: URL
    @State private var text = ""

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? "The log is empty." : text)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                Color.clear.frame(height: 1).id("end")
            }
            .onAppear { load(); proxy.scrollTo("end") }
            .onChange(of: text) { proxy.scrollTo("end") }
        }
        .navigationTitle("Log")
        .toolbar {
            Button("Reload", systemImage: "arrow.clockwise") { load() }
            Button("Show in Finder", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([file]) }
        }
    }

    private func load() { text = tail(file) }
}
