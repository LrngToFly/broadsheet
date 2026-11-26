import { describe, expect, it } from "vitest";
import { Config } from "@broadsheet/shared";
import { openDb, schemaVersion, syncConfig } from "../src/db/db.ts";
import { migrations } from "../src/db/migrations.ts";
import { ConfigError, parseConfig } from "../src/config.ts";

const base = {
  microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
  sources: [
    { id: "letter", channel: "email", match: { domain: "letter.example" }, section: "gardening" },
    { id: "blog", channel: "feed", url: "https://blog.example" },
  ],
  rules: [{ id: "r1", kind: "instruction", wording: "w", instruction: "i", source: "letter" }],
};

describe("database", () => {
  it("creates the schema", () => {
    const db = openDb(":memory:");
    expect(schemaVersion(db)).toBe(migrations.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["sections", "sources", "rules", "items", "seen", "runs"]));
  });

  it("copies the config in, and removes what was taken out", () => {
    const db = openDb(":memory:");
    syncConfig(db, Config.parse(base));
    expect(db.prepare("SELECT count(*) n FROM sections").get()).toEqual({ n: 6 });
    expect(db.prepare("SELECT fixed_section_id f FROM sources WHERE id = 'letter'").get()).toEqual({ f: "gardening" });

    // A sender the agent found by itself survives a config sync.
    db.prepare("INSERT INTO sources (id, channel, status, origin, created_at) VALUES ('auto1', 'email', 'new', 'auto', 'now')").run();
    // The folder id the agent stored for a section survives a rename.
    db.prepare("UPDATE sections SET mail_folder_id = 'F1' WHERE id = 'technology'").run();

    const next = Config.parse({
      ...base,
      sections: [
        { id: "technology", name: "Tech" },
        { id: "everything-else", name: "Everything Else" },
      ],
      sources: [base.sources[1]],
      rules: [],
    });
    const s = syncConfig(db, next);
    expect(s.removed).toEqual(expect.arrayContaining(["source letter", "section gardening"]));
    expect(db.prepare("SELECT name, mail_folder_id FROM sections WHERE id = 'technology'").get()).toEqual({ name: "Tech", mail_folder_id: "F1" });
    expect((db.prepare("SELECT id FROM sources ORDER BY id").all() as { id: string }[]).map((r) => r.id)).toEqual(["auto1", "blog"]);
    expect(db.prepare("SELECT count(*) n FROM rules").get()).toEqual({ n: 0 });
  });
});

describe("parseConfig", () => {
  it("explains bad JSON and bad values", () => {
    expect(() => parseConfig("{", "f.json")).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ microsoft: { clientId: "nope" } }), "f.json")).toThrow(/clientId/);
  });
});
