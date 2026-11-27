import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, rotateLogs } from "../src/housekeeping.ts";
import { LABEL, plist } from "../src/launchd.ts";

describe("the launchd job", () => {
  it("runs the agent in the background every 15 minutes at low priority", () => {
    const x = plist({ node: "/opt/homebrew/bin/node", cli: "/Users/me/The Broadsheet/apps/agent/src/cli.ts", workingDir: "/Users/me/The Broadsheet", logFile: "/Users/me/Library/Logs/Broadsheet/agent.log" });
    expect(x).toContain(`<string>${LABEL}</string>`);
    expect(x).toContain("<key>StartInterval</key>\n  <integer>900</integer>");
    expect(x).toContain("<key>ProcessType</key>\n  <string>Background</string>");
    expect(x).toContain("<key>Nice</key>\n  <integer>10</integer>");
    expect(x).toContain("<key>LowPriorityIO</key>\n  <true/>");
    expect(x).toMatch(/<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/me\/The Broadsheet\/apps\/agent\/src\/cli.ts<\/string>\s*<string>run<\/string>/);
  });

  it("escapes paths for XML", () => {
    expect(plist({ node: "n", cli: "/a & b/<c>.ts", workingDir: "w", logFile: "l" })).toContain("/a &amp; b/&lt;c&gt;.ts");
  });
});

describe("one run at a time", () => {
  it("refuses a second run while the first is alive, and takes over a lock left by a crashed run", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "bs-lock-")), "run.lock");
    const release = await acquireLock(file);
    expect(release).not.toBeNull();

    writeFileSync(file, String(process.ppid)); // a different, living process holds it
    expect(await acquireLock(file)).toBeNull();

    writeFileSync(file, "999999"); // no such process
    const again = await acquireLock(file);
    expect(again).not.toBeNull();
    await again!();
    expect(existsSync(file)).toBe(false);
  });
});

describe("logs", () => {
  it("starts a new file when the log is big, and deletes logs older than 14 days", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-logs-"));
    writeFileSync(join(dir, "agent.log"), "x".repeat(6 * 1024 * 1024));
    writeFileSync(join(dir, "agent-old.log"), "old");
    const old = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    utimesSync(join(dir, "agent-old.log"), old, old);
    await rotateLogs(dir);
    const names = readdirSync(dir);
    expect(names).not.toContain("agent.log");
    expect(names).not.toContain("agent-old.log");
    expect(names.filter((n) => /^agent-\d{4}-/.test(n))).toHaveLength(1);
  });
});
