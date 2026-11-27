// Stage A step 1 (PLAN.md §3.6): collect what you did in the reader (ratings, saves, moves, hides) from
// ratings/ in the OneDrive App Folder, apply it, and delete the files. See docs/phase-2.md.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionsFile, isItemAction, type ReaderAction } from "@broadsheet/shared";
import { applySetting } from "./rules.ts";
import { transaction, type Db } from "../db/db.ts";
import type { AppFolder } from "../microsoft/onedrive.ts";
import type { MailPort } from "./stage-a-email.ts";

export type ActionsPort = Pick<AppFolder, "list" | "getJson" | "delete">;

export type ActionsResult = { files: number; applied: number; ignored: number; errors: string[] };

const FOLDER = "ratings";
/** Graph's well-known name for the Deleted Items folder. */
export const DELETED_ITEMS = "deleteditems";

/** Keep (or update) the long-term record of an item you rated, moved or hid. No article text. */
export function upsertPreference(
  db: Db,
  itemId: string,
  changes: { rating?: number | null; ratingNote?: string | null; movedTo?: string; hiddenReason?: string | null; hiddenNote?: string | null },
  now: string,
) {
  const item = db.prepare("SELECT id, source_id, author, section_id, tags_json, title, url, published_at FROM items WHERE id = ?").get(itemId) as any;
  if (!item) return;
  db.prepare(
    `INSERT INTO preference_records (item_id, source_id, author, section_id, tags_json, title, url, published_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET section_id = excluded.section_id, tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
  ).run(item.id, item.source_id, item.author, item.section_id, item.tags_json, item.title, item.url, item.published_at, now);
  if ("rating" in changes) db.prepare("UPDATE preference_records SET rating = ? WHERE item_id = ?").run(changes.rating ?? null, itemId);
  if ("ratingNote" in changes) db.prepare("UPDATE preference_records SET rating_note = ? WHERE item_id = ?").run(changes.ratingNote ?? null, itemId);
  if (changes.movedTo) db.prepare("UPDATE preference_records SET moved_to_section = ? WHERE item_id = ?").run(changes.movedTo, itemId);
  if ("hiddenReason" in changes) {
    db.prepare("UPDATE preference_records SET hidden_reason = ?, hidden_note = ? WHERE item_id = ?").run(changes.hiddenReason ?? null, changes.hiddenNote ?? null, itemId);
  }
}

export async function applyReaderActions(opts: { db: Db; appFolder: ActionsPort; mail: MailPort; contentDir?: string; now?: Date }): Promise<ActionsResult> {
  const { db, appFolder, mail } = opts;
  const now = (opts.now ?? new Date()).toISOString();
  const result: ActionsResult = { files: 0, applied: 0, ignored: 0, errors: [] };

  const names = (await appFolder.list(FOLDER)).filter((n) => n.endsWith(".json")).sort();
  const actions: ReaderAction[] = [];
  const done: string[] = [];
  for (const name of names) {
    try {
      const file = ActionsFile.parse(await appFolder.getJson(`${FOLDER}/${name}`));
      actions.push(...file.actions);
    } catch (e) {
      result.errors.push(`ignored ${name}: ${(e as Error).message.split("\n")[0]}`); // a damaged file must not block every run
    }
    done.push(name);
  }
  result.files = names.length;
  actions.sort((a, b) => a.at.localeCompare(b.at)); // several devices: the latest action wins

  const sections = new Map((db.prepare("SELECT id, mail_folder_id FROM sections").all() as { id: string; mail_folder_id: string | null }[]).map((s) => [s.id, s.mail_folder_id]));
  const sortingId = (db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_sorting'").get() as { value: string } | undefined)?.value;

  for (const a of actions) {
    // The Rules page: your own words and rule changes (P4).
    if (!isItemAction(a)) {
      try {
        if (await applySetting(db, mail, a, now)) result.applied++;
        else result.ignored++;
      } catch (e) {
        result.errors.push(`couldn't apply "${a.type}": ${(e as Error).message}`);
      }
      continue;
    }
    const item = db.prepare("SELECT id, channel, message_id, mail_folder_id FROM items WHERE id = ?").get(a.itemId) as any;
    if (!item) {
      result.ignored++; // expired since you acted on it
      continue;
    }
    switch (a.type) {
      case "rate":
        transaction(db, () => {
          db.prepare("UPDATE items SET rating = ?, rated_at = ? WHERE id = ?").run(a.rating, a.at, a.itemId);
          upsertPreference(db, a.itemId, { rating: a.rating, ratingNote: a.rating === null ? null : (a.note ?? null) }, now);
        });
        break;
      case "save":
        db.prepare("UPDATE items SET saved = ? WHERE id = ?").run(a.saved ? 1 : 0, a.itemId);
        break;
      case "move": {
        const target = sections.get(a.section);
        if (target === undefined) {
          result.ignored++;
          continue;
        }
        transaction(db, () => {
          db.prepare("UPDATE items SET section_id = ?, section_source = 'user' WHERE id = ?").run(a.section, a.itemId);
          upsertPreference(db, a.itemId, { movedTo: a.section }, now);
        });
        // The email follows, if it's in one of the Broadsheet's own folders.
        const inOurFolders = item.mail_folder_id === sortingId || [...sections.values()].includes(item.mail_folder_id);
        if (item.channel === "email" && item.message_id && target && inOurFolders && item.mail_folder_id !== target) {
          try {
            await mail.move(item.message_id, target);
            db.prepare("UPDATE items SET mail_folder_id = ? WHERE id = ?").run(target, a.itemId);
          } catch (e) {
            result.errors.push(`couldn't move the email for "${a.itemId}": ${(e as Error).message}`);
          }
        }
        break;
      }
      case "hide": {
        transaction(db, () => {
          // Hidden wins over Saved, so it expires with the rest.
          db.prepare("UPDATE items SET hidden_by = 'user', hidden_reason = ?, hidden_note = ?, hidden_at = ?, shown_anyway = 0, saved = 0 WHERE id = ?")
            .run(a.reason, a.note, a.at, a.itemId);
          upsertPreference(db, a.itemId, { hiddenReason: a.reason, hiddenNote: a.note }, now);
        });
        // Gemma looks at it later and may draft a rule (PLAN.md §4.3).
        await queueDraftFromHide(db, a.itemId, a.reason, a.note, opts.contentDir, now);
        // The email goes to Deleted Items (PLAN.md §4.3), if it's in one of the Broadsheet's folders.
        const inOurFolders = item.mail_folder_id === sortingId || [...sections.values()].includes(item.mail_folder_id);
        if (item.channel === "email" && item.message_id && inOurFolders) {
          try {
            await mail.move(item.message_id, DELETED_ITEMS);
            db.prepare("UPDATE items SET mail_folder_id = ? WHERE id = ?").run(DELETED_ITEMS, a.itemId);
          } catch (e) {
            result.errors.push(`couldn't move the email for "${a.itemId}" to Deleted Items: ${(e as Error).message}`);
          }
        }
        break;
      }
      case "unhide": {
        const row = db.prepare("SELECT section_id, ai_status FROM items WHERE id = ?").get(a.itemId) as { section_id: string | null; ai_status: string };
        transaction(db, () => {
          db.prepare(
            `UPDATE items SET hidden_by = NULL, hidden_reason = NULL, hidden_note = NULL, hidden_at = NULL, shown_anyway = 1,
               is_article = CASE WHEN is_article = 0 THEN 1 ELSE is_article END,
               ai_status = CASE WHEN ai_status = 'skipped' THEN 'pending' ELSE ai_status END
             WHERE id = ?`,
          ).run(a.itemId);
          db.prepare("UPDATE preference_records SET hidden_reason = NULL, hidden_note = NULL, updated_at = ? WHERE item_id = ?").run(now, a.itemId);
          // Not drafted yet: no need to any more.
          db.prepare("UPDATE rule_requests SET status = 'dismissed', excerpt = NULL, updated_at = ? WHERE item_id = ? AND status = 'pending'").run(now, a.itemId);
        });
        // The email comes back from Deleted Items (or the Inbox, if a rule left it there) to its section folder.
        const home = (row.section_id && sections.get(row.section_id)) || sortingId;
        if (item.channel === "email" && item.message_id && home && (item.mail_folder_id === DELETED_ITEMS || item.mail_folder_id === null)) {
          try {
            await mail.move(item.message_id, home);
            db.prepare("UPDATE items SET mail_folder_id = ? WHERE id = ?").run(home, a.itemId);
          } catch (e) {
            result.errors.push(`couldn't bring back the email for "${a.itemId}": ${(e as Error).message}`);
          }
        }
        break;
      }
    }
    result.applied++;
  }

  // Delete the files only after everything in them is applied.
  for (const name of done) await appFolder.delete(`${FOLDER}/${name}`);
  return result;
}

