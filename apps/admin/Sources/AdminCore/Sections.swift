// The paper's sections, for the Sections page (docs/phase-3.md A3). Changes go through `broadsheet sections set`.
import Foundation

public struct SectionInfo: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var articles: Int
    /// Newsletters always filed here.
    public var sources: Int
}

/// A row being edited: an existing section (with its id) or a new one (no id yet).
public struct DraftSection: Sendable, Equatable {
    /// Identifies the row while you rename and move it (`id` is nil for a new section).
    public let key = UUID()
    public var id: String?
    public var name: String
    public var original: String?
    public init(id: String?, name: String) {
        self.id = id
        self.name = name
        original = id == nil ? nil : name
    }
    public var isFallback: Bool { id == "everything-else" }
}

/// The JSON list `broadsheet sections set` takes.
public func sectionsArgument(_ draft: [DraftSection]) -> String {
    let list: [[String: String]] = draft.map { d in
        var o = ["name": d.name.trimmingCharacters(in: .whitespacesAndNewlines)]
        if let id = d.id { o["id"] = id }
        return o
    }
    let data = (try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys])) ?? Data("[]".utf8)
    return String(decoding: data, as: UTF8.self)
}

/// What `broadsheet sections set … --json` answers.
public struct SectionsResult: Sendable, Decodable, Equatable {
    public var changes: [String]
    public var problems: [String]
    public var done: [String]?
    public var errors: [String]?

    /// The JSON is the command's last line (anything before it is ignored).
    public static func parse(_ output: String) -> SectionsResult? {
        guard let line = output.split(separator: "\n").last(where: { $0.hasPrefix("{") }) else { return nil }
        return try? JSONDecoder().decode(SectionsResult.self, from: Data(line.utf8))
    }
}

extension Database {
    public func sectionInfo() throws -> [SectionInfo] {
        try query(
            """
            SELECT s.id, s.name,
                   (SELECT count(*) FROM items i WHERE i.section_id = s.id AND i.kind != 'newsletter') AS articles,
                   (SELECT count(*) FROM sources o WHERE o.fixed_section_id = s.id) AS sources
            FROM sections s ORDER BY s.sort_order
            """
        ).compactMap { r in
            guard let id = r["id"]?.string, let name = r["name"]?.string else { return nil }
            return SectionInfo(id: id, name: name, articles: r["articles"]?.int ?? 0, sources: r["sources"]?.int ?? 0)
        }
    }
}
