import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { editSource } from "../src/pipeline/sources.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const base = {
  microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
  sources: [{ id: "letter", channel: "email", name: "The Letter", match: { domain: "letter.example" } }],
};

describe("sources: the database is the master copy", () => {
  it("keeps Admin's changes until the source's text in the config file changes", () => {
    const db = openDb(":memory:");
    syncConfig(db, Config.parse(base));
    db.prepare("UPDATE sources SET display_name = 'Renamed in Admin', status = 'muted' WHERE id = 'letter'").run();
    syncConfig(db, Config.parse(base));
    expect(db.prepare("SELECT display_name, status FROM sources WHERE id = 'letter'").get()).toEqual({ display_name: "Renamed in Admin", status: "muted" });

    syncConfig(db, Config.parse({ ...base, sources: [{ ...base.sources[0], name: "Edited in the file" }] }));
    expect(db.prepare("SELECT display_name, status FROM sources WHERE id = 'letter'").get()).toEqual({ display_name: "Edited in the file", status: "enabled" });
  });

  it("counts posts per source for 90 days, but not the briefs split from them", () => {
    const db = openDb(":memory:");
    syncConfig(db, Config.parse(base));
    const add = (id: string, parent: string | null = null) =>
      db.prepare("INSERT OR REPLACE INTO items (id, source_id, channel, title, published_at, created_at, parent_id) VALUES (?, 'letter', 'email', 't', '2026-11-20T10:00:00Z', 'x', ?)").run(id, parent);
    add("a");
    add("a"); // written again (INSERT OR REPLACE): still one post
    add("b");
    add("b-1", "b");
    expect(db.prepare("SELECT item_id FROM source_posts ORDER BY item_id").all()).toEqual([{ item_id: "a" }, { item_id: "b" }]);
    db.prepare("DELETE FROM items").run();
    expect(db.prepare("SELECT count(*) n FROM source_posts").get()).toEqual({ n: 2 }); // outlives the items
  });
});

describe("editing a source", () => {
  function setup() {
    const db = openDb(":memory:");
    syncConfig(db, Config.parse(base));
    db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
    db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
    const add = (id: string, folder: string, section: string, from: string | null, at = "2026-11-27T10:00:00Z") =>
      db.prepare("INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, published_at, section_id, section_source, created_at) VALUES (?, 'letter', 'email', ?, ?, 't', ?, ?, ?, 'x')")
        .run(id, `m-${id}`, folder, at, section, from);
    add("sorting", "SORT", "everything-else", null);
    add("filed", "F-technology", "technology", "ai");
    add("yours", "F-financial", "financial", "user"); // you moved it: stays
    add("old", "F-technology", "technology", "ai", "2026-10-01T10:00:00Z"); // expired: left alone
    const moves: [string, string][] = [];
    const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
    const opts = { contentDir: mkdtempSync(join(tmpdir(), "bs-a2-")), cutoff: "2026-11-23T00:00:00Z", now: "2026-11-27T12:00:00Z" };
    return { db, mail, moves, opts };
  }

  it("renames, turns off and on, and checks what it's given", async () => {
    const { db, mail, opts } = setup();
    expect((await editSource(db, mail, "letter", { name: "  Garden Letter  ", muted: true }, opts)).changed).toEqual(['renamed to "Garden Letter"', "turned off: its emails are left in the Inbox from now on"]);
    expect(db.prepare("SELECT display_name, status FROM sources").get()).toEqual({ display_name: "Garden Letter", status: "muted" });
    expect((await editSource(db, mail, "letter", { muted: false }, opts)).changed).toEqual(["turned on again"]);
    expect((await editSource(db, mail, "letter", { muted: false }, opts)).changed).toEqual([]);
    await expect(editSource(db, mail, "nope", { muted: true }, opts)).rejects.toThrow(/No newsletter/);
    await expect(editSource(db, mail, "letter", { section: "cooking" }, opts)).rejects.toThrow(/No section "cooking"/);
    await expect(editSource(db, mail, "letter", { name: " " }, opts)).rejects.toThrow(/empty/);
  });

  it("moves current items and their emails to a new fixed section, except ones you moved", async () => {
    const { db, mail, moves, opts } = setup();
    const r = await editSource(db, mail, "letter", { section: "gardening" }, opts);
    expect(r).toEqual({ changed: ["always in Gardening"], moved: 2, errors: [] });
    expect(moves).toEqual([["m-sorting", "F-gardening"], ["m-filed", "F-gardening"]]);
    expect(db.prepare("SELECT id, section_id, section_source FROM items ORDER BY id").all()).toEqual([
      { id: "filed", section_id: "gardening", section_source: "fixed" },
      { id: "old", section_id: "technology", section_source: "ai" },
      { id: "sorting", section_id: "gardening", section_source: "fixed" },
      { id: "yours", section_id: "financial", section_source: "user" },
    ]);

    // None: Gemma chooses again; nothing moves.
    expect((await editSource(db, mail, "letter", { section: null }, opts)).changed).toEqual(["no fixed section: Gemma chooses"]);
    expect(db.prepare("SELECT count(*) n FROM items WHERE section_source = 'fixed'").get()).toEqual({ n: 0 });
    expect(moves).toHaveLength(2);
  });
});
