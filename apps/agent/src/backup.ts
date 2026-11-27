// Protecting the long-term data on a Mac that's also someone's personal computer (power cuts, a failing disk):
//   - a backup of the database each day, gzip-compressed, the last 7 kept (backups/ next to the database)
//   - a copy to the private OneDrive App Folder once a week, the last 4 kept there
//   - an integrity check before each run; if the database is damaged, the run stops and says which backup to restore
// The database is small (the long-term data: sources, rules, sections, settings, your words and ratings), so the
// backups are too. Articles aren't backed up: they expire after a few days by design.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { Db } from "./db/db.ts";

export const KEEP_DAILY = 7;
export const KEEP_CLOUD = 4;
const CLOUD_FOLDER = "backups";
const NAME = /^broadsheet-(\d{4}-\d{2}-\d{2})\.db\.gz$/;

/** Your local date, e.g. 2026-11-27 (backups are named by the day they were made). */
export const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Write a file in one step: to a temporary name first, then renamed into place, so a power cut can't leave half of it. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export type BackupInfo = { name: string; path: string; date: string; bytes: number };

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => NAME.test(n)).sort().reverse();
  return Promise.all(names.map(async (name) => ({ name, path: join(dir, name), date: name.match(NAME)![1]!, bytes: (await stat(join(dir, name))).size })));
}

/** Today's backup, unless there is one; then only the newest KEEP_DAILY are kept. Returns the new file, if any. */
export async function dailyBackup(db: Db, dir: string, now = new Date(), opts: { force?: boolean } = {}): Promise<{ made: string | null; removed: string[] }> {
  await mkdir(dir, { recursive: true });
  const name = `broadsheet-${localDate(now)}.db.gz`;
  const target = join(dir, name);
  const exists = await stat(target).then(() => true, () => false);
  let made: string | null = null;
  if (!exists || opts.force) {
    // VACUUM INTO writes a consistent copy even while the database is in use.
    const tmp = join(dir, `.copy-${process.pid}.db`);
    await rm(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    await pipeline(createReadStream(tmp), createGzip({ level: 9 }), createWriteStream(`${target}.tmp`));
    await rename(`${target}.tmp`, target);
    await rm(tmp, { force: true });
    made = target;
  }
  const removed: string[] = [];
  for (const old of (await listBackups(dir)).slice(KEEP_DAILY)) {
    await rm(old.path, { force: true });
    removed.push(old.name);
  }
  return { made, removed };
}

/** Once a week, a copy of the newest backup goes to the OneDrive App Folder (backups/); the newest KEEP_CLOUD stay. */
export async function weeklyCloudBackup(
  folder: { put(path: string, body: Uint8Array, type: string): Promise<unknown>; list(folder: string): Promise<string[]>; delete(path: string): Promise<void> },
  dir: string,
  now = new Date(),
): Promise<string | null> {
  const local = (await listBackups(dir))[0];
  if (!local) return null;
  const inCloud = (await folder.list(CLOUD_FOLDER).catch(() => [] as string[])).filter((n) => NAME.test(n)).sort().reverse();
  const newest = inCloud[0]?.match(NAME)?.[1];
  if (newest && (now.getTime() - new Date(`${newest}T12:00:00`).getTime()) / 86_400_000 < 7) return null;
  const { readFile } = await import("node:fs/promises");
  await folder.put(`${CLOUD_FOLDER}/${local.name}`, new Uint8Array(await readFile(local.path)), "application/gzip");
  for (const old of [local.name, ...inCloud.filter((n) => n !== local.name)].slice(KEEP_CLOUD)) await folder.delete(`${CLOUD_FOLDER}/${old}`).catch(() => {});
  return local.name;
}

/** null if the database is fine, otherwise what SQLite found. */
export function integrityProblem(db: Db): string | null {
  const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
  const problems = rows.map((r) => r.quick_check).filter((r) => r !== "ok");
  return problems.length ? problems.slice(0, 5).join("; ") : null;
}

/**
 * Put a backup back in place of the database. The current database (and its WAL files) are kept beside it as
 * broadsheet.damaged-<time>.db, never deleted. Only with no run going (the caller holds the run lock).
 */
export async function restoreBackup(backup: string, dbPath: string, now = new Date()): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const aside = dbPath.replace(/\.db$/, `.damaged-${stamp}.db`);
  if (await stat(dbPath).then(() => true, () => false)) await rename(dbPath, aside);
  for (const ext of ["-wal", "-shm"]) await rename(`${dbPath}${ext}`, `${aside}${ext}`).catch(() => {});
  await pipeline(createReadStream(backup), createGunzip(), createWriteStream(`${dbPath}.tmp`));
  await rename(`${dbPath}.tmp`, dbPath);
  return aside;
}
