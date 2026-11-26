// Phase 0 spike (b): Microsoft sign-in + Graph mail/OneDrive for the newsletter account.
// Throwaway code to prove the approach; the real agent will be structured properly.
//
// Usage (from the spikes folder):
//   node mail/mail.ts login        one-time device-code sign-in
//   node mail/mail.ts whoami       which account is signed in
//   node mail/mail.ts inbox [n]    list newest n Inbox messages with newsletter headers
//   node mail/mail.ts folders      create "The Broadsheet" and "_Sorting" if missing
//   node mail/mail.ts move <id>    move one message (by id) into The Broadsheet/_Sorting
//   node mail/mail.ts export [n]   save the newest n Inbox messages as .eml for the Gemma test
//   node mail/mail.ts onedrive     write + read a test file in the OneDrive App Folder
//
// The Entra client ID is read from ../local/config.local.json  {"clientId": "..."}
// (gitignored). The token cache lives outside the repo, readable only by you.

import { PublicClientApplication, type AuthenticationResult, type ICachePlugin, type TokenCacheContext } from "@azure/msal-node";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "..", "local", "config.local.json");
const STATE_DIR = join(homedir(), "Library", "Application Support", "Broadsheet-spike");
const CACHE_FILE = join(STATE_DIR, "msal-cache.json");
const OUT_DIR = join(here, "out");
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["Mail.ReadWrite", "Files.ReadWrite.AppFolder", "User.Read", "offline_access"];

async function clientId(): Promise<string> {
  if (!existsSync(CONFIG)) throw new Error(`Missing ${CONFIG} — create it with {"clientId": "<Application (client) ID>"}`);
  const { clientId } = JSON.parse(await readFile(CONFIG, "utf8"));
  if (!clientId) throw new Error("clientId missing in config.local.json");
  return clientId;
}

// Spike-only file cache (chmod 600). The real agent stores this in the macOS Keychain.
const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    if (existsSync(CACHE_FILE)) ctx.tokenCache.deserialize(await readFile(CACHE_FILE, "utf8"));
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (!ctx.cacheHasChanged) return;
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, ctx.tokenCache.serialize(), { mode: 0o600 });
    await chmod(CACHE_FILE, 0o600);
  },
};

async function app() {
  return new PublicClientApplication({
    auth: { clientId: await clientId(), authority: "https://login.microsoftonline.com/consumers" },
    cache: { cachePlugin },
  });
}

async function token(interactive = false): Promise<AuthenticationResult> {
  const pca = await app();
  const [account] = await pca.getTokenCache().getAllAccounts();
  if (account && !interactive) {
    const r = await pca.acquireTokenSilent({ account, scopes: SCOPES, forceRefresh: process.env.FORCE_REFRESH === "1" });
    if (r) return r;
  }
  if (!interactive) throw new Error("Not signed in. Run: node mail/mail.ts login");
  const r = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (resp) => console.log("\n" + resp.message + "\n"),
  });
  if (!r) throw new Error("Sign-in returned no token");
  return r;
}

