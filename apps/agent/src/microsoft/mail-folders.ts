// The Outlook folders that mirror the sections (PLAN.md §4.1):
//   <root>/<each section name>, <root>/_Sorting, <root>/_Add
// Folder ids are remembered, so renaming a section renames its folder instead of creating a new one.
import { SYSTEM_FOLDERS, type Config } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import type { Graph } from "./graph.ts";
import type { Mail } from "./mail.ts";
import type { FolderPort } from "../pipeline/sections.ts";

type Folder = { id: string; displayName: string; totalItemCount?: number };

export type FolderStatus = "ok" | "missing" | "rename";
export type FolderEntry = {
  /** Section id, or "_sorting" / "_add". */
  key: string;
  name: string;
  id: string | null;
  status: FolderStatus;
  currentName?: string;
  /** Emails in it, when it exists. */
  emails?: number;
};
export type FolderReport = { root: { name: string; id: string | null }; folders: FolderEntry[] };

const SELECT = "$select=id,displayName,totalItemCount&$top=100";

/** The sections in the database (the master copy since Phase 3 A3), plus the two working folders. */
function wanted(db: Db): { key: string; name: string }[] {
  return [
    ...(db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[]).map((s) => ({ key: s.id, name: s.name })),
    { key: "_sorting", name: SYSTEM_FOLDERS.sorting },
    { key: "_add", name: SYSTEM_FOLDERS.add },
  ];
}

function storedIds(db: Db): Map<string, string> {
  const ids = new Map<string, string>();
  for (const r of db.prepare("SELECT id, mail_folder_id FROM sections WHERE mail_folder_id IS NOT NULL").all() as { id: string; mail_folder_id: string }[]) {
    ids.set(r.id, r.mail_folder_id);
  }
  for (const r of db.prepare("SELECT key, value FROM agent_state WHERE key LIKE 'folder:%'").all() as { key: string; value: string }[]) {
    ids.set(r.key.slice("folder:".length), r.value);
  }
  return ids;
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** Look, don't touch: what exists, what's missing, and what would be renamed. */
export async function checkFolders(graph: Graph, config: Config, db: Db): Promise<FolderReport> {
  const rootName = config.mailbox.rootFolder;
  const stored = storedIds(db);
  const top = await graph.all<Folder>(`/me/mailFolders?${SELECT}`);
  const root = top.find((f) => f.id === stored.get("_root")) ?? top.find((f) => sameName(f.displayName, rootName));
  if (!root) {
    return { root: { name: rootName, id: null }, folders: wanted(db).map((w) => ({ ...w, id: null, status: "missing" })) };
  }
  const children = await graph.all<Folder>(`/me/mailFolders/${root.id}/childFolders?${SELECT}`);
  const folders = wanted(db).map((w): FolderEntry => {
    const byId = children.find((c) => c.id === stored.get(w.key));
    if (byId) {
      return sameName(byId.displayName, w.name)
        ? { ...w, id: byId.id, status: "ok", emails: byId.totalItemCount }
        : { ...w, id: byId.id, status: "rename", currentName: byId.displayName, emails: byId.totalItemCount };
    }
    const byName = children.find((c) => sameName(c.displayName, w.name));
    return byName ? { ...w, id: byName.id, status: "ok", emails: byName.totalItemCount } : { ...w, id: null, status: "missing" };
  });
  return { root: { name: rootName, id: root.id }, folders };
}

/** Create missing folders, rename changed ones, and remember every folder id. Never deletes. */
export async function ensureFolders(graph: Graph, config: Config, db: Db): Promise<FolderReport & { changes: string[] }> {
  const report = await checkFolders(graph, config, db);
  const changes: string[] = [];

  let rootId = report.root.id;
  if (!rootId) {
    const made = await graph.call<Folder>("/me/mailFolders", { method: "POST", body: { displayName: report.root.name } });
    rootId = made.id;
    changes.push(`created "${report.root.name}"`);
  }
  setState(db, "folder:_root", rootId);

  for (const f of report.folders) {
    if (f.status === "missing") {
      const made = await graph.call<Folder>(`/me/mailFolders/${rootId}/childFolders`, { method: "POST", body: { displayName: f.name } });
      f.id = made.id;
      changes.push(`created "${report.root.name}/${f.name}"`);
    } else if (f.status === "rename") {
      await graph.call(`/me/mailFolders/${f.id}`, { method: "PATCH", body: { displayName: f.name } });
      changes.push(`renamed "${f.currentName}" → "${f.name}"`);
    }
    f.status = "ok";
    if (f.key.startsWith("_")) setState(db, `folder:${f.key}`, f.id!);
    else db.prepare("UPDATE sections SET mail_folder_id = ? WHERE id = ?").run(f.id, f.key);
  }
  return { root: { name: report.root.name, id: rootId }, folders: report.folders, changes };
}

function setState(db: Db, key: string, value: string) {
  db.prepare("INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Section folder changes in Outlook, for the Sections page (docs/phase-3.md A3). */
export function graphFolderPort(graph: Graph, mail: Pick<Mail, "list" | "move">, db: Db): FolderPort {
  const root = () => {
    const id = (db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_root'").get() as { value: string } | undefined)?.value;
    if (!id) throw new Error("The Outlook folders aren't set up yet. Run: broadsheet folders --create");
    return id;
  };
  return {
    create: async (name) => (await graph.call<Folder>(`/me/mailFolders/${root()}/childFolders`, { method: "POST", body: { displayName: name } })).id,
    rename: async (id, name) => void (await graph.call(`/me/mailFolders/${id}`, { method: "PATCH", body: { displayName: name } })),
    moveAll: async (from, to) => {
      const messages = await mail.list(from);
      for (const m of messages) await mail.move(m.id, to);
      return messages.length;
    },
    remove: async (id) => void (await graph.call(`/me/mailFolders/${id}`, { method: "DELETE" })),
  };
}

