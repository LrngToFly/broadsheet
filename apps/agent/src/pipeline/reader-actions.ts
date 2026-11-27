// Stage A step 1 (PLAN.md §3.6): collect what you did in the reader (ratings, saves, section moves) from
// ratings/ in the OneDrive App Folder, apply it, and delete the files. See docs/phase-2.md.
import { ActionsFile, type ReaderAction } from "@broadsheet/shared";
import { transaction, type Db } from "../db/db.ts";
import type { AppFolder } from "../microsoft/onedrive.ts";
import type { MailPort } from "./stage-a-email.ts";

export type ActionsPort = Pick<AppFolder, "list" | "getJson" | "delete">;

export type ActionsResult = { files: number; applied: number; ignored: number; errors: string[] };

const FOLDER = "ratings";

/** Keep (or update) the long-term record of an item you rated, moved or hid. No article text. */
export function upsertPreference(db: Db, itemId: string, changes: { rating?: number | null; movedTo?: string; hiddenReason?: string | null; hiddenNote?: string | null }, now: string) {
  const item = db.prepare("SELECT id, source_id, author, section_id, tags_json, title, url, published_at FROM items WHERE id = ?").get(itemId) as any;
  if (!item) return;
  db.prepare(
    `INSERT INTO preference_records (item_id, source_id, author, section_id, tags_json, title, url, published_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET section_id = excluded.section_id, tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
  ).run(item.id, item.source_id, item.author, item.section_id, item.tags_json, item.title, item.url, item.published_at, now);
  if ("rating" in changes) db.prepare("UPDATE preference_records SET rating = ? WHERE item_id = ?").run(changes.rating ?? null, itemId);
  if (changes.movedTo) db.prepare("UPDATE preference_records SET moved_to_section = ? WHERE item_id = ?").run(changes.movedTo, itemId);
  if ("hiddenReason" in changes) {
    db.prepare("UPDATE preference_records SET hidden_reason = ?, hidden_note = ? WHERE item_id = ?").run(changes.hiddenReason ?? null, changes.hiddenNote ?? null, itemId);
  }
}

export async function applyReaderActions(opts: { db: Db; appFolder: ActionsPort; mail: MailPort; now?: Date }): Promise<ActionsResult> {
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
    const item = db.prepare("SELECT id, channel, message_id, mail_folder_id FROM items WHERE id = ?").get(a.itemId) as any;
    if (!item) {
      result.ignored++; // expired since you acted on it
      continue;
    }
    switch (a.type) {
      case "rate":
        transaction(db, () => {
          db.prepare("UPDATE items SET rating = ?, rated_at = ? WHERE id = ?").run(a.rating, a.at, a.itemId);
          upsertPreference(db, a.itemId, { rating: a.rating }, now);
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
      case "hide":
      case "unhide":
        result.ignored++; // arrives with milestone P3
        continue;
    }
    result.applied++;
  }

  // Delete the files only after everything in them is applied.
  for (const name of done) await appFolder.delete(`${FOLDER}/${name}`);
  return result;
}
