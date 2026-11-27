// The Sections page (docs/phase-3.md A3): edit the list, preview what changes in the paper and in Outlook, then apply.
import AdminCore
import SwiftUI

struct SectionsPage: View {
    let agent: AgentModel
    @State private var saved: [SectionInfo] = []
    @State private var draft: [DraftSection] = []
    @State private var loadError: String?
    @State private var preview: SectionsResult?
    @State private var outcome: SectionsResult?
    @State private var working = false

    private var changed: Bool { draft.map { [$0.id ?? "", $0.name] } != saved.map { [$0.id, $0.name] } }

    var body: some View {
        Form {
            Section {
                ForEach(Array(draft.enumerated()), id: \.element.key) { i, d in
                    row(i, d)
                }
                Button("Add a section", systemImage: "plus") { draft.append(DraftSection(id: nil, name: "")) }
            } header: {
                Text("Sections, in the paper's order")
            } footer: {
                Text("Each section has an Outlook folder of the same name under The Broadsheet. Removing one moves its emails and articles to Everything Else; no email is deleted.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if let p = preview {
                Section("What will change") {
                    if p.changes.isEmpty && p.problems.isEmpty { Text("Nothing.") }
                    ForEach(p.changes, id: \.self) { Label($0, systemImage: "arrow.right.circle") }
                    ForEach(p.problems, id: \.self) { Label($0, systemImage: "xmark.octagon").foregroundStyle(.red) }
                    HStack {
                        Spacer()
                        Button("Apply") { Task { await run(apply: true) } }
                            .keyboardShortcut(.defaultAction)
                            .disabled(!p.problems.isEmpty || p.changes.isEmpty || working)
                    }
                }
            }
            if let o = outcome {
                Section("Result") {
                    ForEach(o.done ?? [], id: \.self) { Label($0, systemImage: "checkmark.circle").foregroundStyle(.green) }
                    ForEach(o.errors ?? [], id: \.self) { Label($0, systemImage: "xmark.octagon").foregroundStyle(.red) }
                    if (o.errors ?? []).isEmpty { Text("The paper's tabs follow on the next run (within 15 minutes).").foregroundStyle(.secondary) }
                }
            }
            if let e = loadError ?? agent.lastError { Text(e).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle("Sections")
        .toolbar {
            Button("Revert", systemImage: "arrow.uturn.backward") { reset() }.disabled(!changed || working)
            Button("Preview changes", systemImage: "eye") { Task { await run(apply: false) } }.disabled(!changed || working)
        }
        .overlay(alignment: .bottomTrailing) { if working { ProgressView().padding() } }
        .task { await load() }
        .onChange(of: draft) { preview = nil }
    }

    @ViewBuilder private func row(_ i: Int, _ d: DraftSection) -> some View {
        let info = saved.first { $0.id == d.id }
        HStack {
            TextField("Name", text: Binding(get: { draft[i].name }, set: { draft[i].name = $0 }), prompt: Text("New section name"))
                .textFieldStyle(.plain)
            if d.id == nil {
                Badge("New", .blue)
            } else if let original = d.original, original != d.name {
                Text("was \(original)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let info {
                Text("\(info.articles) article\(info.articles == 1 ? "" : "s")\(info.sources > 0 ? " · \(info.sources) newsletter\(info.sources == 1 ? "" : "s")" : "")")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Button("Move up", systemImage: "chevron.up") { draft.swapAt(i, i - 1) }.disabled(i == 0)
            Button("Move down", systemImage: "chevron.down") { draft.swapAt(i, i + 1) }.disabled(i == draft.count - 1)
            Button("Remove", systemImage: "trash") { draft.remove(at: i) }.disabled(d.isFallback)
                .help(d.isFallback ? "Everything Else can't be removed: it's where everything without a section goes." : "Remove this section")
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
    }

    private func reset() {
        draft = saved.map { DraftSection(id: $0.id, name: $0.name) }
        preview = nil
    }

    private func load() async {
        let loc = agent.locations
        let r = await Task.detached { Result { try Database(path: loc.database.path).sectionInfo() } }.value
        switch r {
        case .success(let s):
            saved = s
            loadError = nil
            reset()
        case .failure(let e):
            loadError = "\(e)"
        }
    }

    /// Preview (--dry-run) or apply, through `broadsheet sections set`.
    private func run(apply: Bool) async {
        working = true
        defer { working = false }
        outcome = nil
        let args = ["sections", "set", sectionsArgument(draft), "--json"] + (apply ? [] : ["--dry-run"])
        guard let r = await agent.run(args) else { return }
        guard let result = SectionsResult.parse(r.output) else {
            loadError = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
            return
        }
        if apply {
            outcome = result
            await load()
        } else {
            preview = result
        }
    }
}
