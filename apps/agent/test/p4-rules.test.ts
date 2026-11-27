import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionsFile, Config, RulesFile } from "@broadsheet/shared";
import { applyReaderActions } from "../src/pipeline/reader-actions.ts";
import { buildRulesFile } from "../src/pipeline/rules.ts";
import { stageB } from "../src/pipeline/stage-b.ts";
import { learn } from "../src/pipeline/affinity.ts";
import { currentProfile } from "../src/ai/profile.ts";
import { ruleFromReply } from "../src/ai/rule-draft.ts";
import { openDb, syncConfig } from "../src/db/db.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";
import type { ChatMessage, LlmProvider } from "../src/ai/provider.ts";
import type { ActivitySample } from "../src/activity.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
const config = Config.parse({
  microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
  readerProfile: "Words from the config file.",
  rules: [{ id: "no-course-ads", kind: "instruction", wording: "No course ads", instruction: "Hide course ads.", mail: "deleted-items" }],
});
const away: ActivitySample = { idleSeconds: 3600, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
  db.prepare(`INSERT INTO sources (id, channel, display_name, match_json, status, origin, created_at) VALUES ('pen', 'email', 'Studio Live', '{"listId":"studiolive.substack.com"}', 'enabled', 'auto', 'x')`).run();
  const contentDir = mkdtempSync(join(tmpdir(), "bs-p4-"));
  const add = (id: string, title: string, words: number, text: string) => {
    db.prepare(
      `INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, author, published_at, section_id, section_source, tags_json, created_at,
         content_published, ai_status, summary, interest, is_article, word_count, sender)
       VALUES (?, 'pen', 'email', ?, 'F-current-events', ?, 'Ann', '2026-11-27T10:00:00Z', 'current-events', 'ai', '["politics"]', 'x', 1, 'done', ?, 50, 1, ?, 'pen@substack.com')`,
    ).run(id, `m-${id}`, title, `A summary of ${title}.`, words);
    mkdirSync(join(contentDir, id), { recursive: true });
    writeFileSync(join(contentDir, id, "article.txt"), text);
    writeFileSync(join(contentDir, id, "article.html"), `<p>${text} <a href="https://youtube.com/live/x">Watch</a></p>`);
  };
  add("live1", "Ann is live now", 40, "Join the live video.");
  add("live2", "Ann is live again", 35, "Join the live video.");
  add("essay", "A long essay", 1800, "A long careful essay about the courts.");

  const files = new Map<string, unknown>();
  const appFolder = {
    list: async (folder: string) => [...files.keys()].filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1)),
    getJson: async <T>(path: string) => files.get(path) as T,
    delete: async (path: string) => void files.delete(path),
  };
  const moves: [string, string][] = [];
  const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
  let n = 0;
  const send = async (actions: unknown[]) => {
    files.set(`ratings/phone01-${++n}.json`, ActionsFile.parse({ schemaVersion: 1, device: "phone01", createdAt: NOW.toISOString(), actions }));
    return applyReaderActions({ db, appFolder, mail, contentDir, now: NOW });
  };
  /** A fake Gemma that answers from a script and records the questions. */
  const gemma = (script: string[]) => {
    const asked: ChatMessage[][] = [];
    const llm: LlmProvider = {
      id: "fake",
      chat: async (m) => (asked.push(m), { text: script.shift() ?? "{}", promptTokens: 1, outputTokens: 1, seconds: 1 }),
      isLoaded: async () => true,
      unload: async () => {},
    };
    return { llm, asked };
  };
  const runB = (llm: LlmProvider) => stageB({ db, config, llm, mail, contentDir, sampleActivity: async () => away });
  const rulesFile = () => RulesFile.parse(buildRulesFile(db, config, NOW));
  return { db, send, gemma, runB, moves, rulesFile };
}

const at = (s: number) => new Date(NOW.getTime() - 60_000 + s * 1000).toISOString();

