// The Settings page (docs/phase-3.md A7): the AI, politeness and the paper. Each change is saved straight away with
// `broadsheet set`, and wins over the config file until you choose the file's value again.
import AdminCore
import SwiftUI

struct SettingsPage: View {
    let agent: AgentModel
    @State private var rows: [SettingRow] = []
    @State private var ai: AIInfo?
    @State private var against = ""
    @State private var message: (text: String, ok: Bool)?
    @State private var working = false

    private func row(_ key: String) -> SettingRow? { rows.first { $0.key == key } }
    private func number(_ key: String) -> Double { row(key)?.value.number ?? 0 }

    var body: some View {
        Form {
            Section {
                if let ai {
                    if !ai.running { Text("Ollama isn't running, so the model can't be changed now.").foregroundStyle(.red) }
                    Picker("Model", selection: Binding(get: { ai.model }, set: { set("ai.model", $0) })) {
                        ForEach(Array(Set(ai.installed + [ai.model])).sorted(), id: \.self) { Text($0).tag($0) }
                    }
                    fileNote("ai.model")
                    Picker("Context size", selection: Binding(get: { Int(number("ai.numCtx")) }, set: { set("ai.numCtx", String($0)) })) {
                        ForEach([8192, 16384, 32768, 65536], id: \.self) { Text("\($0 / 1024)K tokens").tag($0) }
                    }
                    fileNote("ai.numCtx")
                    Text("How much of a newsletter Gemma reads at once. More reads longer posts whole but takes more memory.").font(.caption).foregroundStyle(.secondary)
                } else { ProgressView() }
            } header: { Text("AI") }

            Section {
                if let ai {
                    LabeledContent("Test set", value: ai.evalSet.map { "\($0.count) newsletters, saved \(String($0.savedAt.prefix(10)))" } ?? "None yet")
                    HStack {
                        Button("Save a new test set from today's paper") { run(["eval", "save"], done: "Saved a new test set.") }
                        Spacer()
                    }
                    HStack {
                        Picker("Compare against", selection: $against) {
                            Text("Nothing (just your model)").tag("")
                            ForEach(ai.installed.filter { $0 != ai.model }, id: \.self) { Text($0).tag($0) }
                        }
                        Button("Run the comparison") { runEval() }.disabled(ai.evalSet == nil || !ai.running)
                    }
                    Text("Takes about half a minute per newsletter per model and runs in the background; the page opens in your browser when it's done. To try another model, download it first in Terminal: ollama pull <name>.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let latest = ai.reports.first {
                        Button("Open the latest comparison") { NSWorkspace.shared.open(URL(fileURLWithPath: latest)) }
                    }
                }
            } header: { Text("Compare models") }

            Section {
                Stepper("Idle for \(Int(number("politeness.idleMinutes"))) minutes before Gemma works", value: Binding(get: { number("politeness.idleMinutes") }, set: { set("politeness.idleMinutes", String(Int($0))) }), in: 1...240, step: 5)
                fileNote("politeness.idleMinutes")
                Toggle("A locked screen counts as idle", isOn: Binding(get: { row("politeness.lockedCountsAsIdle")?.value.bool ?? true }, set: { set("politeness.lockedCountsAsIdle", $0 ? "true" : "false") }))
                fileNote("politeness.lockedCountsAsIdle")
                Stepper("Skip AI work when the Mac's load is above \(Int(number("politeness.maxLoad5m")))", value: Binding(get: { number("politeness.maxLoad5m") }, set: { set("politeness.maxLoad5m", String(Int($0))) }), in: 1...32)
                fileNote("politeness.maxLoad5m")
                Picker("While you're at the Mac", selection: Binding(get: { row("politeness.backlog")?.value.string ?? "never-while-active" }, set: { set("politeness.backlog", $0) })) {
                    Text("Gemma always waits").tag("never-while-active")
                    Text("An old backlog trickles, one item per run").tag("trickle")
                }
                if row("politeness.backlog")?.value.string == "trickle" {
                    Stepper("…once items have waited \(Int(number("politeness.backlogHours"))) hours", value: Binding(get: { number("politeness.backlogHours") }, set: { set("politeness.backlogHours", String(Int($0))) }), in: 1...72)
                }
                fileNote("politeness.backlog")
                overnight
            } header: { Text("Sharing the Mac") }

            Section {
                Stepper("Keep \(Int(number("retention.days"))) days in the paper", value: Binding(get: { number("retention.days") }, set: { set("retention.days", String(Int($0))) }), in: 1...14)
                fileNote("retention.days")
                weight("ranking.content", "Interest (Gemma, your words, your topics)")
                weight("ranking.author", "Authors you rate well")
                weight("ranking.freshness", "Freshness")
                weight("ranking.learnedTopics", "How far learned topics can outweigh Gemma")
            } header: { Text("The paper") } footer: {
                Text("The ranking weighs interest, author and freshness against each other; only their proportions matter.").font(.caption).foregroundStyle(.secondary)
            }

            if let message { Text(message.text).foregroundStyle(message.ok ? Color.secondary : Color.red).textSelection(.enabled) }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .toolbar { Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } } }
        .task { await load() }
    }

    @ViewBuilder private var overnight: some View {
        let on = row("politeness.overnightFrom")?.value.number != nil && row("politeness.overnightTo")?.value.number != nil
        Toggle("Rewrite the reader profile only overnight", isOn: Binding(get: { on }, set: { v in
            if v { set("politeness.overnightFrom", "1"); set("politeness.overnightTo", "5") } else { reset("politeness.overnightFrom"); reset("politeness.overnightTo") }
        }))
        if on {
            HStack {
                Picker("From", selection: Binding(get: { Int(number("politeness.overnightFrom")) }, set: { set("politeness.overnightFrom", String($0)) })) {
                    ForEach(0..<24, id: \.self) { Text(String(format: "%02d:00", $0)).tag($0) }
                }
                Picker("to", selection: Binding(get: { Int(number("politeness.overnightTo")) }, set: { set("politeness.overnightTo", String($0)) })) {
                    ForEach(0..<24, id: \.self) { Text(String(format: "%02d:00", $0)).tag($0) }
                }
            }
        }
    }

    @ViewBuilder private func weight(_ key: String, _ label: String) -> some View {
        VStack(alignment: .leading) {
            HStack { Text(label); Spacer(); Text(number(key).formatted(.number.precision(.fractionLength(2)))).monospacedDigit().foregroundStyle(.secondary) }
            Slider(value: Binding(get: { number(key) }, set: { v in
                if let i = rows.firstIndex(where: { $0.key == key }) { rows[i].value = .number((v * 20).rounded() / 20) }
            }), in: 0...1, step: 0.05) { editing in
                if !editing { set(key, String(number(key))) }
            }
            fileNote(key)
        }
    }

    /// "Set here (the file says …) · Use the file's" under a setting Admin changed.
    @ViewBuilder private func fileNote(_ key: String) -> some View {
        if let r = row(key), r.fromAdmin {
            HStack {
                Text("Set here (your config file says \(r.fileValue.map { $0.argument.isEmpty ? "nothing" : $0.argument } ?? "nothing")).").font(.caption).foregroundStyle(.secondary)
                Button("Use the file's") { reset(key) }.buttonStyle(.link).font(.caption)
            }
        }
    }

    private func load() async {
        async let s = agent.run(["settings", "--json"])
        async let a = agent.run(["ai", "--json"])
        if let r = await s { if let v = decodeAnswer([SettingRow].self, from: r.output) { rows = v } else { message = (r.output, false) } }
        if let r = await a { if let v = decodeAnswer(AIInfo.self, from: r.output) { ai = v } else { message = (r.output, false) } }
    }

    private func set(_ key: String, _ value: String) { run(["set", key, value], done: "Saved; it applies from the next run.") }
    private func reset(_ key: String) { run(["set", key, "--reset"], done: "Back to the config file's value.") }

    private func run(_ args: [String], done: String) {
        Task {
            working = true
            defer { working = false }
            guard let r = await agent.run(args) else { message = (agent.lastError ?? "", false); return }
            message = r.ok ? (done, true) : (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false)
            await load()
        }
    }

    /// The comparison takes many minutes: it runs on its own, writes to the agent's log, and opens its page when done.
    private func runEval() {
        guard let command = agent.command else { message = ("The agent isn't scheduled, so Admin can't find it.", false); return }
        do {
            try command.start(["eval", "--open"] + (against.isEmpty ? [] : ["--against", against]))
            message = ("The comparison is running in the background (see the Log page). Its page opens in your browser when it's done.", true)
        } catch {
            message = ("Couldn't start it: \(error.localizedDescription)", false)
        }
    }
}
