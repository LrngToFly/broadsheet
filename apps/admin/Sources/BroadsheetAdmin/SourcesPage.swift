// The Sources page (docs/phase-3.md A2): every newsletter in one list, and an editor for the one you pick.
import AdminCore
import SwiftUI

@MainActor @Observable
final class SourcesModel {
    var sources: [SourceRecord] = []
    var sections: [SectionRecord] = []
    var error: String?

    func load(_ loc: Locations) async {
        let result = await Task.detached { () -> Result<([SourceRecord], [SectionRecord]), Error> in
            Result { let db = try Database(path: loc.database.path); return (try db.sources(), try db.sections()) }
        }.value
        switch result {
        case .success(let (sources, sections)):
            self.sources = sources
            self.sections = sections
            error = nil
        case .failure(let e):
            error = "\(e)"
        }
    }
}

enum ChannelFilter: String, CaseIterable, Identifiable {
    case all = "All", email = "Email", feed = "Feeds", unsubscribe = "👎 Often"
    var id: Self { self }
    func includes(_ s: SourceRecord) -> Bool {
        switch self {
        case .all: true
        case .email: s.channel == "email"
        case .feed: s.channel == "feed"
        case .unsubscribe: s.unsubscribeCandidate
        }
    }
}

struct SourcesPage: View {
    let agent: AgentModel
    @State private var model = SourcesModel()
    @State private var filter = ChannelFilter.all
    @State private var search = ""
    @State private var selection: SourceRecord.ID?
    @State private var sortOrder = [KeyPathComparator(\SourceRow.name)]
    @State private var following = false

    private var rows: [SourceRow] {
        model.sources
            .filter { filter.includes($0) }
            .filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.address.localizedCaseInsensitiveContains(search) }
            .map { SourceRow(source: $0, sections: model.sections) }
            .sorted(using: sortOrder)
    }

    var body: some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("Name", value: \.name) { r in
                HStack(spacing: 6) {
                    Text(r.name).foregroundStyle(r.source.muted ? .secondary : .primary)
                    if r.source.muted { Badge("Off", .gray) }
                    if r.source.status == "new" { Badge("New", .blue) }
                    if r.source.looksLikeRoundup { Badge("Roundup?", .purple) }
                    if r.source.silentDays() != nil { Badge("Silent", .orange) }
                    if r.source.unsubscribeCandidate { Badge("Unsubscribe?", .red) }
                }
            }
            .width(min: 180, ideal: 240)
            TableColumn("Section", value: \.section).width(min: 90, ideal: 130)
            TableColumn("Format", value: \.formatLabel).width(min: 70, ideal: 90)
            TableColumn("Latest post", value: \.lastPostSort) { r in
                Text(r.source.lastPost.map { $0.formatted(.relative(presentation: .named)) } ?? "—")
                    .foregroundStyle(r.source.silentDays() != nil ? .orange : .primary)
            }
            .width(min: 90, ideal: 110)
            TableColumn("Posts (30 days)", value: \.source.postsLast30Days) { r in
                Text("\(r.source.postsLast30Days)").monospacedDigit()
            }
            .width(min: 60, ideal: 90)
            TableColumn("Your rating", value: \.ratingSort) { r in Text(r.ratingText) }
                .width(min: 70, ideal: 100)
        }
        .searchable(text: $search, prompt: "Name or address")
        .toolbar {
            Picker("Show", selection: $filter) {
                ForEach(ChannelFilter.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Button("Follow by URL…", systemImage: "plus") { following = true }
            Button("Reload", systemImage: "arrow.clockwise") { Task { await model.load(agent.locations) } }
        }
        .sheet(isPresented: $following) {
            FollowSheet(agent: agent, sections: model.sections) { followed in
                following = false
                if followed { Task { await model.load(agent.locations) } }
            }
        }
        .inspector(isPresented: .constant(true)) {
            if let s = model.sources.first(where: { $0.id == selection }) {
                SourceEditor(source: s, sections: model.sections, agent: agent) { await model.load(agent.locations) }
                    .id(s) // a fresh editor when the selection (or the source itself) changes
            } else {
                ContentUnavailableView("No newsletter selected", systemImage: "newspaper", description: Text("Pick one to rename it, fix its section, change its format or turn it off."))
            }
        }
        .overlay { if let e = model.error { ContentUnavailableView("Can't read the newsletters", systemImage: "exclamationmark.triangle", description: Text(e)) } }
        .navigationTitle("Sources (\(model.sources.count))")
        .task { await model.load(agent.locations) }
    }
}