describe("in your own words", () => {
  it("replaces the config file's words, goes to Gemma, and has current items re-scored", async () => {
    const { db, send, gemma, runB, rulesFile } = setup();
    expect(currentProfile(db, config).own).toBe("Words from the config file.");
    await send([{ type: "own-words", text: "  Rank political distraction stories lower.  ", at: at(1) }]);
    expect(currentProfile(db, config)).toMatchObject({ from: "yours", text: "Rank political distraction stories lower." });
    expect(rulesFile().ownWords).toEqual({ text: "Rank political distraction stories lower.", updatedAt: at(1) });
    expect(db.prepare("SELECT count(*) n FROM items WHERE rescore = 1").get()).toEqual({ n: 3 });

    const g = gemma([0, 1, 2].map((k) => JSON.stringify({ interest: 10 + k, why_its_here: "Fits your words." })));
    await runB(g.llm);
    expect(g.asked[0]![0]!.content).toContain("Rank political distraction stories lower.");
    expect(db.prepare("SELECT count(*) n FROM items WHERE rescore = 1").get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT interest FROM items ORDER BY interest").all() as { interest: number }[]).map((r) => r.interest)).toEqual([10, 11, 12]);
  });
});

describe("a why on ratings", () => {
  it("keeps the note, and a rating with a note counts for half in the statistics", async () => {
    const { db, send } = setup();
    await send([
      { type: "rate", itemId: "live1", rating: -1, note: "A distraction story, not about the people in it", at: at(1) },
      { type: "rate", itemId: "essay", rating: -1, at: at(2) },
    ]);
    expect(db.prepare("SELECT rating_note FROM preference_records WHERE item_id = 'live1'").get()).toEqual({ rating_note: "A distraction story, not about the people in it" });
    const l = learn(db, NOW);
    // Two 👎 on the same tag, one with a note: 1.5 weight in all, not 2.
    const two = l.topic({ tags: ["politics"], section: null });
    expect(two.ratings).toBe(2);
    expect(two.confidence).toBeCloseTo(1.5 / 5.5, 3);
  });
});

describe("rules from what you hide", () => {
  it("drafts a Check rule from a hidden item, previews it, and approving hides what it catches", async () => {
    const { db, send, gemma, runB, moves, rulesFile } = setup();
    await send([{ type: "hide", itemId: "live1", reason: null, note: null, at: at(1) }]);
    await send([{ type: "hide", itemId: "live1", reason: "not-article", note: "Live-video posts are never worth it", at: at(2) }]);
    const reqs = db.prepare("SELECT kind, reason, note, facts_json FROM rule_requests").all() as any[];
    expect(reqs).toHaveLength(1); // one request, updated with the reason
    expect(reqs[0]).toMatchObject({ kind: "hidden-item", reason: "not-article", note: "Live-video posts are never worth it" });
    expect(JSON.parse(reqs[0].facts_json)).toMatchObject({ subject: "Ann is live now", sender: "pen@substack.com", listId: "studiolive.substack.com", links: ["https://youtube.com/live/x"] });
    expect(rulesFile().suggestions).toEqual([expect.objectContaining({ status: "drafting", from: { kind: "hidden-item", title: "Ann is live now", reason: "not-article", note: "Live-video posts are never worth it" } })]);

    const draft = {
      kind: "check", wording: "Hide live-video posts from Studio Live", source_only: true, match: "all",
      conditions: [{ field: "linksTo", op: "contains", value: "youtube.com/live" }, { field: "wordCount", op: "lessThan", value: 200 }],
    };
    const g = gemma(["```json\n" + JSON.stringify(draft) + "\n```"]);
    await runB(g.llm);
    expect(g.asked[0]![1]!.content).toContain("Live-video posts are never worth it");
    const s = rulesFile().suggestions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      id: "hide-live-video-posts-from-studio-live", status: "ready", ruleKind: "check", source: "Studio Live",
      detail: 'a link goes to "youtube.com/live" and fewer than 200 words',
    });
    // live1 is already hidden by you; live2 is what the rule would add. The long essay isn't caught.
    expect(s[0]!.wouldHide.map((i) => i.id).sort()).toEqual(["live1", "live2"]);
    expect(db.prepare("SELECT excerpt FROM rule_requests").get()).toEqual({ excerpt: null }); // the copied text is gone once drafted

    await send([{ type: "rule", ruleId: "hide-live-video-posts-from-studio-live", op: "approve", at: at(3) }]);
    expect(db.prepare("SELECT id, hidden_by FROM items ORDER BY id").all()).toEqual([
      { id: "essay", hidden_by: null },
      { id: "live1", hidden_by: "user" },
      { id: "live2", hidden_by: "hide-live-video-posts-from-studio-live" },
    ]);
    expect(moves).toEqual([["m-live1", "deleteditems"], ["m-live2", "deleteditems"]]);
    const f = rulesFile();
    expect(f.suggestions).toEqual([]);
    expect(f.rules.find((r) => r.id === "hide-live-video-posts-from-studio-live")).toMatchObject({ status: "active", hits30d: 1, source: "Studio Live" });
  });

  it("an item Gemma sees as a one-off gives no suggestion; Show it again before drafting cancels the request", async () => {
    const { db, send, gemma, runB, rulesFile } = setup();
    await send([{ type: "hide", itemId: "essay", reason: "topic", note: null, at: at(1) }]);
    await runB(gemma([JSON.stringify({ kind: "none", why_none: "A one-off essay." })]).llm);
    expect(rulesFile().suggestions).toEqual([]);
    expect(db.prepare("SELECT status FROM rule_requests").get()).toEqual({ status: "done" });

    await send([{ type: "hide", itemId: "live1", reason: null, note: null, at: at(2) }]);
    await send([{ type: "unhide", itemId: "live1", at: at(3) }]);
    expect(db.prepare("SELECT status FROM rule_requests WHERE item_id = 'live1'").get()).toEqual({ status: "dismissed" });
  });
});

