import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { dailyBackup, integrityProblem, listBackups, localDate, restoreBackup, weeklyCloudBackup, writeFileAtomic } from "../src/backup.ts";
import { repairStranded } from "../src/pipeline/stage-a-email.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "bs-backup-"));
  const path = join(dir, "broadsheet.db");
  const db = openDb(path);
  syncConfig(db, config);
  db.prepare("INSERT INTO agent_state VALUES ('profile:own-words', 'Less spectacle.')").run();
  return { dir, path, db };
}

describe("backups", () => {
  it("makes one a day, keeps the last 7, and restores one with the old database kept aside", async () => {
    const { dir, path, db } = fileDb();
    const backups = join(dir, "backups");
    expect(integrityProblem(db)).toBeNull();
    for (let d = 1; d <= 9; d++) await dailyBackup(db, backups, new Date(2026, 10, d, 12));
    expect((await dailyBackup(db, backups, new Date(2026, 10, 9, 18))).made).toBeNull(); // one a day
    const list = await listBackups(backups);
    expect(list.map((b) => b.date)).toEqual(["2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03"]);
    expect(readdirSync(backups).filter((n) => !n.endsWith(".gz"))).toEqual([]); // no temporary files left

    db.prepare("UPDATE agent_state SET value = 'Changed after the backup.' WHERE key = 'profile:own-words'").run();
    db.close();
    const aside = await restoreBackup(list[0]!.path, path, new Date("2026-11-10T08:00:00Z"));
    expect(existsSync(aside)).toBe(true);
    const back = openDb(path);
    expect(back.prepare("SELECT value FROM agent_state WHERE key = 'profile:own-words'").get()).toEqual({ value: "Less spectacle." });
    expect(integrityProblem(back)).toBeNull();
  });

  it("finds a damaged database", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-bad-"));
    const path = join(dir, "bad.db");
    writeFileSync(path, "SQLite format 3\u0000" + "garbage".repeat(500));
    expect(() => {
      const db = openDb(path);
      if (integrityProblem(db)) throw new Error("damaged");
    }).toThrow();
  });

  it("copies the newest to OneDrive once a week, keeping the last 4 there", async () => {
    const { dir, db } = fileDb();
    const backups = join(dir, "backups");
    const cloud = new Map<string, number>();
    const folder = {
      put: async (path: string, body: Uint8Array) => void cloud.set(path, body.length),
      list: async () => [...cloud.keys()].map((k) => k.slice("backups/".length)),
      delete: async (path: string) => void cloud.delete(path),
    };
    for (let week = 0; week < 6; week++) {
      for (let day = 0; day < 7; day++) {
        const now = new Date(2026, 9, 1 + week * 7 + day, 12);
        await dailyBackup(db, backups, now);
        await weeklyCloudBackup(folder, backups, now);
      }
    }
    expect([...cloud.keys()].sort()).toEqual(["backups/broadsheet-2026-10-15.db.gz", "backups/broadsheet-2026-10-22.db.gz", "backups/broadsheet-2026-10-29.db.gz", "backups/broadsheet-2026-11-05.db.gz"]);
    expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("writes files in one step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-atomic-"));
    await writeFileAtomic(join(dir, "a.txt"), "hello");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });
});

describe("after a run was cut off", () => {
  it("files an email that was recorded but not moved, reads again one whose text is missing, and only once", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO sources (id, channel, status, origin, created_at) VALUES ('s', 'email', 'enabled', 'auto', 'x')").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-repair-"));
    const now = new Date("2026-11-27T12:00:00Z");
    const add = (id: string, folder: string | null, created = "2026-11-27T11:00:00Z", text = true) => {
      db.prepare("INSERT INTO items (id, source_id, channel, message_id, internet_message_id, mail_folder_id, title, published_at, created_at) VALUES (?, 's', 'email', ?, ?, ?, 't', 'x', ?)")
        .run(id, `g-${id}`, `<${id}@x>`, folder, created);
      db.prepare("INSERT INTO seen VALUES (?, 'x')").run(`mail:<${id}@x>`);
      if (text) { mkdirSync(join(contentDir, id), { recursive: true }); writeFileSync(join(contentDir, id, "article.txt"), "words"); }
    };
    add("stranded", "SORT");
    add("notext", "SORT", "2026-11-27T11:00:00Z", false);
    add("stays", null); // a rule left it in the Inbox on purpose
    add("old", "F-gardening", "2026-11-20T11:00:00Z"); // you dragged it back long after
    const inbox = ["stranded", "notext", "stays", "old", "skipped"].map((id) => ({ id: `g-${id}`, internetMessageId: `<${id}@x>`, subject: id, receivedDateTime: "x", isRead: false, from: {} })) as any;
    db.prepare("INSERT INTO seen VALUES ('mail:<skipped@x>', 'x')").run();
    const moves: [string, string][] = [];
    const mail = { move: async (id: string, to: string) => (moves.push([id, to]), id) };
    const isSeen = (k: string) => Boolean(db.prepare("SELECT 1 FROM seen WHERE key = ?").get(`mail:${k}`));

    expect(await repairStranded(db, mail, inbox, contentDir, isSeen, undefined, now)).toBe(2);
    expect(moves).toEqual([["g-stranded", "SORT"]]);
    expect(db.prepare("SELECT count(*) n FROM items WHERE id = 'notext'").get()).toEqual({ n: 0 });
    expect(isSeen("<notext@x>")).toBe(false); // so this run reads it again from scratch
    // Next run (say you dragged it back to the Inbox yourself): left alone.
    expect(await repairStranded(db, mail, inbox, contentDir, isSeen, undefined, now)).toBe(0);
    expect(moves).toHaveLength(1);
  });
});
