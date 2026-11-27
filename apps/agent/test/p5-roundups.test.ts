import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Edition } from "@broadsheet/shared";
import { looksLikeRoundup, splitPieces } from "../src/content/split.ts";
import { stripTracking } from "../src/content/clean.ts";
import { stageAEmail, itemIdFor, type MailPort } from "../src/pipeline/stage-a-email.ts";
import { stageB } from "../src/pipeline/stage-b.ts";
import { publish, sameStoryOnce } from "../src/pipeline/publish.ts";
import { setFormat } from "../src/pipeline/split.ts";
import { openDb, syncConfig } from "../src/db/db.ts";
import type { LlmProvider } from "../src/ai/provider.ts";
import type { ActivitySample } from "../src/activity.ts";

// ---- A made-up roundup, laid out like a typical one: contents, then a heading over each story ----------------

const story = (title: string, body: string, link: string) =>
  `<table><tr><td><h2>${title}</h2></td></tr><tr><td><img src="https://img.example/${title.length}.jpg" width="576"><p><strong>${body}</strong> ${"More detail on the story follows here. ".repeat(8)}</p>
   <p><a href="${link}?email=reader@example.com&amp;utm_source=x">Read more</a></p></td></tr></table>`;
const roundup = `<html><body><table><tr><td><h1>The Daily Roundup</h1><p>Good morning. Here's what matters today, in brief.</p></td></tr>
<tr><td><h2>Today</h2><ol><li>Ports</li><li>Chips</li><li>Elections</li><li>Gardens</li></ol></td></tr></table>
${story("New port fees draw pushback", "Allies pushed back on proposed port fees.", "https://news.example/port-fees")}
${story("China grows its chip sector", "Chipmakers reported record profits.", "https://news.example/chips")}
${story("Coastal town votes on a seawall", "Residents vote on Sunday.", "https://news.example/seawall")}
${story("Frost dates move later", "Gardeners get another week before the first frost.", "https://garden.example/frost")}
<table><tr><td><h2>A word from our sponsor</h2><p>Try Widgets today.</p></td></tr></table>
<p>© 2026 Daily Roundup · <a href="https://roundup.example/unsub">Unsubscribe</a></p>
</body></html>`;

describe("splitting a newsletter at its headings", () => {
  it("makes one piece per story, leaving out the intro, the contents and a one-line sponsor slot", () => {
    const pieces = splitPieces(roundup)!;
    expect(pieces.map((p) => p.title)).toEqual(["New port fees draw pushback", "China grows its chip sector", "Coastal town votes on a seawall", "Frost dates move later"]);
    expect(pieces[0]!.opening).toMatch(/^Allies pushed back/);
    expect(pieces[0]!.html).toContain("img.example");
    expect(pieces[0]!.text).not.toMatch(/Good morning|Spaniards/);
    expect(pieces[3]!.links).toEqual(["https://garden.example/frost"]); // your address and utm_ tracking removed
    expect(splitPieces(roundup.replaceAll("</p>\n   <p>", '</p><img src="https://static.example/images/x-post.png" width="79"><p>'))![0]!.html).not.toContain("x-post");
  });

  it("doesn't split an essay with no headings, and finds bold lead-in lines when there are no headings", () => {
    expect(splitPieces(`<p>${"One long essay paragraph. ".repeat(80)}</p>`)).toBeNull();
    const bold = ["Markets slide", "Rates hold", "Oil climbs"].map((t) => `<p><strong>${t}</strong></p><p>${"Something happened in markets today. ".repeat(10)}</p>`).join("");
    expect(splitPieces(bold)!.map((p) => p.title)).toEqual(["Markets slide", "Rates hold", "Oil climbs"]);
  });

  it("suggests 'roundup' only for many short pieces", () => {
    const five = Array.from({ length: 5 }, (_, i) => story(`Story number ${i} today`, "Something happened.", `https://n.example/${i}`)).join("");
    expect(looksLikeRoundup(five)).toBe(true);
    expect(looksLikeRoundup(roundup)).toBe(false); // four stories
    const essay = Array.from({ length: 5 }, (_, i) => `<h2>Part ${i}</h2><p>${"A long section of an essay. ".repeat(80)}</p>`).join("");
    expect(looksLikeRoundup(essay)).toBe(false);
  });

  it("drops your email address from links, as well as utm_ tracking", () => {
    expect(stripTracking("https://roundup.example/s/abc?email=someone@outlook.com&id=3&utm_source=n")).toBe("https://roundup.example/s/abc?id=3");
  });
});