describe("rules you type, edit, turn off and delete", () => {
  it("drafts an Instruction rule from your words and previews it with Gemma", async () => {
    const { send, gemma, runB, rulesFile } = setup();
    await send([{ type: "rule-add", text: "Never show me live video announcements", at: at(1) }]);
    const g = gemma([
      JSON.stringify({ kind: "instruction", wording: "Never show live video announcements", source_only: false, instruction: "Hide posts that only announce a live video." }),
      JSON.stringify({ numbers: [1, 2, 9] }), // the preview batch (9 doesn't exist and is ignored)
    ]);
    await runB(g.llm);
    expect(g.asked[1]![0]!.content).toContain("Hide posts that only announce a live video.");
    const s = rulesFile().suggestions[0]!;
    expect(s).toMatchObject({ status: "ready", ruleKind: "instruction", source: null, from: { kind: "typed", text: "Never show me live video announcements" } });
    expect(s.wouldHide).toHaveLength(2);
  });

  it("shows a typed rule Gemma couldn't draft as failed, until you dismiss it", async () => {
    const { send, gemma, runB, rulesFile } = setup();
    await send([{ type: "rule-add", text: "Be nicer", at: at(1) }]);
    await runB(gemma([JSON.stringify({ kind: "none", why_none: "That isn't something a rule can check." })]).llm);
    const s = rulesFile().suggestions;
    expect(s).toEqual([expect.objectContaining({ id: "request-1", status: "failed", error: "That isn't something a rule can check." })]);
    await send([{ type: "rule", ruleId: "request-1", op: "dismiss", at: at(2) }]);
    expect(rulesFile().suggestions).toEqual([]);
  });

  it("redrafts a reworded rule in place, and keeps your changes to config rules", async () => {
    const { db, send, gemma, runB, rulesFile } = setup();
    await send([{ type: "rule-edit", ruleId: "no-course-ads", text: "No ads for courses or paid workshops", at: at(1) }]);
    expect(rulesFile().rules[0]).toMatchObject({ id: "no-course-ads", redrafting: true });
    await runB(gemma([JSON.stringify({ kind: "instruction", wording: "No ads for courses or paid workshops", instruction: "Hide posts that mainly sell a course or paid workshop." }), JSON.stringify({ numbers: [] })]).llm);
    expect(db.prepare("SELECT status, wording, instruction FROM rules WHERE id = 'no-course-ads'").get()).toEqual({
      status: "active", wording: "No ads for courses or paid workshops", instruction: "Hide posts that mainly sell a course or paid workshop.",
    });

    // Turned off in the reader: the next sync of the same config file leaves it off.
    await send([{ type: "rule", ruleId: "no-course-ads", op: "off", at: at(2) }]);
    syncConfig(db, config);
    expect(db.prepare("SELECT status, wording FROM rules WHERE id = 'no-course-ads'").get()).toEqual({ status: "off", wording: "No ads for courses or paid workshops" });
    // Deleted in the reader: it stays deleted…
    await send([{ type: "rule", ruleId: "no-course-ads", op: "delete", at: at(3) }]);
    syncConfig(db, config);
    expect(db.prepare("SELECT count(*) n FROM rules").get()).toEqual({ n: 0 });
    // …unless you change it in the config file, which is the later change.
    syncConfig(db, Config.parse({ ...config, rules: [{ ...config.rules[0]!, wording: "No course ads, ever" }] }));
    expect(db.prepare("SELECT status, wording FROM rules").get()).toEqual({ status: "active", wording: "No course ads, ever" });
  });
});

