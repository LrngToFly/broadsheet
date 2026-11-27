import { describe, expect, it } from "vitest";
import { Config, Edition } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { applyActions } from "../src/pipeline/reader-actions.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });

describe("reading on one device, seen on all", () => {
  it("records read and unread on the item only, with no long-term history", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO sources (id, channel, status, origin, created_at) VALUES ('s', 'email', 'enabled', 'auto', 'x')").run();
    db.prepare("INSERT INTO items (id, source_id, channel, title, published_at, created_at) VALUES ('a', 's', 'email', 't', '2026-11-27', 'x')").run();
    const mail = { list: async () => [], mime: async () => "", move: async (id: string) => id, markRead: async () => {} };
    const r = await applyActions({ db, mail, actions: [{ type: "read", itemId: "a", read: true, at: "2026-11-27T20:00:00Z" }, { type: "read", itemId: "gone", read: true, at: "2026-11-27T20:00:01Z" }] });
    expect(r).toEqual({ applied: 1, ignored: 1, errors: [] }); // an expired item is simply ignored
    expect(db.prepare("SELECT read_at FROM items WHERE id = 'a'").get()).toEqual({ read_at: "2026-11-27T20:00:00Z" });
    expect(db.prepare("SELECT count(*) n FROM preference_records").get()).toEqual({ n: 0 });
    await applyActions({ db, mail, actions: [{ type: "read", itemId: "a", read: false, at: "2026-11-27T21:00:00Z" }] });
    expect(db.prepare("SELECT read_at FROM items WHERE id = 'a'").get()).toEqual({ read_at: null });
  });

  it("an older edition without read flags still reads", () => {
    const e = Edition.parse({ schemaVersion: 1, generatedAt: "2026-11-27T20:00:00Z", sections: [], items: [{ id: "a", title: "t", source: "s", author: null, channel: "email", publishedAt: "2026-11-27T20:00:00Z", url: null, section: "x", status: "pending", opening: "", summary: null, keyPoints: [], tags: [], whyItsHere: null, readMinutes: 1, score: 0, image: null, content: "items/a.html" }] });
    expect(e.items[0]!.read).toBe(false);
  });
});
