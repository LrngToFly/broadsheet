// The Admin window: a sidebar of pages. A1 has Status and Log; later milestones add Sources, Sections, Rules…
import AdminCore
import SwiftUI

enum Page: String, CaseIterable, Identifiable {
    case status = "Status", log = "Log"
    var id: Self { self }
    var symbol: String { self == .status ? "gauge.with.dots.needle.33percent" : "doc.plaintext" }
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
