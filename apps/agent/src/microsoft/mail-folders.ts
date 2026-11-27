// The Outlook folders that mirror the sections (PLAN.md §4.1):
//   <root>/<each section name>, <root>/_Sorting, <root>/_Add
// Folder ids are remembered, so renaming a section in the config renames its folder instead of
// creating a new one.
import { SYSTEM_FOLDERS, type Config } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import type { Graph } from "./graph.ts";

type Folder = { id: string; displayName: string; totalItemCount?: number };

export type FolderStatus = "ok" | "missing" | "rename";
export type FolderEntry = {
  /** Section id, or "_sorting" / "_add". */
  key: string;
  name: string;
  id: string | null;
  status: FolderStatus;
  currentName?: string;
};
export type FolderReport = { root: { name: string; id: string | null }; folders: FolderEntry[] };

const SELECT = "$select=id,displayName,totalItemCount&$top=100";

function wanted(config: Config): { key: string; name: string }[] {
  return [
    ...config.sections.map((s) => ({ key: s.id, name: s.name })),
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
    return { root: { name: rootName, id: null }, folders: wanted(config).map((w) => ({ ...w, id: null, status: "missing" })) };
  }
  const children = await graph.all<Folder>(`/me/mailFolders/${root.id}/childFolders?${SELECT}`);
  const folders = wanted(config).map((w): FolderEntry => {
    const byId = children.find((c) => c.id === stored.get(w.key));
    if (byId) {
      return sameName(byId.displayName, w.name)
        ? { ...w, id: byId.id, status: "ok" }
        : { ...w, id: byId.id, status: "rename", currentName: byId.displayName };
    }
    const byName = children.find((c) => sameName(c.displayName, w.name));
    return byName ? { ...w, id: byName.id, status: "ok" } : { ...w, id: null, status: "missing" };
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
