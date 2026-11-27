// Small things that keep unattended runs safe: one run at a time, tidy logs, and no sleeping mid-run.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Take the run lock, or return null if another live run holds it (e.g. you ran it by hand while launchd did). */
export async function acquireLock(file: string): Promise<(() => Promise<void>) | null> {
  const release = async () => {
    await rm(file, { force: true });
  };
  try {
    await writeFile(file, String(process.pid), { flag: "wx" });
    return release;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const holder = Number(await readFile(file, "utf8").catch(() => "0"));
  if (holder && holder !== process.pid && isAlive(holder)) return null;
  // A run that crashed left its lock behind: take it over.
  await writeFile(file, String(process.pid));
  return release;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const LOG_FILE = "agent.log";
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_DAYS = 14;

/** Start a new log file once the current one is big, and delete logs older than 14 days (PLAN.md §7.1). */
export async function rotateLogs(dir: string, now = new Date()): Promise<void> {
  await mkdir(dir, { recursive: true });
  const current = join(dir, LOG_FILE);
  const size = await stat(current).then((s) => s.size).catch(() => 0);
  if (size > MAX_LOG_BYTES) await rename(current, join(dir, `agent-${now.toISOString().replace(/[:.]/g, "-")}.log`));
  for (const name of await readdir(dir)) {
    if (!/^agent-.*\.log$/.test(name)) continue;
    const { mtime } = await stat(join(dir, name));
    if (now.getTime() - mtime.getTime() > KEEP_DAYS * 24 * 3600 * 1000) await rm(join(dir, name), { force: true });
  }
}

/** Keep the Mac from idle-sleeping until this process exits (macOS's own `caffeinate`). */
export function keepAwakeWhileRunning(): void {
  try {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Not fatal: the run just might be interrupted by sleep.
  }
}
