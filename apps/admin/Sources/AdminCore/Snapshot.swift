// What the agent is doing right now, read from its database and files every few seconds.
import Foundation

public struct RunRecord: Sendable, Equatable, Identifiable {
    public var id: Int
    public var startedAt: Date
    public var finishedAt: Date?
    public var stage: String
    public var counts: [String: Int]
    public var deferredReason: String?
    public var errors: [String]

    /// e.g. "4 new emails · Gemma read 6 · 2 reader actions"
    public var summary: String {
        var parts: [String] = []
        if let n = counts["included"], n > 0 { parts.append("\(n) new email\(n == 1 ? "" : "s")") }
        if let n = counts["ai"], n > 0 { parts.append("Gemma read \(n)") }
        if let n = counts["readerActions"], n > 0 { parts.append("\(n) reader action\(n == 1 ? "" : "s")") }
        if let n = counts["hidden"], n > 0 { parts.append("\(n) hidden") }
        if let n = counts["newSources"], n > 0 { parts.append("\(n) new source\(n == 1 ? "" : "s")") }
        return parts.isEmpty ? "Nothing new" : parts.joined(separator: " · ")
    }
}

public struct Progress: Sendable, Equatable, Decodable {
    public var n: Int
    public var total: Int
    public var title: String
}

public struct Snapshot: Sendable, Equatable {
    public var installed: Bool
    /// The run holding the lock is alive.
    public var running: Bool
    public var progress: Progress?
    public var pausedUntil: Date?
    /// Items waiting for Gemma.
    public var pending: Int
    public var runs: [RunRecord]
    public var databaseError: String?

    public init(installed: Bool = true, running: Bool = false, progress: Progress? = nil, pausedUntil: Date? = nil, pending: Int = 0, runs: [RunRecord] = [], databaseError: String? = nil) {
        self.installed = installed
        self.running = running
        self.progress = progress
        self.pausedUntil = pausedUntil
        self.pending = pending
        self.runs = runs
        self.databaseError = databaseError
    }

    public static func read(_ loc: Locations, now: Date = .now) -> Snapshot {
        var s = Snapshot(installed: FileManager.default.fileExists(atPath: loc.launchAgent.path))
        s.running = lockIsHeld(loc.runLock)
        if s.running, let data = try? Data(contentsOf: loc.progress) {
            s.progress = try? JSONDecoder().decode(Progress.self, from: data)
        }
        // The agent found the database damaged: say so, with the fix it suggested.
        if let data = try? Data(contentsOf: loc.problem),
           let p = try? JSONDecoder().decode(DatabaseProblem.self, from: data) {
            s.databaseError = "The database is damaged, so the agent has stopped. To fix it, in Terminal: \(p.fix)"
            return s
        }
        do {
            let db = try Database(path: loc.database.path)
            if let until = try db.scalar("SELECT value FROM agent_state WHERE key = 'pause:until'").string.flatMap(parseISODate), until > now {
                s.pausedUntil = until
            }
            s.pending = try db.scalar("SELECT count(*) FROM items WHERE ai_status = 'pending' AND hidden_by IS NULL").int ?? 0
            s.runs = try db.query("SELECT id, started_at, finished_at, stage, counts_json, deferred_reason, errors_json FROM runs ORDER BY id DESC LIMIT 50")
                .compactMap(RunRecord.init(row:))
        } catch {
            s.databaseError = "\(error)"
        }
        return s
    }
}

extension RunRecord {
    init?(row: Row) {
        guard let id = row["id"]?.int, let started = row["started_at"]?.string.flatMap(parseISODate) else { return nil }
        self.id = id
        startedAt = started
        finishedAt = row["finished_at"]?.string.flatMap(parseISODate)
        stage = row["stage"]?.string ?? "?"
        let countsJSON = Data((row["counts_json"]?.string ?? "{}").utf8)
        // Counts are mostly numbers; anything else (e.g. a profile version) is ignored here.
        let raw = (try? JSONSerialization.jsonObject(with: countsJSON)) as? [String: Any] ?? [:]
        counts = raw.compactMapValues { ($0 as? NSNumber)?.intValue }
        deferredReason = row["deferred_reason"]?.string
        errors = (try? JSONDecoder().decode([String].self, from: Data((row["errors_json"]?.string ?? "[]").utf8))) ?? []
    }
}

/// The agent writes ISO 8601 times, with or without milliseconds.
public func parseISODate(_ s: String) -> Date? {
    (try? Date(s, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
        ?? (try? Date(s, strategy: .iso8601))
}

/// The lock file holds the running agent's process id; a crashed run can leave a stale one.
func lockIsHeld(_ url: URL) -> Bool {
    guard let text = try? String(contentsOf: url, encoding: .utf8), let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

struct DatabaseProblem: Decodable { var problem: String; var fix: String }
