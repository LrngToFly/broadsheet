// Run the agent on its own every 15 minutes with a per-user launchd LaunchAgent (PLAN.md §6.1, §6.3):
// background quality of service (efficiency cores, throttled disk), Nice 10, low-priority I/O.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LABEL = "com.thebroadsheet.agent";
export const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const INTERVAL_SECONDS = 15 * 60;

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Prefer Homebrew's stable "node" link over the versioned Cellar path, so a Node upgrade doesn't break the job. */
export function stableNodePath(execPath = process.execPath): string {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(candidate)) return candidate;
  }
  return execPath;
}

export function plist(opts: { node: string; cli: string; workingDir: string; logFile: string }): string {
  const args = [opts.node, opts.cli, "run"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(opts.workingDir)}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid!()}`;

export async function install(opts: { cli: string; workingDir: string; logFile: string }): Promise<void> {
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await uninstall(); // replace any older version
  await writeFile(PLIST, plist({ node: stableNodePath(), ...opts }));
  await run("/bin/launchctl", ["bootstrap", domain(), PLIST]);
}

export async function uninstall(): Promise<boolean> {
  const was = existsSync(PLIST);
  await run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {}); // not loaded is fine
  await rm(PLIST, { force: true });
  return was;
}

export type JobStatus = { installed: boolean; loaded: boolean; running: boolean; lastExit: string | null };

export async function status(): Promise<JobStatus> {
  const installed = existsSync(PLIST);
  try {
    const { stdout } = await run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]);
    return {
      installed,
      loaded: true,
      running: /^\s*state = running/m.test(stdout),
      lastExit: stdout.match(/last exit code = (.+)/)?.[1]?.trim() ?? null,
    };
  } catch {
    return { installed, loaded: false, running: false, lastExit: null };
  }
}

/** System sleep setting in minutes (0 = never). The Mac must stay awake when idle for AI work to happen. */
export async function systemSleepMinutes(): Promise<number | null> {
  const { stdout } = await run("/usr/bin/pmset", ["-g", "custom"]).catch(() => ({ stdout: "" }));
  // On a desktop Mac there's one "AC Power" block; take the first "sleep" value.
  const m = stdout.match(/^\s*sleep\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}