/** A hidden item becomes a drafting request, with what Gemma needs copied in case the item expires first. */
async function queueDraftFromHide(db: Db, itemId: string, reason: string | null, note: string | null, contentDir: string | undefined, now: string) {
  const pending = db.prepare("SELECT id FROM rule_requests WHERE item_id = ? AND status = 'pending'").get(itemId) as { id: number } | undefined;
  if (pending) {
    // The reason or note came a moment after the hide.
    db.prepare("UPDATE rule_requests SET reason = ?, note = ?, updated_at = ? WHERE id = ?").run(reason, note, now, pending.id);
    return;
  }
  const it = db
    .prepare(
      `SELECT i.id, i.title, i.source_id, i.word_count, i.sender, i.list_id, i.url, s.match_json FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?`,
    )
    .get(itemId) as any;
  if (!it) return;
  const match = it.match_json ? JSON.parse(it.match_json) : {};
  let excerpt = "";
  let links: string[] = [];
  if (contentDir) {
    excerpt = (await readFile(join(contentDir, itemId, "article.txt"), "utf8").catch(() => "")).slice(0, 2500);
    const html = await readFile(join(contentDir, itemId, "article.html"), "utf8").catch(() => "");
    links = [...new Set([...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!))].slice(0, 30);
  }
  const facts = {
    subject: it.title,
    sender: it.sender ?? match.sender ?? null,
    listId: it.list_id ?? match.listId ?? null,
    wordCount: it.word_count,
    url: it.url,
    links,
  };
  db.prepare(
    `INSERT INTO rule_requests (kind, item_id, source_id, facts_json, excerpt, reason, note, created_at, updated_at)
     VALUES ('hidden-item', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(itemId, it.source_id, JSON.stringify(facts), excerpt, reason, note, now, now);
}
