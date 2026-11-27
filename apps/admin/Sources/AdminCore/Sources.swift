// Your newsletters, for the Sources page (docs/phase-3.md A2). Read-only: changes go through `broadsheet source`.
import Foundation

public enum SourceFormat: String, CaseIterable, Sendable, Identifiable {
    case normal, roundup, multiSection = "multi-section"
    public var id: Self { self }
    public var label: String {
        switch self {
        case .normal: "One article per email"
        case .roundup: "Roundup: each story a brief"
        case .multiSection: "Multi-section: each piece an article"
        }
    }
}

public struct SectionRecord: Sendable, Equatable, Identifiable, Hashable {
    public var id: String
    public var name: String
}

public struct SourceRecord: Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// The name you gave it, if any (otherwise the name comes from the sender).
    public var customName: String?
    public var channel: String
    /// "new" (found by the agent), "enabled" or "muted".
    public var status: String
    public var format: SourceFormat
    public var looksLikeRoundup: Bool
    public var fixedSection: String?
    public var lastPost: Date?
    public var postsLast30Days: Int
    /// -1…1 (👎…👍), over `ratings` ratings.
    public var averageRating: Double?
    public var ratings: Int
    /// Sender, domain, list or feed address: how it's recognised.
    public var address: String
    public var fromConfigFile: Bool

    public var muted: Bool { status == "muted" }

    /// No post for this many days or more: worth turning off?
    public static let silentAfterDays = 30
    public func silentDays(now: Date = .now) -> Int? {
        guard let lastPost else { return nil }
        let days = Int(now.timeIntervalSince(lastPost) / 86_400)
        return days >= Self.silentAfterDays ? days : nil
    }
}

extension Database {
    public func sections() throws -> [SectionRecord] {
        try query("SELECT id, name FROM sections ORDER BY sort_order").compactMap { r in
            guard let id = r["id"]?.string, let name = r["name"]?.string else { return nil }
            return SectionRecord(id: id, name: name)
        }
    }

    public func sources(now: Date = .now) throws -> [SourceRecord] {
        let since = (now.addingTimeInterval(-30 * 86_400)).ISO8601Format()
        return try query(
            """
            SELECT s.id, coalesce(s.display_name, s.id) AS name, s.display_name, s.channel, s.status, s.format, s.looks_like,
                   s.fixed_section_id, s.last_post_at, s.origin, s.match_json, s.feed_url, s.site_url,
                   (SELECT count(*) FROM source_posts p WHERE p.source_id = s.id AND p.published_at >= ?) AS posts30,
                   (SELECT avg(rating) FROM preference_records r WHERE r.source_id = s.id AND r.rating IS NOT NULL) AS avg_rating,
                   (SELECT count(rating) FROM preference_records r WHERE r.source_id = s.id) AS ratings
            FROM sources s ORDER BY lower(coalesce(s.display_name, s.id))
            """,
            [since]
        ).compactMap(SourceRecord.init(row:))
    }
}

extension SourceRecord {
    init?(row: Row) {
        guard let id = row["id"]?.string else { return nil }
        self.id = id
        name = row["name"]?.string ?? id
        customName = row["display_name"]?.string
        channel = row["channel"]?.string ?? "email"
        status = row["status"]?.string ?? "enabled"
        format = SourceFormat(rawValue: row["format"]?.string ?? "normal") ?? .normal
        looksLikeRoundup = row["looks_like"]?.string == "roundup" && format == .normal
        fixedSection = row["fixed_section_id"]?.string
        lastPost = row["last_post_at"]?.string.flatMap(parseISODate)
        postsLast30Days = row["posts30"]?.int ?? 0
        averageRating = row["avg_rating"]?.double
        ratings = row["ratings"]?.int ?? 0
        fromConfigFile = row["origin"]?.string == "config"
        if channel == "feed" {
            address = row["site_url"]?.string ?? row["feed_url"]?.string ?? ""
        } else {
            let match = (try? JSONSerialization.jsonObject(with: Data((row["match_json"]?.string ?? "{}").utf8))) as? [String: String] ?? [:]
            address = match["listId"] ?? match["sender"] ?? match["domain"].map { "@\($0)" } ?? ""
        }
    }
}

/// The `broadsheet source` arguments for what changed in the editor; empty when nothing did.
public func sourceEditArguments(from old: SourceRecord, name: String, section: String?, format: SourceFormat, included: Bool) -> [String] {
    var args: [String] = []
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed != old.name && !trimmed.isEmpty { args += ["--name", trimmed] }
    if section != old.fixedSection { args += ["--section", section ?? "none"] }
    if format != old.format { args += ["--format", format.rawValue] }
    if included == old.muted { args.append(included ? "--unmute" : "--mute") }
    return args.isEmpty ? [] : ["source", old.id] + args
}