// ---- From the Inbox to News in Brief ---------------------------------------------------------------------

const mime = (subject: string, from: string, messageId: string, body: string) =>
  [`From: ${from}`, `To: reader@example.com`, `Subject: ${subject}`, `Message-ID: <${messageId}>`, `Date: Fri, 27 Nov 2026 06:00:00 +0000`,
    `MIME-Version: 1.0`, `Content-Type: text/html; charset=utf-8`, ``, body].join("\r\n");

const config = Config.parse({
  microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
  sources: [
    { id: "roundup", channel: "email", name: "Daily Roundup", match: { sender: "daily@roundup.example" }, format: "roundup" },
    { id: "other", channel: "email", name: "Other Roundup", match: { sender: "hi@other.example" }, format: "roundup" },
  ],
});
const NOW = new Date("2026-11-27T12:00:00Z");
const away: ActivitySample = { idleSeconds: 3600, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };

/** Gemma, faked: the section comes from the story's headline. */
const llm: LlmProvider = {
  id: "fake",
  chat: async (messages) => {
    const user = messages.at(-1)!.content;
    const title = user.match(/^Title: (.*)$/m)![1]!;
    const section = /frost/i.test(title) ? "gardening" : /chip/i.test(title) ? "technology" : "current-events";
    expect(user).toContain('ONE short story from the roundup newsletter "The Daily Roundup"');
    return {
      text: JSON.stringify({ is_article: true, summary: `In brief: ${title}.`, key_points: [], section, tags: [], interest: 60, why_its_here: "x", read_minutes: 1, hidden_by_rule: null }),
      promptTokens: 1, outputTokens: 1, seconds: 1,
    };
  },
  isLoaded: async () => true,
  unload: async () => {},
};

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT'), ('folder:_add', 'ADD')").run();
  const messages = [{ id: "m1", folder: "inbox", subject: "The Daily Roundup", mime: mime("The Daily Roundup", "Daily Roundup <daily@roundup.example>", "m1@x", roundup) }];
  const moves: [string, string][] = [];
  const mail: MailPort = {
    list: async (folder) =>
      messages.filter((m) => m.folder === folder).map((m) => ({ id: m.id, subject: m.subject, internetMessageId: `<${m.id}@x>`, receivedDateTime: "2026-11-27T06:00:00Z", isRead: false, from: { emailAddress: { address: "x", name: "x" } } })) as any,
    mime: async (id) => messages.find((m) => m.id === id)!.mime,
    move: async (id, to) => (moves.push([id, to]), (messages.find((m) => m.id === id)!.folder = to), id),
    markRead: async () => {},
  };
  const files = new Map<string, unknown>();
  let edition: Edition | undefined;
  const appFolder = {
    list: async (folder: string) => [...files.keys()].filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1)),
    delete: async (path: string) => void files.delete(path),
    put: async (path: string) => (files.set(path, true), { id: path, size: 1 }),
    putJson: async (path: string, v: unknown) => ((edition = path === "edition.json" ? Edition.parse(v) : edition), { id: path, size: 1 }),
  };
  const contentDir = mkdtempSync(join(tmpdir(), "bs-p5-"));
  const fetchImage = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
  const pub = () => publish({ db, appFolder, config, contentDir, now: NOW, fetchImage });
  return { db, mail, moves, files, contentDir, pub, edition: () => edition! };
}

