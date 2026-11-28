// Editing a newsletter (Admin's Sources page, or `broadsheet source`; docs/phase-3.md A2). The database is the
// master copy for sources: a change here sticks unless the source's text in the config file changes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceFormat } from "@broadsheet/shared";
import { extractCartoon } from "../content/cartoon.ts";
import { transaction, type Db } from "../db/db.ts";
import type { MailPort } from "./stage-a-email.ts";
import { describeSplitWhen, setFormat, setSplitWhen, splitWhenOf, type SplitWhen } from "./split.ts";

export type SourceChanges = {
  name?: string | null;
  /** A section id, or null for none (Gemma chooses). */
  section?: string | null;
  format?: SourceFormat;
  /** true: its emails are skipped (left in the Inbox); false: included again. */
  muted?: boolean;
  /** Which emails a roundup or multi-section newsletter splits; null: every one. */
  splitWhen?: SplitWhen | null;
  /** Its newest post is always shown (at the top) until you've read it. */
  alwaysShow?: boolean;
  /** Its emails' cartoon of the day ("Today's Cartoon, by …") goes at the top of Everything Else. */
  cartoon?: boolean;
};

export type EditResult = { changed: string[]; moved: number; errors: string[] };

export async function editSource(
  db: Db,
  mail: MailPort,
  id: string,
  changes: SourceChanges,
  opts: { contentDir: string; cutoff: string; now: string },
): Promise<EditResult> {
  const src = db.prepare("SELECT id, coalesce(display_name, id) AS name, status, fixed_section_id, format FROM sources WHERE id = ?").get(id) as
    | { id: string; name: string; status: string; fixed_section_id: string | null; format: SourceFormat }
    | undefined;
  if (!src) throw new Error(`No newsletter with the id "${id}". See: broadsheet sources`);
  const sections = new Map((db.prepare("SELECT id, name, mail_folder_id FROM sections").all() as { id: string; name: string; mail_folder_id: string | null }[]).map((s) => [s.id, s]));
  if (changes.section && !sections.has(changes.section)) throw new Error(`No section "${changes.section}". Sections: ${[...sections.keys()].join(", ")}`);
  if (changes.name !== undefined && changes.name !== null && !changes.name.trim()) throw new Error("The name can't be empty.");

  const result: EditResult = { changed: [], moved: 0, errors: [] };

  if (changes.name !== undefined) {
    const name = changes.name?.trim() || null;
    db.prepare("UPDATE sources SET display_name = ? WHERE id = ?").run(name, id);
    result.changed.push(name ? `renamed to "${name}"` : "name reset");
  }

  if (changes.muted !== undefined && changes.muted !== (src.status === "muted")) {
    // Unmuting a source the agent found by itself makes it a regular one.
    db.prepare("UPDATE sources SET status = ? WHERE id = ?").run(changes.muted ? "muted" : "enabled", id);
    result.changed.push(changes.muted ? "turned off: its emails are left in the Inbox from now on" : "turned on again");
  }

  if (changes.section !== undefined && changes.section !== src.fixed_section_id) {
    const to = changes.section;
    db.prepare("UPDATE sources SET fixed_section_id = ? WHERE id = ?").run(to, id);
    if (!to) {
      // Gemma chooses from now on; current items keep the section they have.
      db.prepare("UPDATE items SET section_source = 'ai' WHERE source_id = ? AND section_source = 'fixed'").run(id);
      result.changed.push("no fixed section: Gemma chooses");
    } else {
      result.changed.push(`always in ${sections.get(to)!.name}`);
      // Current items follow, except ones you moved yourself; so do their emails, if they're in the Broadsheet's folders.
      const sortingId = (db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_sorting'").get() as { value: string } | undefined)?.value;
      const ours = new Set([sortingId, ...[...sections.values()].map((s) => s.mail_folder_id)].filter(Boolean));
      const current = db
        .prepare(
          `SELECT id, channel, message_id, mail_folder_id, hidden_by FROM items
           WHERE source_id = ? AND published_at >= ? AND coalesce(section_source, '') != 'user'`,
        )
        .all(id, opts.cutoff) as { id: string; channel: string; message_id: string | null; mail_folder_id: string | null; hidden_by: string | null }[];
      transaction(db, () => {
        for (const it of current) db.prepare("UPDATE items SET section_id = ?, section_source = 'fixed' WHERE id = ?").run(to, it.id);
      });
      const target = sections.get(to)!.mail_folder_id;
      for (const it of current) {
        if (it.channel !== "email" || !it.message_id || it.hidden_by || !target || !ours.has(it.mail_folder_id) || it.mail_folder_id === target) continue;
        try {
          await mail.move(it.message_id, target);
          db.prepare("UPDATE items SET mail_folder_id = ? WHERE id = ?").run(target, it.id);
          result.moved++;
        } catch (e) {
          result.errors.push(`couldn't move an email: ${(e as Error).message}`);
        }
      }
    }
  }

  if (changes.alwaysShow !== undefined) {
    const was = (db.prepare("SELECT always_show FROM sources WHERE id = ?").get(id) as { always_show: number }).always_show === 1;
    if (was !== changes.alwaysShow) {
      db.prepare("UPDATE sources SET always_show = ? WHERE id = ?").run(changes.alwaysShow ? 1 : 0, id);
      result.changed.push(changes.alwaysShow ? "always shown: its newest post stays at the top until you've read it" : "no longer always shown");
    }
  }

  if (changes.cartoon !== undefined) {
    const was = (db.prepare("SELECT cartoon FROM sources WHERE id = ?").get(id) as { cartoon: number }).cartoon === 1;
    if (was !== changes.cartoon) {
      db.prepare("UPDATE sources SET cartoon = ? WHERE id = ?").run(changes.cartoon ? 1 : 0, id);
      let found = 0;
      if (changes.cartoon) {
        // Its current emails, so today's cartoon shows on the next run rather than with the next email.
        const items = db.prepare("SELECT id FROM items WHERE source_id = ? AND parent_id IS NULL AND cartoon_json IS NULL").all(id) as { id: string }[];
        for (const it of items) {
          const html = await readFile(join(opts.contentDir, it.id, "article.html"), "utf8").catch(() => "");
          const c = html ? extractCartoon(html) : null;
          if (c) (db.prepare("UPDATE items SET cartoon_json = ? WHERE id = ?").run(JSON.stringify(c), it.id), found++);
        }
      }
      result.changed.push(changes.cartoon ? `shows its cartoon of the day${found ? ` (found ${found} in current emails)` : ""}` : "no longer shows its cartoon");
    }
  }

  if (changes.splitWhen !== undefined && JSON.stringify(changes.splitWhen ?? null) !== JSON.stringify(splitWhenOf(db, id))) {
    const r = await setSplitWhen(db, opts.contentDir, id, changes.splitWhen, opts.cutoff, opts.now);
    result.changed.push(`split ${describeSplitWhen(splitWhenOf(db, id))}${r.split ? ` (split ${r.split} current email${r.split === 1 ? "" : "s"})` : ""}${r.joined ? ` (put ${r.joined} back together)` : ""}`);
  }

  if (changes.format && changes.format !== src.format) {
    const r = await setFormat(db, opts.contentDir, id, changes.format, opts.cutoff, opts.now);
    result.changed.push(`format ${changes.format}${r.split ? ` (split ${r.split} current email${r.split === 1 ? "" : "s"})` : ""}${r.joined ? ` (put ${r.joined} back together)` : ""}`);
  }
  return result;
}
