import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { cleanArticle, canonicalFrom } from "../src/content/clean.ts";
import { parseEmail, platformOf } from "../src/content/email.ts";
import { accountMailReason, classify, matchSource, newSourceFor, splitSenderName, type EmailFacts, type RuleRow } from "../src/pipeline/classify.ts";
import { stageAEmail, itemIdFor, type MailPort } from "../src/pipeline/stage-a-email.ts";
import { openDb, syncConfig } from "../src/db/db.ts";

// ---- A made-up Substack-style email -------------------------------------------------------------------

const html = `<html><body>
<div style="display:none;max-height:0">Preview text ͏ ­͏ ­͏ ­</div>
<table><tr><td><p>Forwarded this email? Subscribe here for more</p></td></tr>
<tr><td><h1>Tomatoes in November</h1><img src="https://cdn.example/avatar.png" width="32" height="32"></td></tr>
<tr><td><p>Late tomatoes need a warm wall and a little patience to ripen before the first frost arrives.</p>
<a href="https://cdn.example/big"><img src="https://cdn.example/big.jpg" width="550" alt="Tomatoes"></a>
<p>Pick them green and bring them inside if the forecast turns cold, then wait a week or two.</p>
<p><a href="https://garden.example/p/tomatoes-in-november?utm_source=email&amp;id=7">Read online</a></p>
<p><a href="https://garden.example/like">Like</a> <a href="https://garden.example/c">Comment</a></p></td></tr>
<tr><td><p>© 2026 Garden Letter · <a href="https://garden.example/unsub">Unsubscribe</a></p><p>Footer address line</p></td></tr></table>
<img src="https://track.example/p.gif" width="1" height="1">
</body></html>`;