async function graph(path: string, init: RequestInit = {}): Promise<any> {
  const t = await token();
  const res = await fetch(path.startsWith("http") ? path : GRAPH + path, {
    ...init,
    headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  const type = res.headers.get("content-type") ?? "";
  return type.includes("json") ? res.json() : res.text();
}

const header = (m: any, name: string) =>
  m.internetMessageHeaders?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;

function platformOf(m: any): string {
  const from = (m.from?.emailAddress?.address ?? "").toLowerCase();
  const listId = (header(m, "List-Id") ?? "").toLowerCase();
  for (const p of ["substack", "beehiiv", "ghost", "buttondown", "convertkit", "kit.com", "mailchimp", "medium"]) {
    if (from.includes(p) || listId.includes(p)) return p;
  }
  return header(m, "List-Unsubscribe") ? "newsletter?" : "-";
}

async function findFolder(name: string, parentId?: string) {
  const base = parentId ? `/me/mailFolders/${parentId}/childFolders` : `/me/mailFolders`;
  const r = await graph(`${base}?$filter=displayName eq '${name.replace(/'/g, "''")}'&$select=id,displayName,totalItemCount`);
  return r.value[0] as { id: string; displayName: string; totalItemCount: number } | undefined;
}

async function ensureFolder(name: string, parentId?: string) {
  const existing = await findFolder(name, parentId);
  if (existing) return { ...existing, created: false };
  const base = parentId ? `/me/mailFolders/${parentId}/childFolders` : `/me/mailFolders`;
  const made = await graph(base, { method: "POST", body: JSON.stringify({ displayName: name }) });
  return { ...made, created: true };
}

async function inboxMessages(n: number) {
  const sel = "id,subject,from,receivedDateTime,internetMessageHeaders";
  const r = await graph(`/me/mailFolders/inbox/messages?$top=${n}&$orderby=receivedDateTime desc&$select=${sel}`);
  return r.value as any[];
}

const [cmd = "whoami", arg] = process.argv.slice(2);

switch (cmd) {
  case "login": {
    const r = await token(true);
    console.log(`Signed in as ${r.account?.username}. Token cache: ${CACHE_FILE}`);
    break;
  }
  case "whoami": {
    const me = await graph("/me?$select=displayName,userPrincipalName,mail");
    console.log(me);
    break;
  }
  case "inbox": {
    for (const m of await inboxMessages(Number(arg ?? 25))) {
      const when = new Date(m.receivedDateTime).toLocaleString();
      console.log(`${when}  [${platformOf(m)}]  ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}>\n    ${m.subject}\n    id: ${m.id.slice(0, 24)}…`);
    }
    break;
  }
  case "folders": {
    const top = await ensureFolder("The Broadsheet");
    const sorting = await ensureFolder("_Sorting", top.id);
    console.log(`${top.created ? "Created" : "Found"} "The Broadsheet"; ${sorting.created ? "created" : "found"} "_Sorting" inside it.`);
    break;
  }
  case "move": {
    // Accepts a full message id, or text that appears in exactly one recent Inbox subject.
    if (!arg) throw new Error('Usage: node mail/mail.ts move <message id | "subject text">');
    const top = await findFolder("The Broadsheet");
    const sorting = top && (await findFolder("_Sorting", top.id));
    if (!sorting) throw new Error('Run "folders" first');
    let id = arg;
    if (arg.length < 60) {
      const hits = (await inboxMessages(50)).filter((m) => (m.subject ?? "").toLowerCase().includes(arg.toLowerCase()));
      if (hits.length !== 1) throw new Error(`Expected exactly one Inbox subject containing "${arg}", found ${hits.length}`);
      id = hits[0].id;
    }
    const moved = await graph(`/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: sorting.id }) });
    console.log(`Moved "${moved.subject}" to The Broadsheet/_Sorting`);
    break;
  }
  case "export": {
    await mkdir(OUT_DIR, { recursive: true });
    const list = await inboxMessages(Number(arg ?? 20));
    const index: any[] = [];
    for (const [i, m] of list.entries()) {
      const mime = await graph(`/me/messages/${m.id}/$value`);
      const file = `${String(i + 1).padStart(2, "0")}.eml`;
      await writeFile(join(OUT_DIR, file), mime);
      index.push({ file, id: m.id, from: m.from?.emailAddress, subject: m.subject, received: m.receivedDateTime, platform: platformOf(m) });
    }
    await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
    console.log(`Saved ${list.length} messages to ${OUT_DIR} (gitignored).`);
    for (const x of index) console.log(`  ${x.file}  [${x.platform}]  ${x.from?.name}: ${x.subject}`);
    break;
  }
  case "onedrive": {
    const body = JSON.stringify({ hello: "The Broadsheet", at: new Date().toISOString() });
    const put = await graph(`/me/drive/special/approot:/spike/hello.json:/content`, { method: "PUT", body });
    const back = await graph(`/me/drive/special/approot:/spike/hello.json:/content`);
    console.log(`Wrote ${put.name} (${put.size} bytes) to the App Folder; read back:`, back);
    const folder = await graph(`/me/drive/special/approot?$select=name,webUrl`);
    console.log(`App Folder: ${folder.name} — ${folder.webUrl}`);
    break;
  }
  default:
    console.log("Commands: login | whoami | inbox [n] | folders | move <id> | export [n] | onedrive");
}
