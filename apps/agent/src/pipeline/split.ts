// Roundup and multi-section newsletters become pieces (PLAN.md §4.4). The newsletter itself stays as an item
// of kind 'newsletter': it isn't shown, but it holds the email (filed once its pieces are read) and the
// "Read the whole newsletter" page. Each piece is an item of its own, so it can be rated, moved, saved and
// hidden like any article.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../backup.ts";
import type { SourceFormat } from "@broadsheet/shared";
import { z } from "zod";
import { transaction, type Db } from "../db/db.ts";
import { looksLikeRoundup, splitPieces } from "../content/split.ts";

export const pieceId = (parentId: string, n: number) => `${parentId}-${n}`;
const pieceKind = (format: SourceFormat) => (format === "roundup" ? "brief" : "article");

export const formatOf = (db: Db, sourceId: string): SourceFormat =>
  ((db.prepare("SELECT format FROM sources WHERE id = ?").get(sourceId) as { format: SourceFormat } | undefined)?.format ?? "normal");

/** Split one newsletter. Returns how many pieces it made, or 0 if it didn't split (it stays one article). */
export async function splitItem(db: Db, contentDir: string, itemId: string, format: Exclude<SourceFormat, "normal">, now: string): Promise<number> {
  const parent = db.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as any;
  if (!parent) return 0;
  const html = await readFile(join(contentDir, itemId, "article.html"), "utf8").catch(() => null);
  const pieces = html ? splitPieces(html) : null;
  if (!pieces) return 0;

  const old = (db.prepare("SELECT id FROM items WHERE parent_id = ?").all(itemId) as { id: string }[]).map((r) => r.id);
  for (const [i, p] of pieces.entries()) {
    const dir = join(contentDir, pieceId(itemId, i + 1));
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, "article.html"), p.html);
    await writeFileAtomic(join(dir, "article.txt"), p.text);
  }
  const fixed = parent.section_source === "fixed" ? parent.section_id : null;
  transaction(db, () => {
    retire(db, old.filter((id) => !pieces.some((_, i) => pieceId(itemId, i + 1) === id)));
    db.prepare("UPDATE items SET kind = 'newsletter', ai_status = 'skipped' WHERE id = ?").run(itemId);
    const insert = db.prepare(
      `INSERT INTO items (id, source_id, channel, title, author, published_at, content_origin, opening, word_count, section_id, section_source,
         ai_status, created_at, sender, list_id, shown_anyway, kind, parent_id, piece, links_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         -- Split again (a tidier cleaner, or the format set again): Gemma reads it again only if its words changed.
         ai_status = CASE WHEN items.title = excluded.title AND items.word_count = excluded.word_count THEN items.ai_status ELSE 'pending' END,
         ai_attempts = CASE WHEN items.title = excluded.title AND items.word_count = excluded.word_count THEN items.ai_attempts ELSE 0 END,
         title = excluded.title, opening = excluded.opening, word_count = excluded.word_count, kind = excluded.kind,
         links_json = excluded.links_json, content_published = 0`,
    );
    pieces.forEach((p, i) =>
      insert.run(
        pieceId(itemId, i + 1), parent.source_id, parent.channel, p.title, parent.author, parent.published_at, parent.content_origin,
        p.opening, p.wordCount, fixed, fixed ? "fixed" : null, now, parent.sender, parent.list_id, parent.shown_anyway,
        pieceKind(format), itemId, i + 1, JSON.stringify(p.links),
      ),
    );
  });
  return pieces.length;
}

/** Put a split newsletter back together as one article (its format was set back to normal). */
export function unsplit(db: Db, itemId: string) {
  transaction(db, () => {
    retire(db, (db.prepare("SELECT id FROM items WHERE parent_id = ?").all(itemId) as { id: string }[]).map((r) => r.id));
    db.prepare("UPDATE items SET kind = 'article', ai_status = CASE WHEN summary IS NULL THEN 'pending' ELSE 'done' END WHERE id = ?").run(itemId);
  });
}

/** Pieces that no longer exist: dated as long expired, so the next publish removes them everywhere,
 *  OneDrive included, the same way as any expired item. */
