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
          last_post_at TEXT, origin TEXT, match_json TEXT, feed_url TEXT, site_url TEXT, unsubscribe_url TEXT);
        INSERT INTO sources VALUES
          ('garden', 'Garden Letter', 'email', 'enabled', 'normal', 'roundup', 'gardening', '\(recent)', 'auto', '{"listId":"garden.substack.com"}', NULL, NULL, 'https://garden.example/unsub'),
          ('quiet', NULL, 'email', 'muted', 'roundup', 'roundup', NULL, '\(old)', 'config', '{"sender":"hi@quiet.example"}', NULL, NULL, NULL),
          ('blog', 'A Blog', 'feed', 'enabled', 'normal', NULL, NULL, NULL, 'config', NULL, 'https://x/feed', 'https://x', NULL);
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
        #expect(garden.unsubscribeURL == "https://garden.example/unsub")
        #expect(!garden.unsubscribeCandidate) // rated 👍 and 👌
        #expect(garden.silentDays(now: now) == nil)
        let quiet = s[2]
        #expect(quiet.muted && quiet.fromConfigFile && !quiet.looksLikeRoundup) // already a roundup: no suggestion
        #expect(quiet.silentDays(now: now) == 60)
        #expect(quiet.address == "hi@quiet.example")
        #expect(s[0].address == "https://x")
    }

    @Test func turnsEditsIntoAgentArguments() {
        let s = SourceRecord(id: "garden", name: "Garden Letter", customName: nil, channel: "email", status: "enabled", format: .normal, looksLikeRoundup: false,
                             fixedSection: "gardening", lastPost: nil, postsLast30Days: 0, averageRating: nil, ratings: 0, address: "", fromConfigFile: false, unsubscribeURL: nil)
        #expect(sourceEditArguments(from: s, name: "Garden Letter", section: "gardening", format: .normal, included: true) == [])
        #expect(sourceEditArguments(from: s, name: " Pen & Trowel ", section: nil, format: .roundup, included: false)
            == ["source", "garden", "--name", "Pen & Trowel", "--section", "none", "--format", "roundup", "--mute"])
        #expect(sourceEditArguments(from: s, name: "", section: "gardening", format: .normal, included: true) == []) // an empty name is ignored
    }
}

@Suite struct SectionsTests {
    @Test func buildsTheListForTheAgent() {
        var draft = [DraftSection(id: "technology", name: "Tech "), DraftSection(id: nil, name: "Cooking & Food")]
        #expect(sectionsArgument(draft) == #"[{"id":"technology","name":"Tech"},{"name":"Cooking & Food"}]"#)
        draft[0].name = "Technology"
        #expect(draft[0].original == "Tech " && draft[1].original == nil)
        #expect(DraftSection(id: "everything-else", name: "Everything Else").isFallback)
    }

    @Test func readsTheAgentsAnswer() {
        let out = """
        some warning first
        {"changes":["Add \\"Cooking\\""],"problems":[],"done":["added \\"Cooking\\""],"errors":[]}
        """
        #expect(SectionsResult.parse(out) == SectionsResult(changes: [#"Add "Cooking""#], problems: [], done: [#"added "Cooking""#], errors: []))
        #expect(SectionsResult.parse("Error: no") == nil)
    }
}

