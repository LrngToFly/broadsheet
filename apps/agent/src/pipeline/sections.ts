// Changing the paper's sections (Admin's Sections page, or `broadsheet sections set`; docs/phase-3.md A3). You give the
// whole list you want, in order; this works out what changes, says so in words for a preview, and applies it to the
// database and the Outlook folders together. Removing a section never deletes mail: its emails move to the catch-all
// section's folder first, and only the empty folder is removed.
import { FALLBACK_SECTION_ID, SYSTEM_FOLDERS } from "@broadsheet/shared";
import { transaction, type Db } from "../db/db.ts";

export type WantedSection = { id?: string; name: string };

export type SectionPlan = {
  add: { id: string; name: string }[];
  rename: { id: string; from: string; to: string }[];
  remove: { id: string; name: string; articles: number; sources: number }[];
  /** Section ids in their new order (null when the order doesn't change). */
  order: string[] | null;
  /** Things that stop it from being applied. */
  problems: string[];
};

/** What Outlook needs to do; a fake in tests. */
export type FolderPort = {
  create(name: string): Promise<string>;
  rename(folderId: string, name: string): Promise<void>;
  /** Move every email in one folder to another; returns how many. */
  moveAll(fromFolderId: string, toFolderId: string): Promise<number>;
  remove(folderId: string): Promise<void>;
};

export const MAX_SECTION_NAME = 60;

const slug = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "section";

export function planSections(db: Db, wanted: WantedSection[]): SectionPlan {
  const current = db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[];
  const byId = new Map(current.map((s) => [s.id, s]));
  const plan: SectionPlan = { add: [], rename: [], remove: [], order: null, problems: [] };

  const names = new Set<string>();
  const used = new Set(current.map((s) => s.id));
  const ids: string[] = [];
  for (const w of wanted) {
    const name = w.name.trim().replace(/\s+/g, " ");
    if (!name) plan.problems.push("A section needs a name.");
    else if (name.length > MAX_SECTION_NAME) plan.problems.push(`"${name}" is too long (${MAX_SECTION_NAME} characters at most).`);
    else if (name.startsWith("_") || [SYSTEM_FOLDERS.sorting, SYSTEM_FOLDERS.add].some((f) => f.toLowerCase() === name.toLowerCase())) {
      plan.problems.push(`"${name}" can't be used: names starting with _ are the Broadsheet's own folders.`);
    } else if (/[\\/]/.test(name)) plan.problems.push(`"${name}" can't contain / or \\ (it's an Outlook folder name).`);
    if (names.has(name.toLowerCase())) plan.problems.push(`There are two sections called "${name}".`);
    names.add(name.toLowerCase());

    if (w.id) {
      const old = byId.get(w.id);
      if (!old) {
        plan.problems.push(`There's no section with the id "${w.id}".`);
        continue;
      }
      if (ids.includes(w.id)) plan.problems.push(`"${old.name}" is listed twice.`);
      if (old.name !== name && name) plan.rename.push({ id: w.id, from: old.name, to: name });
      ids.push(w.id);
    } else {
      let id = slug(name);
      for (let n = 2; used.has(id); n++) id = `${slug(name)}-${n}`;
      used.add(id);
      plan.add.push({ id, name });
      ids.push(id);
    }
  }

  for (const s of current) {
    if (ids.includes(s.id)) continue;
    if (s.id === FALLBACK_SECTION_ID) {
      plan.problems.push(`"${s.name}" can't be removed: it's where everything without a section goes.`);
      continue;
    }
    const articles = (db.prepare("SELECT count(*) n FROM items WHERE section_id = ?").get(s.id) as { n: number }).n;
    const sources = (db.prepare("SELECT count(*) n FROM sources WHERE fixed_section_id = ?").get(s.id) as { n: number }).n;
    plan.remove.push({ id: s.id, name: s.name, articles, sources });
  }

  const kept = current.map((s) => s.id).filter((id) => ids.includes(id));
  const keptInNewOrder = ids.filter((id) => byId.has(id));
  if (plan.add.length || kept.join() !== keptInNewOrder.join()) plan.order = ids;
  return plan;
}

