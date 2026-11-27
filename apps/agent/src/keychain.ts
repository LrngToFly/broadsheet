// A small secret kept in the macOS login Keychain, read and written with Apple's own `security` tool.
// Secrets never appear in command-line arguments (other processes can see those): writes go through
// `security -i` on stdin, and reads come back on stdout.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SECURITY = "/usr/bin/security";

export type KeychainItem = { service: string; account: string; label: string };

/** The stored text, or null if there is no such item. */
export async function readSecret(item: KeychainItem): Promise<string | null> {
  try {
    const { stdout } = await run(SECURITY, ["find-generic-password", "-s", item.service, "-a", item.account, "-w"]);
    return stdout.replace(/\n$/, "");
  } catch (e) {
    // Exit code 44: the item does not exist.
    if ((e as { code?: number }).code === 44) return null;
    throw new Error(`Keychain read failed: ${(e as Error).message}`);
  }
}

/** Create or replace the item. `secret` must be printable text without newlines. */
export async function writeSecret(item: KeychainItem, secret: string): Promise<void> {
  if (/[\r\n]/.test(secret)) throw new Error("secret must not contain newlines");
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
  const line = `add-generic-password -U -s ${quote(item.service)} -a ${quote(item.account)} -l ${quote(item.label)} -X ${hex}\n`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && !err ? resolve() : reject(new Error(`Keychain write failed: ${err.trim() || code}`))));
    child.stdin.end(line);
  });
}

export async function deleteSecret(item: KeychainItem): Promise<boolean> {
  try {
    await run(SECURITY, ["delete-generic-password", "-s", item.service, "-a", item.account]);
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 44) return false;
    throw e;
  }
}
