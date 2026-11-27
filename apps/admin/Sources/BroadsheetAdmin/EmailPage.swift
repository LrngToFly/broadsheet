// The Email page (docs/phase-3.md A6).
import AdminCore
import SwiftUI

struct EmailPage: View {
    let agent: AgentModel
    @State private var review: EmailReview?
    @State private var settings: [SettingRow] = []
    @State private var including: Set<String> = []
    @State private var message: (text: String, ok: Bool)?
    @State private var working = false

    private func setting(_ key: String) -> SettingRow? { settings.first { $0.key == key } }

    var body: some View {
        Form {
            Section {
                if let mode = setting("mailbox.mode") {
                    Picker("Which emails", selection: Binding(get: { mode.value.string ?? "dedicated" }, set: { v in set("mailbox.mode", v) })) {
                        Text("Everything in the Inbox (a mailbox just for newsletters)").tag("dedicated")
                        Text("Only what an include rule picks (a shared mailbox)").tag("shared")
                    }
                    .pickerStyle(.radioGroup)
                    resetRow(mode)
                }
                if let read = setting("mailbox.markFiledAsRead") {
                    Toggle("Mark emails as read when they're filed", isOn: Binding(get: { read.value.bool ?? false }, set: { v in set("mailbox.markFiledAsRead", v ? "true" : "false") }))
                    resetRow(read)
                }
            } header: { Text("Mailbox") } footer: {
                Text("Either way, sign-in, receipt and welcome emails stay in the Inbox. In a shared mailbox, add include rules on the Rules page.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if let r = review {
                Section("New newsletters") {
                    if r.newSources == 0 {
                        Text("None waiting.").foregroundStyle(.secondary)
                    } else {
                        Text("The agent found \(r.newSources) newsletter\(r.newSources == 1 ? "" : "s") by itself; \(r.newSources == 1 ? "it's" : "they're") already in the paper. Look them over on the Sources page (the New filter) to rename one, fix its section or turn it off.")
                        Button("Mark all as looked at") { run(["mail", "approve", "--json"], done: "Done: none are marked New now.") }.disabled(working)
                    }
                }

                Section {
                    if r.skipped.isEmpty { Text("Nothing skipped in the mail log yet.").foregroundStyle(.secondary) }
                    ForEach(r.skipped) { m in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.subject)
                                Text("\(m.senderName.map { "\($0) · " } ?? "")\(m.sender) · \(parseISODate(m.receivedAt)?.formatted(date: .abbreviated, time: .shortened) ?? "")")
                                    .font(.caption).foregroundStyle(.secondary)
                                if let why = m.why { Text(why).font(.caption).italic() }
                            }
                            Spacer()
                            if including.contains(m.key) || m.why == "sent to _Add from Admin" {
                                Text("In _Add: the next run includes it").font(.caption).foregroundStyle(.secondary)
                            } else {
                                Button("Include this one") { include(m) }.disabled(working)
                            }
                        }
                    }
                } header: { Text("Skipped mail") } footer: {
                    Text("Left in the Inbox as account, sign-in, receipt or welcome mail, or from a newsletter you turned off. Include this one moves it into _Add.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Dropped into _Add") {
                    if r.added.isEmpty { Text("Nothing yet. Drag any email into The Broadsheet/_Add in Outlook to include it.").foregroundStyle(.secondary) }
                    ForEach(r.added) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.subject)
                            Text("\(m.source ?? m.sender) · \(parseISODate(m.receivedAt)?.formatted(date: .abbreviated, time: .omitted) ?? "")").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                ProgressView("Asking the agent…")
            }
            if let message { Text(message.text).foregroundStyle(message.ok ? Color.secondary : Color.red).textSelection(.enabled) }
        }
        .formStyle(.grouped)
        .navigationTitle("Email")
        .toolbar { Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } } }
        .task { await load() }
    }

    @ViewBuilder private func resetRow(_ s: SettingRow) -> some View {
        if s.fromAdmin {
            HStack {
                Text("Set here (your config file says \(s.fileValue?.argument ?? "nothing")).").font(.caption).foregroundStyle(.secondary)
                Button("Use the file's") { run(["set", s.key, "--reset"], done: "Back to the config file's value.") }.buttonStyle(.link).font(.caption)
            }
        }
    }

    private func load() async {
        async let mail = agent.run(["mail", "--json"])
        async let sets = agent.run(["settings", "--json"])
        if let r = await mail { if let v = decodeAnswer(EmailReview.self, from: r.output) { review = v } else { message = (r.output, false) } }
        if let r = await sets { if let v = decodeAnswer([SettingRow].self, from: r.output) { settings = v } else { message = (r.output, false) } }
    }

    private func set(_ key: String, _ value: String) {
        run(["set", key, value], done: "Saved; it applies from the next run.")
    }

    private func include(_ m: LoggedEmail) {
        Task {
            working = true
            defer { working = false }
            guard let r = await agent.run(["mail", "include", m.key, "--json"]) else { message = (agent.lastError ?? "", false); return }
            if r.ok { including.insert(m.key); message = ("Moved “\(m.subject)” into _Add: the next run includes it.", true) }
            else { message = (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false) }
        }
    }

    private func run(_ args: [String], done: String) {
        Task {
            working = true
            defer { working = false }
            guard let r = await agent.run(args) else { message = (agent.lastError ?? "", false); return }
            message = r.ok ? (done, true) : (r.output.trimmingCharacters(in: .whitespacesAndNewlines), false)
            await load()
        }
    }
}