const mime = (o: { subject: string; from: string; listId?: string; listPost?: string; messageId: string; body?: string }) =>
  [
    `From: ${o.from}`,
    `To: reader@example.com`,
    `Subject: ${o.subject}`,
    `Message-ID: <${o.messageId}>`,
    `Date: Wed, 26 Nov 2026 10:00:00 +0000`,
    ...(o.listId ? [`List-Id: <${o.listId}>`, `List-Unsubscribe: <https://example.com/unsub>`] : []),
    ...(o.listPost ? [`List-Post: <${o.listPost}>`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    o.body ?? html,
  ].join("\r\n");

describe("cleaning an email", () => {
  it("keeps the article and images, drops tracking, icons, banner, buttons and footer", () => {
    const c = cleanArticle(html, "", { title: "Tomatoes in November" });
    expect(c.html).toContain("big.jpg");
    expect(c.html).not.toMatch(/p\.gif|avatar\.png|Preview text|Forwarded this email|>Like<|Unsubscribe|Footer address/);
    expect(c.html).not.toContain("utm_source");
    expect(c.text).toContain("Pick them green");
    expect(c.opening.startsWith("Late tomatoes")).toBe(true);
    expect(c.canonicalUrl).toBe("https://garden.example/p/tomatoes-in-november");
    expect(c.heroImage).toBe("https://cdn.example/big.jpg");
    expect(c.links).toContain("https://garden.example/like"); // links are collected before cleanup, for rules
  });

  it("prefers the List-Post header for the post's address, and understands open.substack.com links", () => {
    expect(cleanArticle(html, "", { listPost: "https://www.example.com/p/real-post" }).canonicalUrl).toBe("https://www.example.com/p/real-post");
    expect(canonicalFrom(["https://substack.com/redirect/abc", "https://open.substack.com/pub/garden/p/tomatoes?r=1"])).toBe("https://garden.substack.com/p/tomatoes");
  });

  it("reads headers and spots the platform", async () => {
    const e = await parseEmail(mime({ subject: "Tomatoes", from: "Ann Lee from Garden Letter <garden@substack.com>", listId: "garden.substack.com", listPost: "https://garden.substack.com/p/t", messageId: "a@x" }));
    expect(e.listId).toBe("garden.substack.com");
    expect(e.listPost).toBe("https://garden.substack.com/p/t");
    expect(e.hasListUnsubscribe).toBe(true);
    expect(platformOf(e)).toBe("substack");
    expect(splitSenderName(e.from.name)).toEqual({ author: "Ann Lee", publication: "Garden Letter" });
  });
});

// ---- Decisions ----------------------------------------------------------------------------------------

const facts = (o: Partial<EmailFacts> = {}): EmailFacts => ({
  sender: "garden@substack.com", senderName: "Garden Letter", subject: "Tomatoes in November", listId: "garden.substack.com",
  hasListUnsubscribe: true, platform: "substack", text: "words ".repeat(400), wordCount: 400, links: [], fromAddFolder: false, ...o,
});

describe("deciding what to do with an email", () => {
  const liveVideo: RuleRow = {
    id: "no-live-video", kind: "check", match: "all", sourceId: null, mail: "deleted-items",
    conditions: [{ field: "linksTo", op: "contains", value: "/live" }, { field: "wordCount", op: "lessThan", value: 150 }],
  };

  it("includes newsletters, into a fixed section if the source has one", () => {
    expect(classify(facts(), { mode: "dedicated", source: null, rules: [] })).toMatchObject({ action: "include", sectionId: null });
    const src = { id: "g", match: { listId: "garden.substack.com" }, status: "enabled" as const, fixedSectionId: "gardening" };
    expect(classify(facts(), { mode: "dedicated", source: src, rules: [] })).toMatchObject({ action: "include", sectionId: "gardening" });
  });

  it("leaves sign-in links, receipts, welcome and Microsoft emails in the Inbox", () => {
    expect(accountMailReason(facts({ subject: "Your login link for Substack", wordCount: 40 }))).not.toBeNull();
    expect(accountMailReason(facts({ subject: "Welcome to Status. There's more to explore", wordCount: 290 }))).not.toBeNull();
    expect(accountMailReason(facts({ sender: "account-security-noreply@accountprotection.microsoft.com" }))).not.toBeNull();
    expect(accountMailReason(facts({ subject: "Receipt for your payment", wordCount: 2000 }))).toBeNull(); // long: probably an article
    expect(accountMailReason(facts())).toBeNull();
  });

  it("hides what a Check rule matches, but never something you dropped in _Add", () => {
    const f = facts({ links: ["https://x.substack.com/live/123"], wordCount: 40 });
    expect(classify(f, { mode: "dedicated", source: null, rules: [liveVideo] })).toMatchObject({ action: "hide", ruleId: "no-live-video" });
    expect(classify({ ...f, wordCount: 900 }, { mode: "dedicated", source: null, rules: [liveVideo] }).action).toBe("include");
    expect(classify({ ...f, fromAddFolder: true }, { mode: "dedicated", source: null, rules: [liveVideo] }).action).toBe("include");
  });

  it("respects muted sources and shared-mailbox include rules", () => {
    const muted = { id: "g", match: null, status: "muted" as const, fixedSectionId: null };
    expect(classify(facts(), { mode: "dedicated", source: muted, rules: [] }).action).toBe("skip");
    const include: RuleRow = { id: "inc", kind: "include", match: "any", sourceId: null, sectionId: "gardening", conditions: [{ field: "domain", op: "equals", value: "substack.com" }] };
    expect(classify(facts(), { mode: "shared", source: null, rules: [] }).action).toBe("skip");
    expect(classify(facts(), { mode: "shared", source: null, rules: [include] })).toMatchObject({ action: "include", sectionId: "gardening" });
  });

  it("matches sources by sender, then List-Id, then domain; names new ones sensibly", () => {
    const sources = [
      { id: "by-domain", match: { domain: "substack.com" }, status: "enabled" as const, fixedSectionId: null },
      { id: "by-list", match: { listId: "garden.substack.com" }, status: "enabled" as const, fixedSectionId: null },
    ];
    expect(matchSource(facts(), sources)?.id).toBe("by-list");
    expect(matchSource(facts({ listId: null }), sources)?.id).toBe("by-domain");
    expect(newSourceFor({ sender: "garden@substack.com", senderName: "Ann Lee from Garden Letter", listId: "garden.substack.com" }, new Set(["garden"])))
      .toEqual({ id: "garden-2", displayName: "Garden Letter", match: { listId: "garden.substack.com" } });
  });
});

// ---- Stage A against a fake mailbox --------------------------------------------------------------------

function fakeMailbox(messages: { id: string; folder: string; mime: string; internetMessageId: string; subject: string }[]) {
  const moves: [string, string][] = [];
  const port: MailPort = {
    list: async (folder) =>
      messages.filter((m) => m.folder === folder).map((m) => ({ id: m.id, internetMessageId: m.internetMessageId, subject: m.subject, receivedDateTime: "2026-11-26T10:00:00Z", isRead: false })),
    mime: async (id) => messages.find((m) => m.id === id)!.mime,
    move: async (id, dest) => {
      moves.push([id, dest]);
      messages.find((m) => m.id === id)!.folder = dest;
      return id;
    },
    markRead: async () => {},
  };
  return { port, moves };
}

describe("Stage A for email", () => {
  const config = Config.parse({
    microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
    rules: [{ id: "no-promos", kind: "check", wording: "No promos", conditions: [{ field: "subject", op: "contains", value: "last chance" }] }],
  });

  function setup() {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT'), ('folder:_add', 'ADD')").run();
    const mk = (id: string, subject: string, from = "Ann Lee from Garden Letter <garden@substack.com>", folder = "inbox") => ({
      id, folder, subject, internetMessageId: `<${id}@x>`,
      mime: mime({ subject, from, listId: "garden.substack.com", messageId: `${id}@x` }),
    });
    const box = fakeMailbox([
      mk("m1", "Tomatoes in November"),
      mk("m2", "Your login link", "Substack <no-reply@substack.com>"),
      mk("m3", "Last chance to save 50%"),
      mk("m4", "Something I dropped in", "Someone <someone@example.com>", "ADD"),
    ]);
    const contentDir = mkdtempSync(join(tmpdir(), "bs-content-"));
    return { db, box, contentDir };
  }

  it("dry run decides but changes nothing", async () => {
    const { db, box, contentDir } = setup();
    const r = await stageAEmail({ mail: box.port, db, config, contentDir, dryRun: true });
    expect(r.counts).toMatchObject({ included: 2, skipped: 1, hidden: 1, errors: 0 });
    expect(box.moves).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM items").get()).toEqual({ n: 0 });
  });

  it("files, hides, leaves account mail alone, saves content, and never processes an email twice", async () => {
    const { db, box, contentDir } = setup();
    const r = await stageAEmail({ mail: box.port, db, config, contentDir, dryRun: false });
    expect(r.counts).toMatchObject({ included: 2, skipped: 1, hidden: 1, newSources: 1, errors: 0 }); // both test emails share one List-Id
    expect(box.moves).toEqual(expect.arrayContaining([["m1", "SORT"], ["m3", "deleteditems"], ["m4", "SORT"]]));
    expect(box.moves.some(([id]) => id === "m2")).toBe(false);

    const item = db.prepare("SELECT title, author, ai_status, source_id FROM items WHERE id = ?").get(itemIdFor("<m1@x>")) as any;
    expect(item).toEqual({ title: "Tomatoes in November", author: "Ann Lee", ai_status: "pending", source_id: "garden" });
    expect(readFileSync(join(contentDir, itemIdFor("<m1@x>"), "article.txt"), "utf8")).toContain("Late tomatoes");
    expect(db.prepare("SELECT hidden_by FROM items WHERE id = ?").get(itemIdFor("<m3@x>"))).toEqual({ hidden_by: "no-promos" });

    const again = await stageAEmail({ mail: box.port, db, config, contentDir, dryRun: false });
    expect(again.outcomes).toEqual([]); // m2 stayed in the Inbox but is remembered as seen
  });

  it("undoes its record when the move fails, so the next run tries again", async () => {
    const { db, box, contentDir } = setup();
    box.port.move = async () => {
      throw new Error("Graph is down");
    };
    const r = await stageAEmail({ mail: box.port, db, config, contentDir, dryRun: false });
    expect(r.counts.errors).toBe(3);
    expect(db.prepare("SELECT count(*) n FROM items").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT key FROM seen").all()).toEqual([{ key: "mail:<m2@x>" }]); // only the skipped one
    expect(existsSync(join(contentDir, itemIdFor("<m1@x>")))).toBe(false);
  });
});