describe("reading Gemma's drafts", () => {
  const sources = [{ id: "news-at-techdigest-example", name: "Tech Digest" }, { id: "pen", name: "Studio Live" }];
  it("finds the newsletter a typed rule names, and ignores stray conditions on an instruction", () => {
    const reply = JSON.stringify({
      kind: "instruction", wording: "Hide posts from Tech Digest that are about crypto.", source_only: true, newsletter: "Tech Digest",
      conditions: [{ field: "body", op: "matches", value: "(?i)(crypto|bitcoin)" }], instruction: "Hide posts that are mainly about cryptocurrency.",
    });
    expect(ruleFromReply(reply, { kind: "typed", text: "Hide anything from Tech Digest about crypto", source_id: null }, null, sources)).toEqual({
      ok: true,
      rule: { kind: "instruction", wording: "Hide posts from Tech Digest that are about crypto.", match: null, conditions: null, instruction: "Hide posts that are mainly about cryptocurrency.", sourceId: "news-at-techdigest-example" },
    });
  });

  it("accepts a regular expression written with (?i), and refuses a newsletter you don't have", () => {
    const check = JSON.stringify({ kind: "check", wording: "No crypto", match: "any", conditions: [{ field: "subject", op: "matches", value: "(?i)bitcoin|crypto" }] });
    const r = ruleFromReply(check, { kind: "typed", text: "No crypto", source_id: null }, null, sources);
    expect(r).toMatchObject({ ok: true, rule: { kind: "check", conditions: [{ field: "subject", op: "matches", value: "bitcoin|crypto" }], sourceId: null } });
    const wrong = JSON.stringify({ kind: "instruction", wording: "x", newsletter: "Breakfast Bulletin", instruction: "Hide x." });
    expect(ruleFromReply(wrong, { kind: "typed", text: "x", source_id: null }, null, sources)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't yours/) });
    expect(ruleFromReply("{\"kind\": 3}", { kind: "typed", text: "x", source_id: null }, null, sources)).toMatchObject({ ok: false, error: expect.stringMatching(/kind/) });
  });
});