describe("a roundup newsletter", () => {
  it("is split when it arrives, Gemma reads each story, and the email is filed where most of them land", async () => {
    const { db, mail, moves, files, contentDir, pub, edition } = setup();
    const a = await stageAEmail({ mail, db, config, contentDir, dryRun: false, now: NOW });
    const parent = itemIdFor("<m1@x>");
    expect(a.outcomes[0]).toMatchObject({ pieces: 4, destination: "_Sorting" });
    expect(db.prepare("SELECT kind, ai_status FROM items WHERE id = ?").get(parent)).toEqual({ kind: "newsletter", ai_status: "skipped" });
    expect(db.prepare("SELECT id, kind, ai_status, message_id FROM items WHERE parent_id = ? ORDER BY piece").all(parent)).toEqual(
      [1, 2, 3, 4].map((n) => ({ id: `${parent}-${n}`, kind: "brief", ai_status: "pending", message_id: null })),
    );
    expect(readFileSync(join(contentDir, `${parent}-3`, "article.txt"), "utf8")).toContain("Residents vote on Sunday");

    // Before Gemma: the briefs show their opening lines; the newsletter itself isn't a card.
    await pub();
    expect(edition().items.map((i) => i.kind)).toEqual(["brief", "brief", "brief", "brief"]);
    expect(edition().items[0]!.newsletter).toEqual({ title: "The Daily Roundup", content: `items/${parent}.html` });
    expect(files.has(`items/${parent}.html`)).toBe(true);

    const b = await stageB({ db, config, llm, mail, contentDir, sampleActivity: async () => away });
    expect(b.outcomes.map((o) => o.result)).toEqual([
      "Current Events, interest 60", "Technology, interest 60", "Current Events, interest 60", "Gardening, interest 60 (the whole newsletter → Current Events)",
    ]);
    expect(moves).toEqual([["m1", "SORT"], ["m1", "F-current-events"]]);

    await pub();
    const briefs = edition().items;
    expect(briefs.map((i) => [i.title, i.section, i.summary])).toEqual(
      expect.arrayContaining([["Frost dates move later", "gardening", "In brief: Frost dates move later."], ["New port fees draw pushback", "current-events", "In brief: New port fees draw pushback."]]),
    );
    expect(edition().hidden).toEqual([]);
  });

  it("shows a story carried by two roundups once, with 'also in'", () => {
    const card = (id: string, title: string, source: string, score: number) =>
      ({ id, title, source, score, kind: "brief", alsoIn: [] as string[] }) as any;
    const cards = [card("a", "New port fees draw pushback", "Daily Roundup", 0.9), card("b", "Port fees draw pushback from allies", "Other Roundup", 0.8), card("c", "Seawall vote", "Other Roundup", 0.7), card("d", "Something else", "Other Roundup", 0.6), card("e", "Unrelated", "Daily Roundup", 0.5)];
    const extra = new Map<string, { links: string[]; sender: string | null; piece: boolean }>([
      ["a", { links: ["https://roundup.example/s/1"], sender: "daily@roundup.example", piece: true }],
      ["b", { links: [], sender: "hi@other.example", piece: true }],
      ["c", { links: ["https://news.example/seawall?ref=other"], sender: "hi@other.example", piece: true }],
      ["d", { links: ["https://roundup.example/s/1"], sender: "hi@other.example", piece: true }], // the other newsletter's own site: says nothing
      ["e", { links: ["https://news.example/seawall/"], sender: "daily@roundup.example", piece: true }],
    ]);
    const out = sameStoryOnce(cards, extra);
    expect(out.map((c) => [c.id, c.alsoIn])).toEqual([["a", ["Other Roundup"]], ["c", ["Daily Roundup"]], ["d", []]]);
  });

  it("goes back to one article when its format is set back to normal", async () => {
    const { db, mail, contentDir, pub, edition } = setup();
    await stageAEmail({ mail, db, config, contentDir, dryRun: false, now: NOW });
    const parent = itemIdFor("<m1@x>");
    await pub();
    const r = await setFormat(db, contentDir, "roundup", "normal", "2026-11-23T12:00:00Z", NOW.toISOString());
    expect(r).toMatchObject({ joined: 1 });
    expect(db.prepare("SELECT kind, ai_status FROM items WHERE id = ?").get(parent)).toEqual({ kind: "article", ai_status: "pending" });
    await pub(); // the pieces are removed everywhere, like expired items
    expect(edition().items.map((i) => [i.id, i.kind])).toEqual([[parent, "article"]]);
    expect(db.prepare("SELECT count(*) n FROM items WHERE id LIKE ?").get(`${parent}-%`)).toEqual({ n: 0 });
    expect(existsSync(join(contentDir, `${parent}-1`))).toBe(false);

    // And split again.
    expect(await setFormat(db, contentDir, "roundup", "roundup", "2026-11-23T12:00:00Z", NOW.toISOString())).toMatchObject({ split: 1 });
    expect(db.prepare("SELECT count(*) n FROM items WHERE parent_id = ?").get(parent)).toEqual({ n: 4 });
    // Splitting once more keeps what Gemma read, since the words haven't changed; multi-section makes them articles.
    db.prepare("UPDATE items SET ai_status = 'done' WHERE parent_id = ?").run(parent);
    await setFormat(db, contentDir, "roundup", "multi-section", "2026-11-23T12:00:00Z", NOW.toISOString());
    expect(db.prepare("SELECT DISTINCT kind, ai_status FROM items WHERE parent_id = ?").all(parent)).toEqual([{ kind: "article", ai_status: "done" }]);
  });

  it("takes the format from the config file, and keeps `broadsheet format`'s choice when the file doesn't say", () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    expect(db.prepare("SELECT format FROM sources WHERE id = 'roundup'").get()).toEqual({ format: "roundup" });
    const without = Config.parse({ ...config, sources: [{ id: "roundup", channel: "email", match: { sender: "daily@roundup.example" } }] });
    db.prepare("UPDATE sources SET format = 'multi-section' WHERE id = 'roundup'").run();
    syncConfig(db, without);
    expect(db.prepare("SELECT format FROM sources WHERE id = 'roundup'").get()).toEqual({ format: "multi-section" });
  });
});

