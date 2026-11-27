// The Rules page (docs/phase-3.md A4): your own words, Gemma's suggestions, your rules, and the exact-rule editor.
import AdminCore
import SwiftUI

struct RulesPage: View {
    let agent: AgentModel
    @State private var data: RulesData?
    @State private var words = ""
    @State private var typed = ""
    @State private var message: (text: String, ok: Bool)?
    @State private var working = false
    @State private var editing: ExactRule?
    @State private var rewording: RuleCard?
    @State private var newWording = ""

    var body: some View {
        Form {
            if let data {
                Section {
                    TextEditor(text: $words)
                        .font(.body)
                        .frame(minHeight: 90)
                    HStack {
                        Text("Gemma reads this with every article, before anything it learned from your ratings. After a change it re-scores today's articles while you're away.")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Save") { act([["type": "own-words", "text": words.trimmingCharacters(in: .whitespacesAndNewlines)]], done: "Saved your words.") }
                            .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines) == data.ownWords.text || working)
                    }
                    if let learned = data.learnedProfile {
                        DisclosureGroup("What Gemma has learned from your ratings") {
                            Text(learned.text).textSelection(.enabled).font(.callout)
                        }
                    }
                } header: { Text("In your own words") }

                Section("Suggestions") {
                    if data.suggestions.isEmpty {
                        Text("None waiting. When you hide something, Gemma may suggest a rule here.").foregroundStyle(.secondary)
                    }
                    ForEach(data.suggestions) { s in suggestion(s) }
                }

                Section("Your rules") {
                    if data.rules.isEmpty { Text("No rules yet.").foregroundStyle(.secondary) }
                    ForEach(data.rules) { r in ruleRow(r, exact: data.exact[r.id]) }
                }

                Section("Add a rule") {
                    HStack {
                        TextField("In plain English, e.g. Never show posts about crypto", text: $typed)
                        Button("Draft it") {
                            act([["type": "rule-add", "text": typed.trimmingCharacters(in: .whitespacesAndNewlines)]], done: "Gemma drafts it the next time the Mac is free; it appears under Suggestions.")
                            typed = ""
                        }
                        .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty || working)
                    }
                    Button("New exact rule…", systemImage: "slider.horizontal.3") { editing = ExactRule() }
                    Text("An exact rule matches the sender, subject, list, text, links or length exactly, with no AI, and you can test it against the last 90 days of mail first.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                ProgressView("Asking the agent…")
            }
            if let message { Text(message.text).foregroundStyle(message.ok ? Color.secondary : Color.red).textSelection(.enabled) }
        }
        .formStyle(.grouped)
        .navigationTitle("Rules")
        .toolbar { Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } } }
        .task { await load() }
        .sheet(item: Binding(get: { editing.map(EditingRule.init) }, set: { editing = $0?.rule })) { e in
            RuleEditor(agent: agent, rule: e.rule) { saved in
                editing = nil
                if let saved { message = (saved, true); Task { await load() } }
            }
        }
        .sheet(item: $rewording) { r in
            VStack(alignment: .leading, spacing: 12) {
                Text("Reword “\(r.wording)”").font(.headline)
                Text("Gemma redrafts the rule from your new wording the next time the Mac is free. It stays on meanwhile.").font(.caption).foregroundStyle(.secondary)
                TextField("New wording", text: $newWording, axis: .vertical).lineLimit(2...4)
                HStack {
                    Spacer()
                    Button("Cancel") { rewording = nil }
                    Button("Redraft") {
                        act([["type": "rule-edit", "ruleId": r.id, "text": newWording.trimmingCharacters(in: .whitespacesAndNewlines)]], done: "Gemma redrafts it the next time the Mac is free.")
                        rewording = nil
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(newWording.trimmingCharacters(in: .whitespaces).isEmpty || newWording == r.wording)
                }
            }
            .padding()
            .frame(width: 440)
        }
    }

    @ViewBuilder private func suggestion(_ s: Suggestion) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(s.fromText).font(.caption).foregroundStyle(.secondary)
            switch s.status {
            case "failed": Text("Gemma couldn't draft a rule from this\(s.error.map { ": \($0)" } ?? ".")")
            case "drafting": Text("Gemma is drafting a rule; it's done the next time the Mac is free.").foregroundStyle(.secondary)
            default:
                Text(s.wording ?? "").bold()
                if let d = s.detail { Text("\(s.ruleKind == "check" ? "Exact match" : "Gemma checks for"): \(d) · \(s.source.map { "only \($0)" } ?? "all newsletters")").font(.caption) }
                Text(s.wouldHide.isEmpty ? "Wouldn't hide any current articles." : "Would hide: " + s.wouldHide.map { "\($0.title) (\($0.source))" }.joined(separator: "; "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if s.status == "ready" { Button("Approve") { act([["type": "rule", "ruleId": s.id, "op": "approve"]], done: "Approved; it takes effect on the next run.") } }
                Button("Dismiss") { act([["type": "rule", "ruleId": s.id, "op": "dismiss"]], done: "Dismissed.") }
            }
            .disabled(working)
        }
    }

    @ViewBuilder private func ruleRow(_ r: RuleCard, exact: ExactRule?) -> some View {
        HStack(alignment: .top) {
            Toggle("", isOn: Binding(get: { r.on }, set: { on in act([["type": "rule", "ruleId": r.id, "op": on ? "on" : "off"]], done: on ? "Turned on." : "Turned off.") }))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(r.wording).foregroundStyle(r.on ? .primary : .secondary)
                Text(r.redrafting ? "Gemma is redrafting it from your new wording." : "\(r.kind == "instruction" ? "Gemma checks for" : r.kind == "include" ? "Include" : "Exact match"): \(r.detail)")
                    .font(.caption).foregroundStyle(.secondary)
                Text("\(r.source.map { "Only \($0)" } ?? "All newsletters")\(r.kind == "include" ? "" : " · hid \(r.hits30d) in the last 30 days")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Edit") {
                if let exact { editing = exact } else { newWording = r.wording; rewording = r }
            }
            Button("Delete", role: .destructive) { act([["type": "rule", "ruleId": r.id, "op": "delete"]], done: "Deleted.") }
        }
        .disabled(working)
    }

    private func load() async {
        guard let r = await agent.run(["rules", "--json"]) else { return }
        if let d = decodeAnswer(RulesData.self, from: r.output) {
            data = d
            words = d.ownWords.text
        } else {
            message = (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false)
        }
    }

    private func act(_ actions: [[String: Any]], done: String) {
        let arg = actArgument(actions)
        Task {
            working = true
            defer { working = false }
            guard let r = await agent.run(["act", arg, "--json"]) else { message = (agent.lastError ?? "Couldn't run the agent.", false); return }
            if let a = decodeAnswer(ActResult.self, from: r.output), a.errors.isEmpty {
                message = (a.applied > 0 ? done : "Nothing to change.", true)
            } else {
                message = (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false)
            }
            await load()
        }
    }
}