/// One table row, with values the table can sort by.
struct SourceRow: Identifiable {
    let source: SourceRecord
    let sections: [SectionRecord]
    var id: String { source.id }
    var name: String { source.name }
    var section: String { source.fixedSection.map { id in sections.first { $0.id == id }?.name ?? id } ?? "Gemma chooses" }
    var formatLabel: String { source.format == .normal ? "Normal" : source.format == .roundup ? "Roundup" : "Multi-section" }
    var lastPostSort: Date { source.lastPost ?? .distantPast }
    var ratingSort: Double { source.averageRating ?? -2 }
    var ratingText: String {
        guard let a = source.averageRating else { return "—" }
        return "\(a > 0.25 ? "👍" : a < -0.25 ? "👎" : "👌") \(a.formatted(.number.precision(.fractionLength(1)))) (\(source.ratings))"
    }
}

struct Badge: View {
    let text: String
    let color: Color
    init(_ text: String, _ color: Color) { self.text = text; self.color = color }
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.18), in: Capsule()).foregroundStyle(color)
    }
}

/// The right-hand panel: change one newsletter.
struct SourceEditor: View {
    let source: SourceRecord
    let sections: [SectionRecord]
    let agent: AgentModel
    let reload: () async -> Void

    @State private var name: String
    @State private var section: String?
    @State private var format: SourceFormat
    @State private var included: Bool
    @State private var working = false
    @State private var message: (text: String, ok: Bool)?
    @State private var switching = false
    @State private var confirmUnsubscribe = false

    init(source: SourceRecord, sections: [SectionRecord], agent: AgentModel, reload: @escaping () async -> Void) {
        self.source = source
        self.sections = sections
        self.agent = agent
        self.reload = reload
        _name = State(initialValue: source.name)
        _section = State(initialValue: source.fixedSection)
        _format = State(initialValue: source.format)
        _included = State(initialValue: !source.muted)
    }

    private var args: [String] { sourceEditArguments(from: source, name: name, section: section, format: format, included: included) }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                LabeledContent(source.channel == "feed" ? "Feed" : "From", value: source.address)
                LabeledContent("Id", value: source.id).textSelection(.enabled)
            }
            Section {
                Picker("Section", selection: $section) {
                    Text("Gemma chooses").tag(String?.none)
                    ForEach(sections) { Text($0.name).tag(Optional($0.id)) }
                }
                Picker("Format", selection: $format) {
                    ForEach(SourceFormat.allCases) { Text($0.label).tag($0) }
                }
                Toggle("Include its emails", isOn: $included)
            } footer: {
                Text("A new section also moves its current articles, and their emails in Outlook, unless you moved them yourself. Turned off, its emails stay in the Inbox.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if source.looksLikeRoundup && format == .normal {
                Section {
                    Text("Its emails look like a roundup: many short stories, each under its own heading.")
                    Button("Make it a roundup") { format = .roundup }
                }
            }
            if let days = source.silentDays(), included {
                Section {
                    Text("Nothing from it for \(days) days.")
                    Button("Turn it off") { included = false }
                }
            }
            Section {
                if source.channel == "email" {
                    Button("Switch to its feed…") { switching = true }
                    Text("Get its posts from its website's feed instead of email, keeping its name, section and ratings.").font(.caption).foregroundStyle(.secondary)
                }
                if let link = source.unsubscribeURL, let url = URL(string: link) {
                    Button("Unsubscribe…") { confirmUnsubscribe = true }
                        .confirmationDialog("Unsubscribe from \(source.name)?", isPresented: $confirmUnsubscribe) {
                            Button(url.scheme == "mailto" ? "Write the unsubscribe email" : "Open its unsubscribe page") { NSWorkspace.shared.open(url) }
                        } message: {
                            Text(url.scheme == "mailto"
                                 ? "This opens an email to \(url.absoluteString.replacingOccurrences(of: "mailto:", with: "")) in Mail. Sending it is up to you."
                                 : "This opens \(url.host() ?? "its") unsubscribe page in your browser, where you confirm it. Nothing is sent until you do.")
                        }
                    if source.unsubscribeCandidate {
                        Text("You've rated it 👎 more often than not.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .sheet(isPresented: $switching) {
                SwitchToFeedSheet(agent: agent, source: source) { switched in
                    switching = false
                    if switched { Task { await reload() } }
                }
            }

            if source.fromConfigFile {
                Text("It's also in your config file: editing it there overwrites changes made here.").font(.caption).foregroundStyle(.secondary)
            }

            Section {
                HStack {
                    Button("Revert") { name = source.name; section = source.fixedSection; format = source.format; included = !source.muted }
                        .disabled(args.isEmpty || working)
                    Spacer()
                    if working { ProgressView().controlSize(.small) }
                    Button("Apply") { Task { await apply() } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(args.isEmpty || working)
                }
                if let message { Text(message.text).font(.callout).foregroundStyle(message.ok ? Color.secondary : Color.red).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .inspectorColumnWidth(min: 280, ideal: 320)
    }

    private func apply() async {
        working = true
        defer { working = false }
        guard let r = await agent.run(args) else { message = (agent.lastError ?? "Couldn't run the agent.", false); return }
        message = (r.output.trimmingCharacters(in: .whitespacesAndNewlines), r.ok)
        await reload()
    }
}
