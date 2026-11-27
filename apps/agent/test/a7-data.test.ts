import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { exportData, forget, importData, storage } from "../src/data.ts";
import { setSetting } from "../src/settings.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });

function filled() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT'), ('profile:own-words', 'Less spectacle.'), ('mail:<x>', 'seen')").run();
  setSetting(db, "politeness.idleMinutes", 20);
  db.prepare(`INSERT INTO sources (id, channel, display_name, match_json, status, origin, created_at, fixed_section_id, format) VALUES ('garden', 'email', 'Garden', '{"listId":"g"}', 'enabled', 'auto', 'x', 'gardening', 'roundup')`).run();
  db.prepare("INSERT INTO rules (id, kind, wording, match_mode, conditions_json, source_id, mail_action, status, origin, updated_at) VALUES ('r', 'check', 'w', 'all', '[]', 'garden', 'leave', 'active', 'admin', 'x')").run();
  db.prepare("INSERT INTO items (id, source_id, channel, title, published_at, created_at, rating) VALUES ('i', 'garden', 'email', 'Tomatoes', '2026-11-27', 'x', 1)").run();
  db.prepare("INSERT INTO preference_records (item_id, source_id, title, published_at, rating, rating_note, updated_at) VALUES ('i', 'garden', 'Tomatoes', 'x', 1, 'lovely', 'x'), ('old', 'garden', 'Old', 'x', -1, NULL, 'x')").run();
  db.prepare("INSERT INTO reader_profiles VALUES (1, 'Likes gardens', 'x', 'gemma', 8)").run();
  return db;
}

describe("your data (A7)", () => {
  it("exports the long-term data, without article text or bookkeeping", () => {
    const e = exportData(filled(), new Date("2026-11-27T12:00:00Z"));
    expect(e).toMatchObject({ kind: "broadsheet-export", version: 1, exportedAt: "2026-11-27T12:00:00.000Z" });
    expect(e.sources.map((s) => s.id)).toEqual(["garden"]);
    expect(e.state.map((s) => s.key).sort()).toEqual(["profile:own-words", "setting:politeness.idleMinutes"]);
    expect(e.preferences).toHaveLength(2);
    expect(JSON.stringify(e)).not.toMatch(/"opening"|"summary"|"mail:/);
  });

  it("imports it into a new Mac's database, and again without duplicating anything", () => {
    const e = JSON.parse(JSON.stringify(exportData(filled())));
    const fresh = openDb(":memory:");
    syncConfig(fresh, config);
    expect(importData(fresh, e, { dryRun: true })).toEqual({ sections: 6, sources: 1, rules: 1, state: 2, preferences: 2, profiles: 1 });
    expect(fresh.prepare("SELECT count(*) n FROM sources").get()).toEqual({ n: 0 }); // the dry run changed nothing
    importData(fresh, e);
    importData(fresh, e);
    expect(fresh.prepare("SELECT id, fixed_section_id, format, status FROM sources").all()).toEqual([{ id: "garden", fixed_section_id: "gardening", format: "roundup", status: "enabled" }]);
    expect(fresh.prepare("SELECT count(*) n FROM preference_records").get()).toEqual({ n: 2 });
    expect(fresh.prepare("SELECT value FROM agent_state WHERE key = 'setting:politeness.idleMinutes'").get()).toEqual({ value: "20" });
    expect(() => importData(fresh, { kind: "something else" })).toThrow(/isn't a Broadsheet export/);
    expect(() => importData(fresh, { ...e, version: 99 })).toThrow(/newer Broadsheet/);
  });

  it("updates a source in place on import, keeping its articles", () => {
    const db = filled();
    const e = exportData(db);
    (e.sources[0] as any).display_name = "Garden Letter";
    importData(db, e);
    expect(db.prepare("SELECT display_name FROM sources WHERE id = 'garden'").get()).toEqual({ display_name: "Garden Letter" });
    expect(db.prepare("SELECT count(*) n FROM items").get()).toEqual({ n: 1 }); // not deleted by a replace
  });

  it("forgets one rating, or everything learned", () => {
    const db = filled();
    expect(forget(db, "i")).toBe(1);
    expect(db.prepare("SELECT rating FROM items WHERE id = 'i'").get()).toEqual({ rating: null });
    expect(db.prepare("SELECT item_id FROM preference_records").all()).toEqual([{ item_id: "old" }]);
    expect(forget(db, null)).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM reader_profiles").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT value FROM agent_state WHERE key = 'profile:own-words'").get()).toEqual({ value: "Less spectacle." }); // your words stay
  });

  it("says what's stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-a7-"));
    writeFileSync(join(dir, "a.txt"), "12345");
    const s = await storage(filled(), { db: join(dir, "a.txt"), content: dir, eval: join(dir, "none"), logs: dir });
    expect(s.bytes).toMatchObject({ database: 5, articles: 5, eval: 0 });
    expect(s.counts).toMatchObject({ articles: 1, newsletters: 1, rules: 1, preferences: 2, ratings: 2 });
  });
});
