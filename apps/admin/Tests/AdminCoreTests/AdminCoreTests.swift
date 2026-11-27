import Foundation
import Testing
@testable import AdminCore

@Suite struct AgentStateTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func run(_ stage: String = "all", deferred: String? = nil, counts: [String: Int] = [:]) -> RunRecord {
        RunRecord(id: 1, startedAt: now, finishedAt: now.addingTimeInterval(30), stage: stage, counts: counts, deferredReason: deferred, errors: [])
    }

    @Test func workingShowsProgress() {
        let s = Snapshot(running: true, progress: Progress(n: 3, total: 12, title: "Tomatoes"), pending: 9)
        #expect(AgentState(s) == .working(n: 3, total: 12, title: "Tomatoes"))
        #expect(AgentState(s).headline == "Working (3 of 12)")
        #expect(AgentState(Snapshot(running: true)) == .checking)
    }

    @Test func pausedWinsOverWaitingButNotOverARunningJob() {
        let until = now.addingTimeInterval(3600)
        #expect(AgentState(Snapshot(pausedUntil: until, pending: 4, runs: [run(deferred: "you're active")])) == .paused(until: until))
        #expect(AgentState(Snapshot(running: true, pausedUntil: until)) == .checking) // Run now while paused
    }

    @Test func waitingNeedsPendingItemsAndADeferral() {
        #expect(AgentState(Snapshot(pending: 4, runs: [run(deferred: "you're active")])) == .waiting(reason: "you're active", pending: 4))
        #expect(AgentState(Snapshot(pending: 0, runs: [run(deferred: "you're active")])) == .idle(pending: 0))
        #expect(AgentState(Snapshot(pending: 2, runs: [run()])) == .idle(pending: 2))
        #expect(AgentState(Snapshot(installed: false)) == .notInstalled)
        #expect(AgentState(Snapshot(databaseError: "no file")) == .problem("no file"))
    }

    @Test func runSummary() {
        #expect(run(counts: ["included": 4, "ai": 6, "readerActions": 1]).summary == "4 new emails · Gemma read 6 · 1 reader action")
        #expect(run().summary == "Nothing new")
    }
}