describe("an old email you drop into _Add", () => {
  it("is filed in its section but never shown, and its record goes once it's filed", async () => {
    const { db, mail, moves, contentDir, pub, edition } = setup();
    const old = mime("A post from last month", "Daily Roundup <daily@roundup.example>", "old@x", roundup);
    const list = mail.list;
    mail.list = async (folder, since) =>
      folder === "ADD" ? ([{ id: "old", subject: "A post from last month", internetMessageId: "<old@x>", receivedDateTime: "2026-10-20T06:00:00Z", isRead: true, from: { emailAddress: { address: "x", name: "x" } } }] as any) : list(folder, since);
    const mime0 = mail.mime;
    mail.mime = async (id) => (id === "old" ? old : mime0(id));
    mail.move = async (id, to) => (moves.push([id, to]), id);

    const a = await stageAEmail({ mail, db, config, contentDir, dryRun: false, now: NOW });
    const id = itemIdFor("<old@x>");
    expect(a.outcomes.find((o) => o.subject === "A post from last month")).toMatchObject({ destination: "_Sorting (older than 4 days: filed, not in the paper)" });
    expect(a.outcomes.find((o) => o.subject === "A post from last month")!.pieces).toBeUndefined(); // too old to split
    await pub();
    expect(edition().items.some((i) => i.id === id)).toBe(false);
    expect(db.prepare("SELECT ai_status FROM items WHERE id = ?").get(id)).toEqual({ ai_status: "pending" }); // kept until filed

    const fileOnly: LlmProvider = {
      ...llm,
      chat: async () => ({ text: JSON.stringify({ is_article: true, summary: "An old post about gardens and frost.", key_points: [], section: "gardening", tags: [], interest: 50, why_its_here: "x", read_minutes: 3, hidden_by_rule: null }), promptTokens: 1, outputTokens: 1, seconds: 1 }),
    };
    db.prepare("UPDATE items SET ai_status = 'done' WHERE parent_id IS NOT NULL").run(); // only the old one is left for Gemma
    await stageB({ db, config, llm: fileOnly, mail, contentDir, sampleActivity: async () => away });
    expect(moves).toContainEqual(["old", "F-gardening"]);
    await pub();
    expect(db.prepare("SELECT count(*) n FROM items WHERE id = ?").get(id)).toEqual({ n: 0 });
    expect(existsSync(join(contentDir, id))).toBe(false);
  });
});