/** The preview, in words, e.g. 'Rename "Financial" to "Financial & Retirement" (and its Outlook folder)'. */
export function describePlan(plan: SectionPlan, db: Db, emails: Map<string, number> = new Map()): string[] {
  const fallback = (db.prepare("SELECT name FROM sections WHERE id = ?").get(FALLBACK_SECTION_ID) as { name: string } | undefined)?.name ?? "Everything Else";
  const lines: string[] = [];
  for (const a of plan.add) lines.push(`Add "${a.name}", with a new Outlook folder of that name`);
  for (const r of plan.rename) lines.push(`Rename "${r.from}" to "${r.to}", and its Outlook folder`);
  for (const r of plan.remove) {
    const n = emails.get(r.id);
    const parts = [
      n === undefined ? `its emails move to the "${fallback}" folder` : n ? `its ${n} email${n === 1 ? "" : "s"} move to the "${fallback}" folder` : null,
      r.articles ? `${r.articles} current article${r.articles === 1 ? "" : "s"} move to ${fallback}` : null,
      r.sources ? `${r.sources} newsletter${r.sources === 1 ? " fixed to it goes" : "s fixed to it go"} back to Gemma choosing` : null,
    ].filter(Boolean);
    lines.push(parts.length ? `Remove "${r.name}": ${parts.join("; ")}; then its empty Outlook folder is deleted` : `Remove "${r.name}" and its empty Outlook folder`);
  }
  if (plan.order && !plan.add.length) lines.push("Change the order of the sections (the paper's tabs follow)");
  return lines;
}

export type ApplyResult = { done: string[]; errors: string[] };

/**
 * Apply a plan: each change in Outlook first, then in the database, so a failure leaves the two in step. Stops at
 * the first failure; what was done stays done, and applying the same list again finishes the rest.
 */
export async function applySections(db: Db, plan: SectionPlan, folders: FolderPort): Promise<ApplyResult> {
  const result: ApplyResult = { done: [], errors: [] };
  if (plan.problems.length) {
    result.errors.push(...plan.problems);
    return result;
  }
  const folderOf = (id: string) => (db.prepare("SELECT mail_folder_id FROM sections WHERE id = ?").get(id) as { mail_folder_id: string | null } | undefined)?.mail_folder_id ?? null;
  const step = async (what: string, fn: () => Promise<void>) => {
    if (result.errors.length) return;
    try {
      await fn();
      result.done.push(what);
    } catch (e) {
      result.errors.push(`${what}: ${(e as Error).message}`);
    }
  };

  const top = (db.prepare("SELECT coalesce(max(sort_order), 0) n FROM sections").get() as { n: number }).n;
  for (const [i, a] of plan.add.entries()) {
    await step(`added "${a.name}"`, async () => {
      const folderId = await folders.create(a.name);
      db.prepare("INSERT INTO sections (id, name, sort_order, mail_folder_id) VALUES (?, ?, ?, ?)").run(a.id, a.name, top + 1 + i, folderId);
    });
  }
  for (const r of plan.rename) {
    await step(`renamed "${r.from}" to "${r.to}"`, async () => {
      const folderId = folderOf(r.id);
      if (folderId) await folders.rename(folderId, r.to);
      db.prepare("UPDATE sections SET name = ? WHERE id = ?").run(r.to, r.id);
    });
  }
  for (const r of plan.remove) {
    await step(`removed "${r.name}"`, async () => {
      const folderId = folderOf(r.id);
      const fallbackFolder = folderOf(FALLBACK_SECTION_ID);
      if (folderId) {
        if (!fallbackFolder) throw new Error("the catch-all section has no Outlook folder yet (run: broadsheet folders --create)");
        await folders.moveAll(folderId, fallbackFolder);
      }
      transaction(db, () => {
        // Its articles go to the catch-all section; their emails are already in its folder.
        db.prepare("UPDATE items SET section_id = ?, section_source = CASE WHEN section_source = 'user' THEN 'user' ELSE 'ai' END WHERE section_id = ?").run(FALLBACK_SECTION_ID, r.id);
        if (folderId && fallbackFolder) db.prepare("UPDATE items SET mail_folder_id = ? WHERE mail_folder_id = ?").run(fallbackFolder, folderId);
        db.prepare("DELETE FROM sections WHERE id = ?").run(r.id); // sources and rules fixed to it: set to none by the schema
      });
      if (folderId) await folders.remove(folderId);
    });
  }
  if (plan.order && !result.errors.length) {
    transaction(db, () => plan.order!.forEach((id, i) => db.prepare("UPDATE sections SET sort_order = ? WHERE id = ?").run(i, id)));
    if (!plan.add.length) result.done.push("changed the order");
  }
  return result;
}