@Suite struct ReadingTheAgentTests {
    @Test func findsTheAgentInItsLaunchdJob() throws {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
        <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>/x/cli.ts</string><string>run</string></array>
        <key>WorkingDirectory</key><string>/x</string><key>StandardOutPath</key><string>/logs/agent.log</string>
        <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string></dict>
        </dict></plist>
        """
        #expect(AgentCommand.fromPlist(Data(plist.utf8)) == AgentCommand(node: "/opt/homebrew/bin/node", cli: "/x/cli.ts", workingDirectory: "/x", logFile: "/logs/agent.log", path: "/opt/homebrew/bin:/usr/bin"))
        #expect(AgentCommand.fromPlist(Data("nonsense".utf8)) == nil)
    }

    @Test func parsesTheAgentsTimes() {
        #expect(parseISODate("2026-11-27T15:00:00.123Z") != nil)
        #expect(parseISODate("2026-11-27T15:00:00Z") != nil)
        #expect(parseISODate("yesterday") == nil)
    }

    @Test func readsADatabaseLikeTheAgents() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let db = dir.appending(path: "broadsheet.db").path
        // Build one with the sqlite3 tool, with the agent's table shapes.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        p.arguments = [db, """
        CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE items (id TEXT, ai_status TEXT, hidden_by TEXT);
        CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, stage TEXT, counts_json TEXT, deferred_reason TEXT, errors_json TEXT);
        INSERT INTO agent_state VALUES ('pause:until', '2999-01-01T06:00:00.000Z');
        INSERT INTO items VALUES ('a', 'pending', NULL), ('b', 'pending', 'user'), ('c', 'done', NULL);
        INSERT INTO runs VALUES (1, '2026-11-27T15:00:00.000Z', '2026-11-27T15:00:40.000Z', 'all', '{"included":2,"profile":3}', 'you''re active', '["oops"]');
        """]
        try p.run()
        p.waitUntilExit()

        let loc = Locations(home: dir, logs: dir, launchAgent: dir.appending(path: "none.plist"))
        let s = Snapshot.read(loc)
        #expect(s.databaseError == nil)
        #expect(s.installed == false)
        #expect(s.pending == 1)
        #expect(s.pausedUntil != nil)
        #expect(s.runs.first?.counts == ["included": 2, "profile": 3])
        #expect(s.runs.first?.errors == ["oops"])
        #expect(s.runs.first?.deferredReason == "you're active")
    }
}

@Suite struct SourcesTests {
    func sqlite(_ db: String, _ sql: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        p.arguments = [db, sql]
        try p.run()
        p.waitUntilExit()
    }

    @Test func listsSourcesWithTheirNumbers() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appending(path: "b.db").path
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let recent = now.addingTimeInterval(-2 * 86_400).ISO8601Format()
        let old = now.addingTimeInterval(-60 * 86_400).ISO8601Format()
        try sqlite(path, """
        CREATE TABLE sections (id TEXT, name TEXT, sort_order INTEGER);
        INSERT INTO sections VALUES ('gardening', 'Gardening', 1), ('current-events', 'Current Events', 0);
        CREATE TABLE sources (id TEXT, display_name TEXT, channel TEXT, status TEXT, format TEXT, looks_like TEXT, fixed_section_id TEXT,
          last_post_at TEXT, origin TEXT, match_json TEXT, feed_url TEXT, site_url TEXT);
        INSERT INTO sources VALUES
          ('garden', 'Garden Letter', 'email', 'enabled', 'normal', 'roundup', 'gardening', '\(recent)', 'auto', '{"listId":"garden.substack.com"}', NULL, NULL),
          ('quiet', NULL, 'email', 'muted', 'roundup', 'roundup', NULL, '\(old)', 'config', '{"sender":"hi@quiet.example"}', NULL, NULL),
          ('blog', 'A Blog', 'feed', 'enabled', 'normal', NULL, NULL, NULL, 'config', NULL, 'https://x/feed', 'https://x');
        CREATE TABLE source_posts (item_id TEXT, source_id TEXT, published_at TEXT);
        INSERT INTO source_posts VALUES ('1', 'garden', '\(recent)'), ('2', 'garden', '\(recent)'), ('3', 'garden', '\(old)');
        CREATE TABLE preference_records (item_id TEXT, source_id TEXT, rating INTEGER);
        INSERT INTO preference_records VALUES ('1', 'garden', 1), ('2', 'garden', 0), ('9', 'garden', NULL);
        """)
        let db = try Database(path: path)
        #expect(try db.sections().map(\.name) == ["Current Events", "Gardening"])
        let s = try db.sources(now: now)
        #expect(s.map(\.name) == ["A Blog", "Garden Letter", "quiet"])
        let garden = s[1]
        #expect(garden.postsLast30Days == 2)
        #expect(garden.averageRating == 0.5)
        #expect(garden.ratings == 2)
        #expect(garden.address == "garden.substack.com")
        #expect(garden.looksLikeRoundup)
        #expect(garden.silentDays(now: now) == nil)
        let quiet = s[2]
        #expect(quiet.muted && quiet.fromConfigFile && !quiet.looksLikeRoundup) // already a roundup: no suggestion
        #expect(quiet.silentDays(now: now) == 60)
        #expect(quiet.address == "hi@quiet.example")
        #expect(s[0].address == "https://x")
    }

    @Test func turnsEditsIntoAgentArguments() {
        let s = SourceRecord(id: "garden", name: "Garden Letter", customName: nil, channel: "email", status: "enabled", format: .normal, looksLikeRoundup: false,
                             fixedSection: "gardening", lastPost: nil, postsLast30Days: 0, averageRating: nil, ratings: 0, address: "", fromConfigFile: false)
        #expect(sourceEditArguments(from: s, name: "Garden Letter", section: "gardening", format: .normal, included: true) == [])
        #expect(sourceEditArguments(from: s, name: " Pen & Trowel ", section: nil, format: .roundup, included: false)
            == ["source", "garden", "--name", "Pen & Trowel", "--section", "none", "--format", "roundup", "--mute"])
        #expect(sourceEditArguments(from: s, name: "", section: "gardening", format: .normal, included: true) == []) // an empty name is ignored
    }
}
