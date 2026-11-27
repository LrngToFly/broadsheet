// The Data page (docs/phase-3.md A7): what's stored, export and import, and Forget.
import AdminCore
import AppKit
import SwiftUI

struct DataPage: View {
    let agent: AgentModel
    @State private var store: StorageInfo?
    @State private var prefs: [PreferenceRecord] = []
    @State private var message: (text: String, ok: Bool)?
    @State private var confirmForgetAll = false
    @State private var pendingImport: (path: String, summary: [String: Int])?

    var body: some View {
        Form {
            Section("What's stored on this Mac") {
                if let s = store {
                    LabeledContent("Database", value: formatBytes(s.bytes.database))
                    LabeledContent("Articles (the last few days)", value: formatBytes(s.bytes.articles))
                    LabeledContent("Model comparisons", value: formatBytes(s.bytes.eval))
                    LabeledContent("Logs (14 days)", value: formatBytes(s.bytes.logs))
                    Text(["articles", "newsletters", "rules", "ratings", "mailLog"].compactMap { k in s.counts[k].map { "\($0) \(k == "mailLog" ? "emails in the 90-day log" : k)" } }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                } else { ProgressView() }
            }

            Section {
                HStack {
                    Button("Export…") { exportFile() }
                    Button("Import…") { importFile() }
                }
            } header: { Text("Export and import") } footer: {
                Text("One file with your newsletters, sections, rules, settings, your own words and everything you rated, moved or hid (no article text). Handy for moving to a new Mac. Importing updates and adds; it never deletes. Keep the file private.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                if prefs.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
                ForEach(prefs) { p in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.title).lineLimit(1)
                            Text("\(p.source) · \(p.summary)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button("Forget") { run(["forget", p.id], done: "Forgotten.") }
                    }
                }
                Button("Forget everything learned from you…", role: .destructive) { confirmForgetAll = true }
                    .disabled(prefs.isEmpty)
                    .confirmationDialog("Forget all \(prefs.count) ratings, moves and hides?", isPresented: $confirmForgetAll) {
                        Button("Forget them all", role: .destructive) { run(["forget", "--all"], done: "Forgot everything learned from your ratings. Your own words and rules stay.") }
                    } message: {
                        Text("The ranking starts again from nothing, and the profile Gemma wrote from your ratings is deleted. Your own words and your rules stay. This can't be undone, except from an export.")
                    }
            } header: { Text("What the Broadsheet has learned from you") } footer: {
                Text("Each line is what's kept about one item you rated, moved or hid, after the article itself is gone.").font(.caption).foregroundStyle(.secondary)
            }

            if let message { Text(message.text).foregroundStyle(message.ok ? Color.secondary : Color.red).textSelection(.enabled) }
        }
        .formStyle(.grouped)
        .navigationTitle("Data")
        .toolbar { Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } } }
        .task { await load() }
        .alert("Import this file?", isPresented: Binding(get: { pendingImport != nil }, set: { if !$0 { pendingImport = nil } }), presenting: pendingImport) { p in
            Button("Import") { run(["import", p.path], done: "Imported.") }
            Button("Cancel", role: .cancel) {}
        } message: { p in
            Text("It brings in " + p.summary.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key)" }.joined(separator: ", ") + ", updating what's here with the same ids. Nothing is deleted.")
        }
    }

    private func load() async {
        if let r = await agent.run(["storage", "--json"]), let s = decodeAnswer(StorageInfo.self, from: r.output) { store = s }
        let loc = agent.locations
        if case .success(let p) = await Task.detached(operation: { Result { try Database(path: loc.database.path).preferences() } }).value { prefs = p }
    }

    private func exportFile() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Broadsheet export \(Date.now.formatted(.iso8601.year().month().day())).json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run(["export", url.path], done: "Exported to \(url.lastPathComponent). It holds your ratings and notes: keep it private.")
    }

    private func importFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            guard let r = await agent.run(["import", url.path, "--dry-run", "--json"]) else { return }
            if let s = decodeAnswer([String: Int].self, from: r.output) { pendingImport = (url.path, s) }
            else { message = (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false) }
        }
    }

    private func run(_ args: [String], done: String) {
        Task {
            guard let r = await agent.run(args) else { message = (agent.lastError ?? "", false); return }
            message = r.ok ? (done, true) : (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false)
            await load()
        }
    }
}
