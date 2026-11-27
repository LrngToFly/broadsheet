// Admin's Email page (docs/phase-3.md A6): what was skipped, what you dropped into _Add, and newsletters the agent
// found by itself. All from the mail log (90 days), so nothing here needs Outlook until you act.
import type { Db } from "../db/db.ts";
import type { MailPort } from "./stage-a-email.ts";
import type { MessageSummary } from "../microsoft/mail.ts";

export type LoggedEmail = { key: string; receivedAt: string; sender: string; senderName: string | null; subject: string; why: string | null; source: string | null };

const rowsOf = (db: Db, where: string, ...params: string[]): LoggedEmail[] =>
  (db
    .prepare(
      `SELECT l.message_key, l.received_at, l.sender, l.sender_name, l.subject, l.why, coalesce(s.display_name, s.id) AS source
       FROM mail_log l LEFT JOIN sources s ON s.id = l.source_id WHERE ${where} ORDER BY l.received_at DESC LIMIT 200`,
    )
    .all(...params) as any[]).map((r) => ({ key: r.message_key, receivedAt: r.received_at, sender: r.sender, senderName: r.sender_name, subject: r.subject, why: r.why, source: r.source }));

export function mailReview(db: Db) {
  return {
    /** Left in the Inbox as account, sign-in, receipt or welcome mail, or from a newsletter you turned off. */
    skipped: rowsOf(db, "l.decision = 'skip'"),
    /** Emails you dropped into _Add. */
    added: rowsOf(db, "l.why = 'dropped in _Add'"),
    /** Newsletters the agent found by itself and you haven't looked at yet. */
    newSources: (db.prepare("SELECT count(*) n FROM sources WHERE status = 'new'").get() as { n: number }).n,
  };
}

/**
 * Include this one: a skipped email is still in the Inbox, so it's moved into _Add, and the next run includes it
 * whatever it looks like.
 */
export async function includeSkipped(db: Db, mail: Pick<MailPort, "move">, key: string): Promise<{ subject: string }> {
  const row = db.prepare("SELECT message_id, subject, decision FROM mail_log WHERE message_key = ?").get(key) as { message_id: string | null; subject: string; decision: string } | undefined;
  if (!row) throw new Error("That email isn't in the mail log (it keeps 90 days).");
  if (row.decision !== "skip") throw new Error(`"${row.subject}" is already in the paper.`);
  if (!row.message_id) throw new Error(`Can't find "${row.subject}" in Outlook any more. Drag it into _Add yourself.`);
  const add = (db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_add'").get() as { value: string } | undefined)?.value;
  if (!add) throw new Error("The _Add folder isn't set up. Run: broadsheet folders --create");
  try {
    await mail.move(row.message_id, add);
  } catch (e) {
    throw new Error(`Couldn't move "${row.subject}" (moved or deleted in Outlook?): ${(e as Error).message}`);
  }
  db.prepare("UPDATE mail_log SET why = 'sent to _Add from Admin' WHERE message_key = ?").run(key);
  return { subject: row.subject };
}

/** You've looked at the newsletters the agent found: they're no longer New. */
export function approveNew(db: Db, id?: string): number {
  const r = id
    ? db.prepare("UPDATE sources SET status = 'enabled' WHERE id = ? AND status = 'new'").run(id)
    : db.prepare("UPDATE sources SET status = 'enabled' WHERE status = 'new'").run();
  return Number(r.changes);
}

/**
 * Fill the skipped list with what the agent left in the Inbox before the mail log existed: emails it has seen
 * (the seen table, 90 days) that are still in the Inbox and never became an article. Reads Outlook only.
 */
export async function backfillSkipped(db: Db, mail: { list(folder: string, since?: Date): Promise<MessageSummary[]> }, now = new Date()): Promise<number> {
  const inbox = await mail.list("inbox", new Date(now.getTime() - 90 * 86_400_000));
  let added = 0;
  for (const m of inbox) {
    const key = m.internetMessageId;
    if (!key || !db.prepare("SELECT 1 FROM seen WHERE key = ?").get(`mail:${key}`)) continue; // not looked at yet: the next run will
    if (db.prepare("SELECT 1 FROM mail_log WHERE message_key = ?").get(key)) continue;
    if (db.prepare("SELECT 1 FROM items WHERE internet_message_id = ?").get(key)) continue;
    db.prepare(
      `INSERT INTO mail_log (message_key, message_id, received_at, sender, sender_name, subject, decision, why)
       VALUES (?, ?, ?, ?, ?, ?, 'skip', 'left in the Inbox (before the mail log started)')`,
    ).run(key, m.id, m.receivedDateTime, m.from?.emailAddress?.address?.toLowerCase() ?? "", m.from?.emailAddress?.name ?? null, m.subject ?? "(no subject)");
    added++;
  }
  return added;
}
