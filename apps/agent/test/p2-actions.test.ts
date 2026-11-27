import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionsFile, Config, Edition } from "@broadsheet/shared";
import { applyReaderActions } from "../src/pipeline/reader-actions.ts";
import { publish } from "../src/pipeline/publish.ts";
import { openDb, syncConfig } from "../src/db/db.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
const NOW = new Date("2026-11-27T12:00:00Z");

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
  db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('s', 'email', 'Garden Letter', 'enabled', 'auto', 'x')").run();
  db.prepare(
    `INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, author, published_at, section_id, section_source, tags_json, created_at, content_published, ai_status, summary, interest)
     VALUES ('a', 's', 'email', 'm-a', 'F-everything-else', 'Tomatoes', 'Ann', '2026-11-27T10:00:00Z', 'everything-else', 'ai', '["tomatoes"]', 'x', 1, 'done', 'A summary.', 70)`,
  ).run();

  const files = new Map<string, unknown>();
  const deleted: string[] = [];
  const appFolder = {
    list: async (folder: string) => [...files.keys()].filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1)),
    getJson: async <T>(path: string) => files.get(path) as T,
    delete: async (path: string) => void (deleted.push(path), files.delete(path)),
    put: async () => ({ id: "x", size: 1 }),
    putJson: async (path: string, v: unknown) => (files.set(path, v), { id: path, size: 1 }),
  };
  const moves: [string, string][] = [];
  const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
  const send = (name: string, actions: unknown[]) =>
    files.set(`ratings/${name}.json`, ActionsFile.parse({ schemaVersion: 1, device: "phone01", createdAt: "2026-11-27T11:00:00Z", actions }));
  return { db, files, deleted, appFolder, mail, moves, send };
}

describe("actions from the reader", () => {
  it("applies ratings, saves and moves, moves the email, keeps a preference record, and deletes the files", async () => {
    const { db, appFolder, mail, moves, deleted, send } = setup();
    send("phone01-1", [
      { type: "rate", itemId: "a", rating: -1, at: "2026-11-27T11:00:00Z" },
      { type: "move", itemId: "a", section: "gardening", at: "2026-11-27T11:01:00Z" },
    ]);
    // Another device, later: it wins.
    send("ipad01-2", [
      { type: "rate", itemId: "a", rating: 1, at: "2026-11-27T11:05:00Z" },
      { type: "save", itemId: "a", saved: true, at: "2026-11-27T11:05:01Z" },
    ]);
    const r = await applyReaderActions({ db, appFolder, mail, now: NOW });
    expect(r).toMatchObject({ files: 2, applied: 4, ignored: 0, errors: [] });
    expect(db.prepare("SELECT rating, saved, section_id, section_source, mail_folder_id FROM items WHERE id = 'a'").get()).toEqual({
      rating: 1, saved: 1, section_id: "gardening", section_source: "user", mail_folder_id: "F-gardening",
    });
    expect(moves).toEqual([["m-a", "F-gardening"]]);
    expect(db.prepare("SELECT source_id, author, title, rating, moved_to_section, tags_json FROM preference_records").all()).toEqual([
      { source_id: "s", author: "Ann", title: "Tomatoes", rating: 1, moved_to_section: "gardening", tags_json: '["tomatoes"]' },
    ]);
    expect(deleted.sort()).toEqual(["ratings/ipad01-2.json", "ratings/phone01-1.json"]);
  });

  it("ignores actions on expired items and drops damaged files instead of getting stuck", async () => {
    const { db, appFolder, mail, files, send } = setup();
    send("phone01-1", [{ type: "rate", itemId: "gone", rating: 1, at: "2026-11-27T11:00:00Z" }]);
    files.set("ratings/broken.json", { nonsense: true });
    const r = await applyReaderActions({ db, appFolder, mail, now: NOW });
    expect(r).toMatchObject({ files: 2, applied: 0, ignored: 1 });
    expect(r.errors[0]).toMatch(/ignored broken.json/);
    expect(files.size).toBe(0);
  });

  it("keeps the preference record after the item expires, and publishes your rating on the card", async () => {
    const { db, appFolder, mail, send } = setup();
    send("phone01-1", [{ type: "rate", itemId: "a", rating: 0, at: "2026-11-27T11:00:00Z" }]);
    await applyReaderActions({ db, appFolder, mail, now: NOW });

    const contentDir = mkdtempSync(join(tmpdir(), "bs-p2-"));
    mkdirSync(join(contentDir, "a"), { recursive: true });
    writeFileSync(join(contentDir, "a", "article.html"), "<p>x</p>");
    let edition: unknown;
    const folder = { ...appFolder, putJson: async (p: string, v: unknown) => ((edition = p === "edition.json" ? v : edition), { id: p, size: 1 }) };
    await publish({ db, appFolder: folder, config, contentDir, now: NOW });
    expect(Edition.parse(edition).items[0]).toMatchObject({ id: "a", rating: 0, saved: false, sectionByYou: false });

    // Ten days later the item is pruned, but what you thought of it remains.
    await publish({ db, appFolder: folder, config, contentDir, now: new Date("2026-12-07T12:00:00Z") });
    expect(db.prepare("SELECT count(*) n FROM items").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT rating FROM preference_records WHERE item_id = 'a'").get()).toEqual({ rating: 0 });
  });
});