function retire(db: Db, ids: string[]) {
  const stmt = db.prepare("UPDATE items SET published_at = '1970-01-01T00:00:00.000Z', saved = 0, parent_id = NULL WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

/**
 * Which of a roundup or multi-section newsletter's emails are split. Any condition that matches splits it; none set
 * (null) splits every email. E.g. a newsletter whose weekend issue is a roundup: {weekend: true}.
 */
export const SplitWhen = z
  .object({
    /** The subject contains this (any case). */
    subject: z.string().trim().min(1).max(100).optional(),
    /** It arrived on a Saturday or Sunday (your time). */
    weekend: z.boolean().optional(),
    /** Its layout looks like a roundup: five or more short pieces under their own headings. */
    looksLike: z.boolean().optional(),
  })
  .strict();
export type SplitWhen = z.infer<typeof SplitWhen>;

export function splitWhenOf(db: Db, sourceId: string): SplitWhen | null {
  const raw = (db.prepare("SELECT split_when FROM sources WHERE id = ?").get(sourceId) as { split_when: string | null } | undefined)?.split_when;
  if (!raw) return null;
  const r = SplitWhen.safeParse(JSON.parse(raw));
  return r.success && (r.data.subject || r.data.weekend || r.data.looksLike) ? r.data : null;
}

/** Does this email meet its newsletter's split conditions? */
export function shouldSplit(when: SplitWhen | null, email: { subject: string; receivedAt: string; html: string }): boolean {
  if (!when) return true;
  if (when.subject && email.subject.toLowerCase().includes(when.subject.toLowerCase())) return true;
  if (when.weekend && [0, 6].includes(new Date(email.receivedAt).getDay())) return true;
  if (when.looksLike && looksLikeRoundup(email.html)) return true;
  return false;
}

/** In words, for `broadsheet sources` and Admin, e.g. 'when the subject contains "Weekend" or it arrives at the weekend'. */
export function describeSplitWhen(when: SplitWhen | null): string {
  if (!when) return "every email";
  const parts = [
    when.subject ? `the subject contains "${when.subject}"` : null,
    when.weekend ? "it arrives at the weekend" : null,
    when.looksLike ? "it looks like a roundup" : null,
  ].filter(Boolean);
  return `when ${parts.join(" or ")}`;
}

/** After Stage A files an email: split it if its newsletter is a roundup or multi-section one and the email meets
 *  its split conditions, or note that it looks like a roundup so `broadsheet sources` can suggest it. */
export async function afterFiling(
  db: Db, contentDir: string, itemId: string, sourceId: string, html: string, now: string, email: { subject: string; receivedAt: string },
): Promise<number> {
  const format = formatOf(db, sourceId);
  if (format !== "normal") return shouldSplit(splitWhenOf(db, sourceId), { ...email, html }) ? splitItem(db, contentDir, itemId, format, now) : 0;
  if (looksLikeRoundup(html)) db.prepare("UPDATE sources SET looks_like = 'roundup' WHERE id = ? AND format = 'normal'").run(sourceId);
  return 0;
}

/** Split an item now if its newsletter's format and split conditions say so (Stage B, for one shown again). */
export async function splitIfDue(db: Db, contentDir: string, itemId: string, now: string): Promise<number> {
  const it = db.prepare("SELECT source_id, title, published_at FROM items WHERE id = ?").get(itemId) as { source_id: string; title: string; published_at: string } | undefined;
  if (!it) return 0;
  const format = formatOf(db, it.source_id);
  if (format === "normal") return 0;
  const html = await readFile(join(contentDir, itemId, "article.html"), "utf8").catch(() => "");
  return shouldSplit(splitWhenOf(db, it.source_id), { subject: it.title, receivedAt: it.published_at, html }) ? splitItem(db, contentDir, itemId, format, now) : 0;
}

/**
 * Change a newsletter's format (`broadsheet format`) and apply it to its current emails: split them (again), or put
 * them back together.
 */
export async function setFormat(db: Db, contentDir: string, sourceId: string, format: SourceFormat, cutoff: string, now: string) {
  db.prepare("UPDATE sources SET format = ?, looks_like = NULL WHERE id = ?").run(format, sourceId);
  return applyFormat(db, contentDir, sourceId, cutoff, now);
}

/** Change which emails are split (null: all of them), and apply it to the current ones. */
export async function setSplitWhen(db: Db, contentDir: string, sourceId: string, when: SplitWhen | null, cutoff: string, now: string) {
  const clean = when && (when.subject || when.weekend || when.looksLike) ? when : null;
  db.prepare("UPDATE sources SET split_when = ? WHERE id = ?").run(clean ? JSON.stringify(clean) : null, sourceId);
  return applyFormat(db, contentDir, sourceId, cutoff, now);
}

/** Bring the newsletter's current emails in line with its format and split conditions: split, re-split, or join. */
async function applyFormat(db: Db, contentDir: string, sourceId: string, cutoff: string, now: string) {
  const format = formatOf(db, sourceId);
  const when = splitWhenOf(db, sourceId);
  const current = db
    .prepare("SELECT id, kind, title, published_at FROM items WHERE source_id = ? AND parent_id IS NULL AND channel = 'email' AND published_at >= ? AND hidden_by IS NULL")
    .all(sourceId, cutoff) as { id: string; kind: string; title: string; published_at: string }[];
  let split = 0;
  let joined = 0;
  for (const it of current) {
    const html = format === "normal" ? "" : await readFile(join(contentDir, it.id, "article.html"), "utf8").catch(() => "");
    const wanted = format !== "normal" && shouldSplit(when, { subject: it.title, receivedAt: it.published_at, html });
    if (!wanted) {
      if (it.kind === "newsletter") (unsplit(db, it.id), joined++);
    } else if (await splitItem(db, contentDir, it.id, format as Exclude<SourceFormat, "normal">, now)) {
      split++;
    }
  }
  return { split, joined, current: current.length };
}

