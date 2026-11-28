import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Edition } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { extractCartoon } from "../src/content/cartoon.ts";
import { publish } from "../src/pipeline/publish.ts";
import { editSource } from "../src/pipeline/sources.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const cartoonEmail = (caption: string | null) => `<div><h2>More in Humor</h2><p>An essay.</p></div>
<div><h1><span>Today’s Cartoon, by A. N. Artist</span></h1></div>
<table><tr><td><img alt="A robot slips on a banana peel." src="https://img.example/cartoon.jpg" width="536"></td></tr></table>
${caption ? `<div><p><span><em>${caption}</em></span></p></div>` : ""}
<div><a href="https://links.example/more">See more cartoons</a></div>
<div><h2>Cartoons from This Week’s Issue</h2><img alt="Another" src="https://img.example/other.jpg"></div>`;

describe("the cartoon of the day", () => {
  it("finds the cartoon, its caption (text under the drawing) and the artist", () => {
    expect(extractCartoon(cartoonEmail("“It’s the one thing we can’t seem to crack.”"))).toEqual({
      imageUrl: "https://img.example/cartoon.jpg", alt: "A robot slips on a banana peel.", caption: "“It’s the one thing we can’t seem to crack.”", artist: "A. N. Artist",
    });
    expect(extractCartoon(cartoonEmail(null))?.caption).toBeNull(); // a wordless cartoon
    expect(extractCartoon("<p>No cartoon here.</p><img src='https://x/y.jpg'>")).toBeNull();
  });
});

describe("publishing the cartoon and always-shown newsletters", () => {
  const NOW = new Date("2026-11-27T20:00:00Z");
  function setup() {
    const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at, always_show, cartoon) VALUES ('eve', 'email', 'Evening Letter', 'enabled', 'auto', 'x', 1, 0), ('ny', 'email', 'Cartoon Daily', 'enabled', 'auto', 'x', 0, 1), ('o', 'email', 'Other', 'enabled', 'auto', 'x', 0, 0)").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-cartoon-"));
    const add = (id: string, source: string, at: string, html = "<p>Words.</p>", cartoon: object | null = null, interest = 50) => {
      db.prepare("INSERT INTO items (id, source_id, channel, title, published_at, created_at, ai_status, summary, interest, is_article, section_id, cartoon_json) VALUES (?, ?, 'email', ?, ?, 'x', 'done', 'A summary of it.', ?, 1, 'current-events', ?)")
        .run(id, source, `Post ${id}`, at, interest, cartoon ? JSON.stringify(cartoon) : null);
      mkdirSync(join(contentDir, id), { recursive: true });
      writeFileSync(join(contentDir, id, "article.html"), html);
    };
    let edition: Edition | undefined;
    const appFolder = { put: async () => ({ id: "x", size: 1 }), putJson: async (p: string, v: unknown) => ((edition = p === "edition.json" ? Edition.parse(v) : edition), { id: p, size: 1 }) };
    const fetchImage = (async () => new Response(new Uint8Array(20_000), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    const pub = () => publish({ db, appFolder, config, contentDir, now: NOW, fetchImage });
    return { db, add, pub, contentDir, edition: () => edition! };
  }

  it("shows the newest cartoon from the last 24 hours, with its caption, from its cached image", async () => {
    const t = setup();
    const c = extractCartoon(cartoonEmail("“A caption.”"))!;
    t.add("ny-old", "ny", "2026-11-26T12:00:00Z", cartoonEmail("“Old.”"), { ...c, caption: "“Old.”" });
    t.add("ny-new", "ny", "2026-11-27T12:00:00Z", cartoonEmail("“A caption.”"), c);
    await t.pub();
    expect(t.edition().cartoon).toMatchObject({ caption: "“A caption.”", artist: "A. N. Artist", source: "Cartoon Daily", itemId: "ny-new" });
    expect(t.edition().cartoon!.image).toMatch(/^images\/[0-9a-f]{20}\.jpg$/);
  });

  it("shows cartoons only from newsletters set to show them", async () => {
    const t = setup();
    t.add("o-1", "o", "2026-11-27T12:00:00Z", cartoonEmail("“Elsewhere.”"), extractCartoon(cartoonEmail("“Elsewhere.”")));
    await t.pub();
    expect(t.edition().cartoon).toBeNull();
    t.db.prepare("UPDATE sources SET cartoon = 1 WHERE id = 'o'").run();
    await t.pub();
    expect(t.edition().cartoon).toMatchObject({ caption: "“Elsewhere.”", itemId: "o-1" });
  });

  it("turning it on finds the cartoon in that newsletter's current emails", async () => {
    const t = setup();
    t.add("o-2", "o", "2026-11-27T12:00:00Z", cartoonEmail("“Found.”"));
    const mail = {} as MailPort; // no emails move for this change
    const r = await editSource(t.db, mail, "o", { cartoon: true }, { contentDir: t.contentDir, cutoff: "2026-11-20T00:00:00Z", now: NOW.toISOString() });
    expect(r.changed).toEqual(["shows its cartoon of the day (found 1 in current emails)"]);
    await t.pub();
    expect(t.edition().cartoon).toMatchObject({ caption: "“Found.”", itemId: "o-2" });
    const off = await editSource(t.db, mail, "o", { cartoon: false }, { contentDir: t.contentDir, cutoff: "2026-11-20T00:00:00Z", now: NOW.toISOString() });
    expect(off.changed).toEqual(["no longer shows its cartoon"]);
    await t.pub();
    expect(t.edition().cartoon).toBeNull();
  });

  it("leaves it out when none came in the last 24 hours", async () => {
    const t = setup();
    t.add("ny-old", "ny", "2026-11-26T12:00:00Z", cartoonEmail("“Old.”"), extractCartoon(cartoonEmail("“Old.”")));
    await t.pub();
    expect(t.edition().cartoon).toBeNull();
  });

  it("pins only the newest post of an always-shown newsletter", async () => {
    const t = setup();
    t.add("eve-1", "eve", "2026-11-26T05:00:00Z", undefined, null, 90);
    t.add("eve-2", "eve", "2026-11-27T05:00:00Z", undefined, null, 10); // newest, even with a low score
    t.add("other", "o", "2026-11-27T06:00:00Z");
    await t.pub();
    expect(t.edition().items.filter((i) => i.pinned).map((i) => i.id)).toEqual(["eve-2"]);
  });

  it("keeps an always-shown newsletter in the paper even if Gemma called it 'not an article'", async () => {
    const t = setup();
    t.add("eve-3", "eve", "2026-11-27T05:00:00Z");
    t.db.prepare("UPDATE items SET is_article = 0 WHERE id = 'eve-3'").run();
    await t.pub();
    expect(t.edition().items.find((i) => i.id === "eve-3")?.pinned).toBe(true);
    expect(t.edition().hidden).toEqual([]);
  });
});
