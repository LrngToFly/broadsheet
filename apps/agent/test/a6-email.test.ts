import { describe, expect, it } from "vitest";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { describeSettings, parseSettingValue, setSetting, withSettings } from "../src/settings.ts";
import { approveNew, backfillSkipped, includeSkipped, mailReview } from "../src/pipeline/mail-review.ts";

const file = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" }, mailbox: { markFiledAsRead: true } });

describe("settings from Admin", () => {
  it("win over the config file until reset, and are checked", () => {
    const db = openDb(":memory:");
    expect(withSettings(file, db).mailbox).toMatchObject({ mode: "dedicated", markFiledAsRead: true });
    setSetting(db, "mailbox.mode", parseSettingValue("mailbox.mode", "shared"));
    setSetting(db, "mailbox.markFiledAsRead", parseSettingValue("mailbox.markFiledAsRead", "false"));
    expect(withSettings(file, db).mailbox).toMatchObject({ mode: "shared", markFiledAsRead: false, rootFolder: "The Broadsheet" });
    expect(describeSettings(file, db)).toEqual([
      { key: "mailbox.mode", label: "Mailbox mode", value: "shared", fromAdmin: true, fileValue: "dedicated" },
      { key: "mailbox.markFiledAsRead", label: "Mark filed emails as read", value: false, fromAdmin: true, fileValue: true },
    ]);
    setSetting(db, "mailbox.mode", null);
    expect(withSettings(file, db).mailbox.mode).toBe("dedicated");
    expect(() => parseSettingValue("mailbox.mode", "both")).toThrow(/Mailbox mode/);
    // A stored value that's no longer valid is ignored rather than breaking every run.
    db.prepare("INSERT OR REPLACE INTO agent_state VALUES ('setting:mailbox.mode', '\"both\"')").run();
    expect(withSettings(file, db).mailbox.mode).toBe("dedicated");
  });
});

describe("the Email page", () => {
  function setup() {
    const db = openDb(":memory:");
    syncConfig(db, file);
    db.prepare("INSERT INTO agent_state VALUES ('folder:_add', 'ADD')").run();
    db.prepare("INSERT INTO sources (id, channel, status, origin, created_at) VALUES ('a', 'email', 'new', 'auto', 'x'), ('b', 'email', 'new', 'auto', 'x'), ('c', 'email', 'enabled', 'auto', 'x')").run();
    const log = (key: string, decision: string, why: string, at: string, messageId: string | null = `m-${key}`) =>
      db.prepare("INSERT INTO mail_log (message_key, message_id, received_at, sender, subject, decision, why, source_id) VALUES (?, ?, ?, 's@x.example', ?, ?, ?, 'a')").run(key, messageId, at, `Subject ${key}`, decision, why);
    log("welcome", "skip", "sign-in, receipt or welcome email", "2026-11-27T10:00:00Z");
    log("muted", "skip", 'source "c" is turned off', "2026-11-27T11:00:00Z");
    log("gone", "skip", "sign-in, receipt or welcome email", "2026-11-26T10:00:00Z", null);
    log("dropped", "include", "dropped in _Add", "2026-11-25T10:00:00Z");
    log("normal", "include", "newsletter", "2026-11-27T09:00:00Z");
    const moves: [string, string][] = [];
    const mail = { move: async (id: string, to: string) => (moves.push([id, to]), id) };
    return { db, mail, moves };
  }

  it("lists skipped mail, what you dropped into _Add, and how many newsletters are New", () => {
    const { db } = setup();
    const r = mailReview(db);
    expect(r.skipped.map((m) => m.key)).toEqual(["muted", "welcome", "gone"]);
    expect(r.added.map((m) => m.key)).toEqual(["dropped"]);
    expect(r.newSources).toBe(2);
    expect(approveNew(db, "a")).toBe(1);
    expect(approveNew(db)).toBe(1);
    expect(mailReview(db).newSources).toBe(0);
  });

  it("Include this one moves the email into _Add", async () => {
    const { db, mail, moves } = setup();
    expect(await includeSkipped(db, mail, "welcome")).toEqual({ subject: "Subject welcome" });
    expect(moves).toEqual([["m-welcome", "ADD"]]);
    expect(db.prepare("SELECT why FROM mail_log WHERE message_key = 'welcome'").get()).toEqual({ why: "sent to _Add from Admin" });
    await expect(includeSkipped(db, mail, "normal")).rejects.toThrow(/already in the paper/);
    await expect(includeSkipped(db, mail, "gone")).rejects.toThrow(/Drag it into _Add yourself/);
    await expect(includeSkipped(db, mail, "nope")).rejects.toThrow(/isn't in the mail log/);
    await expect(includeSkipped(db, { move: async () => { throw new Error("404"); } }, "muted")).rejects.toThrow(/moved or deleted in Outlook/);
  });

  it("backfills what was left in the Inbox before the mail log started", async () => {
    const { db } = setup();
    db.prepare("INSERT INTO seen VALUES ('mail:<old-welcome@x>', 'x'), ('mail:<article@x>', 'x'), ('mail:welcome', 'x')").run();
    db.prepare("INSERT INTO items (id, source_id, channel, internet_message_id, title, published_at, created_at) VALUES ('i', 'a', 'email', '<article@x>', 't', 'x', 'x')").run();
    const msg = (key: string, subject: string) => ({ id: `g-${key}`, internetMessageId: key, subject, receivedDateTime: "2026-11-27T08:00:00Z", isRead: false, from: { emailAddress: { address: "Hi@monthly.example", name: "The Monthly Review" } } });
    const inbox = [msg("<old-welcome@x>", "Welcome!"), msg("<article@x>", "An article"), msg("welcome", "Already logged"), msg("<unseen@x>", "Not looked at yet")];
    expect(await backfillSkipped(db, { list: async () => inbox as any }, new Date("2026-11-27T12:00:00Z"))).toBe(1);
    expect(db.prepare("SELECT message_id, sender, sender_name, subject, decision FROM mail_log WHERE message_key = '<old-welcome@x>'").get()).toEqual({
      message_id: "g-<old-welcome@x>", sender: "hi@monthly.example", sender_name: "The Monthly Review", subject: "Welcome!", decision: "skip",
    });
  });
});
