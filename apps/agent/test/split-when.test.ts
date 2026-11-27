import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { afterFiling, describeSplitWhen, setSplitWhen, shouldSplit, splitWhenOf } from "../src/pipeline/split.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
const roundupHtml = Array.from({ length: 5 }, (_, i) => `<h2>Story number ${i} today</h2><p>${"Something happened in the world today. ".repeat(12)}</p>`).join("");
const essayHtml = `<p>${"One long essay paragraph about a single subject. ".repeat(80)}</p>`;
const SAT = "2026-11-28T15:00:00Z"; // a Saturday afternoon in the US
const TUE = "2026-11-24T15:00:00Z";

describe("splitting only some of a newsletter's emails", () => {
  it("splits when any condition matches, or always when none is set", () => {
    const email = (subject: string, receivedAt: string, html = essayHtml) => ({ subject, receivedAt, html });
    expect(shouldSplit(null, email("Anything", TUE))).toBe(true);
    expect(shouldSplit({ weekend: true }, email("Daily", SAT))).toBe(true);
    expect(shouldSplit({ weekend: true }, email("Daily", TUE))).toBe(false);
    expect(shouldSplit({ subject: "weekend edition" }, email("The Weekend Edition: 12 stories", TUE))).toBe(true);
    expect(shouldSplit({ looksLike: true }, email("Daily", TUE, roundupHtml))).toBe(true);
    expect(shouldSplit({ looksLike: true, subject: "Roundup" }, email("Daily", TUE))).toBe(false);
    expect(describeSplitWhen({ subject: "Weekend", weekend: true })).toBe('when the subject contains "Weekend" or it arrives at the weekend');
    expect(describeSplitWhen(null)).toBe("every email");
  });

  it("splits a weekend roundup but keeps a weekday email whole, and re-applies when the setting changes", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO sources (id, channel, status, origin, created_at, format) VALUES ('n', 'email', 'enabled', 'auto', 'x', 'roundup')").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-splitwhen-"));
    const add = (id: string, title: string, at: string) => {
      db.prepare("INSERT INTO items (id, source_id, channel, title, published_at, created_at) VALUES (?, 'n', 'email', ?, ?, 'x')").run(id, title, at);
      mkdirSync(join(contentDir, id), { recursive: true });
      writeFileSync(join(contentDir, id, "article.html"), roundupHtml);
    };
    add("sat", "Saturday Roundup", SAT);
    add("tue", "Tuesday essay", TUE);

    await setSplitWhen(db, contentDir, "n", { weekend: true }, "2026-11-20T00:00:00Z", "2026-11-28T16:00:00Z");
    expect(splitWhenOf(db, "n")).toEqual({ weekend: true });
    const kind = (id: string) => (db.prepare("SELECT kind FROM items WHERE id = ?").get(id) as { kind: string }).kind;
    expect([kind("sat"), kind("tue")]).toEqual(["newsletter", "article"]);

    // A new weekday email from it stays whole.
    add("wed", "Wednesday", "2026-11-25T15:00:00Z");
    expect(await afterFiling(db, contentDir, "wed", "n", roundupHtml, "x", { subject: "Wednesday", receivedAt: "2026-11-25T15:00:00Z" })).toBe(0);

    // Back to every email: the weekday ones are split too; and narrowing it again puts them back together.
    expect(await setSplitWhen(db, contentDir, "n", null, "2026-11-20T00:00:00Z", "x")).toMatchObject({ split: 3 });
    expect(kind("tue")).toBe("newsletter");
    expect(await setSplitWhen(db, contentDir, "n", { subject: "Roundup" }, "2026-11-20T00:00:00Z", "x")).toMatchObject({ joined: 2 });
    expect([kind("sat"), kind("tue"), kind("wed")]).toEqual(["newsletter", "article", "article"]);
  });
});
