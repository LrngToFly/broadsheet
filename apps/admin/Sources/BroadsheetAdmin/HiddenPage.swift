// The Hidden list (docs/phase-3.md A4): what was left out of the paper in the last few days, and why.
import AdminCore
import SwiftUI

struct HiddenPage: View {
    let agent: AgentModel
    @State private var cards: [HiddenCard]?
    @State private var comingBack: Set<String> = []
    @State private var message: String?

    var body: some View {
        List {
            if let cards {
                if cards.isEmpty { Text("Nothing hidden in the last few days.").foregroundStyle(.secondary) }
                ForEach(cards) { h in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.title).bold()
                            Text("\(h.source)\(h.author.map { $0 == h.source ? "" : " · \($0)" } ?? "") · \(parseISODate(h.publishedAt)?.formatted(.relative(presentation: .named)) ?? "")")
                                .font(.caption).foregroundStyle(.secondary)
                            Text(h.whyText).font(.caption).italic()
                        }
                        Spacer()
                        if comingBack.contains(h.id) {
                            Text("Coming back on the next run").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Button("Show it again") { Task { await unhide(h) } }
                        }
                    }
                    .padding(.vertical, 2)
                }
            } else {
                ProgressView("Asking the agent…")
            }
            if let message { Text(message).foregroundStyle(.red) }
        }
        .navigationTitle("Hidden\(cards.map { " (\($0.count))" } ?? "")")
        .toolbar { Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } } }
        .task { await load() }
    }

    private func load() async {
        guard let r = await agent.run(["hidden", "--json"]) else { message = agent.lastError; return }
        if let c = decodeAnswer([HiddenCard].self, from: r.output) { cards = c; comingBack = [] } else { message = r.output }
    }

    /// The same as the reader's Show it again: back in the paper for good, its email back in its folder.
    private func unhide(_ h: HiddenCard) async {
        guard let r = await agent.run(["act", actArgument([["type": "unhide", "itemId": h.id]]), "--json"]) else { message = agent.lastError; return }
        if let a = decodeAnswer(ActResult.self, from: r.output), a.errors.isEmpty { comingBack.insert(h.id) } else { message = r.output }
    }
}