/// A wrapper so a rule being edited can drive `.sheet(item:)`.
struct EditingRule: Identifiable {
    let rule: ExactRule
    var id: String { rule.id ?? "new" }
}

/// The exact-rule editor: conditions, scope, what happens to matching email, Test, Save.
struct RuleEditor: View {
    let agent: AgentModel
    @State var rule: ExactRule
    /// Called with a message when saved, or nil when cancelled.
    let close: (String?) -> Void

    @State private var sources: [SourceRecord] = []
    @State private var sections: [SectionRecord] = []
    @State private var test: RuleTestResult?
    @State private var hideCurrent = true
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("What it's for", text: $rule.wording, prompt: Text("e.g. No live-video posts"))
                    Picker("When an email matches", selection: $rule.kind) {
                        Text("Hide it").tag("check")
                        Text("Always include it").tag("include")
                    }
                    Picker("Newsletters", selection: $rule.source) {
                        Text("All newsletters").tag(String?.none)
                        ForEach(sources) { Text($0.name).tag(Optional($0.id)) }
                    }
                    if rule.kind == "check" {
                        Picker("Its email", selection: Binding(get: { rule.mail ?? "deleted-items" }, set: { rule.mail = $0 })) {
                            Text("Goes to Deleted Items").tag("deleted-items")
                            Text("Stays in the Inbox").tag("leave")
                        }
                    } else {
                        Picker("Into section", selection: $rule.section) {
                            Text("Gemma chooses").tag(String?.none)
                            ForEach(sections) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                    Toggle("On", isOn: Binding(get: { rule.status == "active" }, set: { rule.status = $0 ? "active" : "off" }))
                }

                Section {
                    Picker("Match", selection: $rule.match) {
                        Text("All of these").tag("all")
                        Text("Any of these").tag("any")
                    }
                    .pickerStyle(.segmented)
                    ForEach(Array(rule.conditions.enumerated()), id: \.element.key) { i, _ in conditionRow(i) }
                    Button("Add a condition", systemImage: "plus") { rule.conditions.append(ConditionDraft()) }
                } header: { Text("Conditions") }

                if let t = test {
                    Section("Test: the last \(t.days) days") {
                        Text("It would have caught \(t.matched.count) of \(t.checked) emails\(t.unknown > 0 ? " (\(t.unknown) couldn't be checked: their text is gone after 4 days)" : "").")
                        ForEach(Array(t.matched.prefix(50).enumerated()), id: \.offset) { _, m in
                            VStack(alignment: .leading) {
                                Text(m.subject)
                                Text("\(m.sender) · \(String(m.receivedAt.prefix(10)))").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if t.matched.count > 50 { Text("…and \(t.matched.count - 50) more").foregroundStyle(.secondary) }
                    }
                }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            .formStyle(.grouped)

            HStack {
                if rule.kind == "check" && rule.status == "active" { Toggle("Also hide the current articles it catches", isOn: $hideCurrent) }
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button("Cancel") { close(nil) }.keyboardShortcut(.cancelAction)
                Button("Test") { Task { await runTest() } }.disabled(rule.problem != nil || working)
                Button("Save") { Task { await save() } }.keyboardShortcut(.defaultAction).disabled(rule.problem != nil || working)
            }
            .padding()
        }
        .frame(width: 620, height: 640)
        .task { await loadPickers() }
        .onChange(of: rule) { test = nil }
    }

    @ViewBuilder private func conditionRow(_ i: Int) -> some View {
        let c = rule.conditions[i]
        HStack {
            Picker("", selection: Binding(get: { c.field }, set: { f in
                rule.conditions[i].field = f
                if !f.ops.contains(rule.conditions[i].op) { rule.conditions[i].op = f.ops[0] }
            })) { ForEach(ConditionField.allCases) { Text($0.label).tag($0) } }
                .labelsHidden().frame(width: 170)
            Picker("", selection: $rule.conditions[i].op) { ForEach(c.field.ops, id: \.self) { Text(ConditionField.opLabel($0)).tag($0) } }
                .labelsHidden().frame(width: 150)
            TextField(c.field == .wordCount ? "words" : "value", text: $rule.conditions[i].value)
            Button("Remove", systemImage: "minus.circle") { rule.conditions.remove(at: i) }
                .labelStyle(.iconOnly).buttonStyle(.borderless).disabled(rule.conditions.count == 1)
        }
    }

    private func loadPickers() async {
        let loc = agent.locations
        let r = await Task.detached { Result { let db = try Database(path: loc.database.path); return (try db.sources(), try db.sections()) } }.value
        if case .success(let (s, sec)) = r { sources = s; sections = sec }
    }

    private func runTest() async {
        working = true
        defer { working = false }
        guard let r = await agent.run(["rule", "test", rule.json(), "--json"]) else { error = agent.lastError; return }
        if let t = decodeAnswer(RuleTestResult.self, from: r.output) { test = t; error = nil } else { error = r.output.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private func save() async {
        working = true
        defer { working = false }
        let args = ["rule", "save", rule.json(), "--json"] + (rule.kind == "check" && rule.status == "active" && hideCurrent ? ["--hide-current"] : [])
        guard let r = await agent.run(args) else { error = agent.lastError; return }
        if let s = decodeAnswer(RuleSaveResult.self, from: r.output) {
            close("\(s.created ? "Added" : "Saved") “\(rule.wording)”.\(s.hid > 0 ? " It hid \(s.hid) current article\(s.hid == 1 ? "" : "s")." : "") New mail is checked against it from the next run.")
        } else {
            error = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}