@Suite struct RulesTests {
    @Test func readsTheAgentsRulesView() throws {
        let json = #"""
        {"schemaVersion":1,"generatedAt":"2026-11-27T12:00:00.000Z","ownWords":{"text":"Less spectacle.","updatedAt":null},"learnedProfile":null,
         "suggestions":[{"id":"request-3","status":"drafting","from":{"kind":"typed","text":"No crypto"},"wording":null,"ruleKind":null,"detail":null,"source":null,"wouldHide":[],"error":null}],
         "rules":[{"id":"no-live","wording":"No live video","kind":"check","detail":"subject contains \"live\"","source":"TV","status":"off","mail":"deleted-items","hits30d":2,"redrafting":false}],
         "exact":{"no-live":{"id":"no-live","kind":"check","wording":"No live video","match":"all","conditions":[{"field":"subject","op":"contains","value":"live"},{"field":"wordCount","op":"lessThan","value":150}],"source":"tv","mail":"deleted-items","status":"off"}}}
        """#
        let d = try #require(decodeAnswer(RulesData.self, from: "noise\n" + json.replacingOccurrences(of: "\n", with: "")))
        #expect(d.ownWords.text == "Less spectacle.")
        #expect(d.suggestions.first?.fromText == "You typed: “No crypto”")
        #expect(d.rules.first?.on == false)
        let exact = try #require(d.exact["no-live"])
        #expect(exact.conditions.map(\.value) == ["live", "150"])
        #expect(exact.source == "tv")
    }

    @Test func writesTheRuleTheAgentExpects() {
        var r = ExactRule(wording: "No live video", conditions: [ConditionDraft(field: .subject, op: "contains", value: "live"), ConditionDraft(field: .wordCount, op: "lessThan", value: "150")], section: "gardening")
        #expect(r.problem == nil)
        #expect(r.json() == #"{"conditions":[{"field":"subject","op":"contains","value":"live"},{"field":"wordCount","op":"lessThan","value":150}],"kind":"check","mail":"deleted-items","match":"all","status":"active","wording":"No live video"}"#)
        r.kind = "include"
        #expect(r.json().contains(#""section":"gardening""#) && !r.json().contains("mail"))
        r.conditions[1].value = "lots"
        #expect(r.problem == "The length needs a whole number of words.")
        r.conditions = [ConditionDraft(field: .subject, op: "matches", value: "(")]
        #expect(r.problem == "“(” isn't a valid regular expression.")
        r.wording = " "
        #expect(r.problem == "Say what the rule is for, in a few words.")
    }

    @Test func readsHiddenCardsAndActions() {
        let hidden = decodeAnswer([HiddenCard].self, from: #"[{"id":"a","title":"Sale!","source":"Shop","author":null,"publishedAt":"2026-11-27T10:00:00Z","url":null,"why":{"kind":"you","reason":"ad","note":"never"}}]"#)
        #expect(hidden?.first?.whyText == "You hid this (ad): “never”")
        #expect(actArgument([["type": "unhide", "itemId": "a"]]) == #"[{"itemId":"a","type":"unhide"}]"#)
        #expect(decodeAnswer(ActResult.self, from: #"{"applied":1,"ignored":0,"errors":[]}"#) == ActResult(applied: 1, ignored: 0, errors: []))
    }
}

@Suite struct FollowingTests {
    @Test func readsFeedPreviews() {
        let p = decodeAnswer(FeedPreview.self, from: #"{"feedUrl":"https://g.example/feed","title":"Garden","siteUrl":null,"entries":[{"title":"Post","publishedAt":"2026-11-27T10:00:00Z","url":null}],"site":"https://g.example/"}"#)
        #expect(p?.entries.first?.title == "Post")
        #expect(p?.site == "https://g.example/")
        #expect(decodeAnswer(SwitchResult.self, from: #"{"feedUrl":"https://g.example/feed","unsubscribe":null}"#)?.unsubscribe == nil)
    }

    @Test func suggestsUnsubscribingFromWhatYouDislike() {
        var s = SourceRecord(id: "x", name: "X", customName: nil, channel: "email", status: "enabled", format: .normal, looksLikeRoundup: false, fixedSection: nil,
                             lastPost: nil, postsLast30Days: 0, averageRating: -0.5, ratings: 3, address: "", fromConfigFile: false, unsubscribeURL: nil)
        #expect(s.unsubscribeCandidate)
        s.ratings = 2
        #expect(!s.unsubscribeCandidate) // too few ratings to say
    }
}

@Suite struct EmailTests {
    @Test func readsTheMailReviewAndSettings() throws {
        let r = try #require(decodeAnswer(EmailReview.self, from: #"{"skipped":[{"key":"<1@x>","receivedAt":"2026-11-27T10:00:00Z","sender":"a@x.example","senderName":null,"subject":"Welcome","why":"sign-in, receipt or welcome email","source":null}],"added":[],"newSources":3}"#))
        #expect(r.skipped.first?.id == "<1@x>" && r.newSources == 3)
        let s = try #require(decodeAnswer([SettingRow].self, from: #"[{"key":"mailbox.mode","label":"Mailbox mode","value":"shared","fromAdmin":true,"fileValue":"dedicated"},{"key":"mailbox.markFiledAsRead","label":"x","value":false,"fromAdmin":false,"fileValue":false},{"key":"retention.days","label":"y","value":4,"fromAdmin":false}]"#))
        #expect(s[0].value.string == "shared" && s[0].fileValue?.argument == "dedicated")
        #expect(s[1].value.bool == false && s[1].value.argument == "false")
        #expect(s[2].value.argument == "4" && s[2].fileValue == nil)
    }
}

@Suite struct DataTests {
    @Test func readsAIAndStorage() throws {
        let ai = try #require(decodeAnswer(AIInfo.self, from: #"{"model":"gemma4:12b","numCtx":16384,"running":true,"installed":["gemma4:12b"],"loaded":false,"evalSet":{"savedAt":"2026-11-27T15:00:00.000Z","count":20},"reports":["/x/report-2.html"]}"#))
        #expect(ai.evalSet?.count == 20 && ai.reports.first == "/x/report-2.html")
        let s = try #require(decodeAnswer(StorageInfo.self, from: #"{"bytes":{"database":2048,"articles":0,"eval":0,"logs":10},"counts":{"articles":3,"ratings":5}}"#))
        #expect(s.counts["ratings"] == 5)
        #expect(decodeAnswer([String: Int].self, from: #"{"sections":6,"sources":2}"#)?["sources"] == 2)
    }

    @Test func describesWhatWasLearned() {
        let p = PreferenceRecord(id: "i", title: "Feud", source: "Civic Desk", rating: -1, note: "a distraction", movedTo: nil, hiddenReason: nil, updatedAt: nil)
        #expect(p.summary == "👎 · “a distraction”")
        #expect(PreferenceRecord(id: "j", title: "", source: "", rating: nil, note: nil, movedTo: "Gardening", hiddenReason: "ad", updatedAt: nil).summary == "moved to Gardening · hidden (ad)")
    }
}
