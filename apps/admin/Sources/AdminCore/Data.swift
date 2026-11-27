// The Settings and Data pages (docs/phase-3.md A7).
import Foundation

/** What `broadsheet ai --json` answers. */
public struct AIInfo: Sendable, Decodable, Equatable {
    public struct EvalSet: Sendable, Decodable, Equatable { public var savedAt: String; public var count: Int }
    public var model: String
    public var numCtx: Int
    public var running: Bool
    public var installed: [String]
    public var loaded: Bool
    public var evalSet: EvalSet?
    /// Comparison pages, newest first.
    public var reports: [String]
}

/** What `broadsheet storage --json` answers. */
public struct StorageInfo: Sendable, Decodable, Equatable {
    public struct Bytes: Sendable, Decodable, Equatable { public var database: Int; public var articles: Int; public var eval: Int; public var logs: Int }
    public var bytes: Bytes
    public var counts: [String: Int]
}

/// One thing you rated, moved or hid, as the ranking remembers it (no article text).
public struct PreferenceRecord: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var source: String
    public var rating: Int?
    public var note: String?
    public var movedTo: String?
    public var hiddenReason: String?
    public var updatedAt: Date?

    public var summary: String {
        [rating.map { ["1": "👍", "0": "👌", "-1": "👎"][String($0)] ?? "" }, note.map { "“\($0)”" }, movedTo.map { "moved to \($0)" }, hiddenReason.map { "hidden (\($0))" }]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

extension Database {
    public func preferences(limit: Int = 500) throws -> [PreferenceRecord] {
        try query(
            """
            SELECT p.item_id, p.title, coalesce(s.display_name, p.source_id) AS source, p.rating, p.rating_note, sec.name AS moved_to, p.hidden_reason, p.updated_at
            FROM preference_records p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN sections sec ON sec.id = p.moved_to_section
            ORDER BY p.updated_at DESC LIMIT \(limit)
            """
        ).compactMap { r in
            guard let id = r["item_id"]?.string else { return nil }
            return PreferenceRecord(id: id, title: r["title"]?.string ?? "", source: r["source"]?.string ?? "", rating: r["rating"]?.int,
                                    note: r["rating_note"]?.string, movedTo: r["moved_to"]?.string, hiddenReason: r["hidden_reason"]?.string,
                                    updatedAt: r["updated_at"]?.string.flatMap(parseISODate))
        }
    }
}

public func formatBytes(_ n: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file) }

/** One of `broadsheet backups --json`. */
public struct BackupInfo: Sendable, Decodable, Equatable, Identifiable {
    public var name: String
    public var path: String
    public var date: String
    public var bytes: Int
    public var id: String { name }
}
