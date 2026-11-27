// Following by URL and switching a newsletter to its feed (docs/phase-3.md A5). Both preview the latest posts first,
// so you can see it's the right site before anything changes.
import AdminCore
import SwiftUI

/// Paste a site's address, see its latest posts, pick a name and section, follow.
struct FollowSheet: View {
    let agent: AgentModel
    let sections: [SectionRecord]
    let close: (Bool) -> Void

    @State private var url = ""
    @State private var preview: FeedPreview?
    @State private var name = ""
    @State private var section: String?
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    HStack {
                        TextField("Site address", text: $url, prompt: Text("e.g. example.substack.com"))
                            .onSubmit { Task { await look() } }
                        Button("Preview") { Task { await look() } }.disabled(url.trimmingCharacters(in: .whitespaces).isEmpty || working)
                    }
                } footer: {
                    Text("Substack, Ghost, Medium, WordPress, beehiiv and most blogs have a feed. No email sign-up: the agent checks it every hour.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let p = preview {
                    Section("Its latest posts") {
                        ForEach(Array(p.entries.enumerated()), id: \.offset) { _, e in
                            HStack { Text(e.title); Spacer(); Text(String(e.publishedAt.prefix(10))).foregroundStyle(.secondary).monospacedDigit() }
                        }
                    }
                    Section {
                        TextField("Name", text: $name)
                        Picker("Section", selection: $section) {
                            Text("Gemma chooses").tag(String?.none)
                            ForEach(sections) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button("Cancel") { close(false) }.keyboardShortcut(.cancelAction)
                Button("Follow") { Task { await followIt() } }.keyboardShortcut(.defaultAction).disabled(preview == nil || working)
            }
            .padding()
        }
        .frame(width: 520, height: 520)
        .onChange(of: url) { preview = nil }
    }

    private func look() async {
        working = true
        defer { working = false }
        error = nil
        guard let r = await agent.run(["follow", url, "--preview", "--json"]) else { error = agent.lastError; return }
        if let p = decodeAnswer(FeedPreview.self, from: r.output) {
            preview = p
            name = p.title
        } else {
            error = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private func followIt() async {
        working = true
        defer { working = false }
        var args = ["follow", url, "--name", name.trimmingCharacters(in: .whitespaces), "--json"]
        if let section { args += ["--section", section] }
        guard let r = await agent.run(args) else { error = agent.lastError; return }
        if decodeAnswer(FollowResult.self, from: r.output) != nil { close(true) } else { error = r.output.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}

/// Switch an email newsletter to its website's feed, then offer its unsubscribe link.
struct SwitchToFeedSheet: View {
    let agent: AgentModel
    let source: SourceRecord
    let close: (Bool) -> Void

    @State private var site = ""
    @State private var preview: FeedPreview?
    @State private var result: SwitchResult?
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Form {
                if let result {
                    Section("Switched") {
                        Text("\(source.name) now comes from its feed. Once you unsubscribe from its emails, its posts won't be in your mailbox any more.")
                        if let link = result.unsubscribe, let url = URL(string: link) {
                            Button(url.scheme == "mailto" ? "Write the unsubscribe email…" : "Open its unsubscribe page…") { NSWorkspace.shared.open(url) }
                        } else {
                            Text("Its unsubscribe link is at the bottom of each of its emails.").foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section {
                        HStack {
                            TextField("Its website", text: $site, prompt: Text("e.g. example.substack.com"))
                            Button("Preview") { Task { await look(site) } }.disabled(working)
                        }
                    } footer: {
                        Text("Your ratings, section and history stay with it. Emails still arriving before you unsubscribe count as the same newsletter, and a post that comes both ways is kept once.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let p = preview {
                        Section("Its feed's latest posts") {
                            ForEach(Array(p.entries.enumerated()), id: \.offset) { _, e in
                                HStack { Text(e.title); Spacer(); Text(String(e.publishedAt.prefix(10))).foregroundStyle(.secondary).monospacedDigit() }
                            }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                if working { ProgressView().controlSize(.small) }
                if result == nil {
                    Button("Cancel") { close(false) }.keyboardShortcut(.cancelAction)
                    Button("Switch") { Task { await switchIt() } }.keyboardShortcut(.defaultAction).disabled(preview == nil || working)
                } else {
                    Button("Done") { close(true) }.keyboardShortcut(.defaultAction)
                }
            }
            .padding()
        }
        .frame(width: 520, height: 480)
        .task { await look(nil) } // the agent guesses the site from its posts
    }

    private func look(_ url: String?) async {
        working = true
        defer { working = false }
        error = nil
        var args = ["switch-to-feed", source.id, "--preview", "--json"]
        if let url, !url.trimmingCharacters(in: .whitespaces).isEmpty { args += ["--url", url] }
        guard let r = await agent.run(args) else { error = agent.lastError; return }
        if let p = decodeAnswer(FeedPreview.self, from: r.output) {
            preview = p
            if let s = p.site { site = s }
        } else {
            preview = nil
            error = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private func switchIt() async {
        working = true
        defer { working = false }
        guard let r = await agent.run(["switch-to-feed", source.id, "--url", site, "--json"]) else { error = agent.lastError; return }
        if let s = decodeAnswer(SwitchResult.self, from: r.output) { result = s } else { error = r.output.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}
