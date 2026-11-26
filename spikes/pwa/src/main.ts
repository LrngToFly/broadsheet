// Phase 0 spike (c): does Microsoft sign-in work inside an iOS home-screen PWA, and can the
// page read/write the OneDrive App Folder with only Files.ReadWrite.AppFolder?
import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from "@azure/msal-browser";

declare const __CLIENT_ID__: string;

const SCOPES = ["Files.ReadWrite.AppFolder", "User.Read"];
const GRAPH = "https://graph.microsoft.com/v1.0";
const base = new URL(import.meta.env.BASE_URL, location.origin).href; // e.g. https://x.github.io/broadsheet/

const $ = (id: string) => document.getElementById(id)!;
const log = (msg: string) => { $("log").textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + $("log").textContent; };

const standalone = (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;

const pca = new PublicClientApplication({
  auth: {
    clientId: __CLIENT_ID__,
    authority: "https://login.microsoftonline.com/consumers",
    redirectUri: base + "redirect.html",
    postLogoutRedirectUri: base,
  },
  cache: { cacheLocation: "localStorage" },
});

function show(account: AccountInfo | null, extra: Record<string, string> = {}) {
  const rows: Record<string, string> = {
    "Running as": standalone ? "Home-screen app (standalone) ✅" : "Browser tab",
    "Signed in": account ? account.username.replace(/^(.).*(@.*)$/, "$1•••$2") : "No",
    ...extra,
  };
  $("status").innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("actions").innerHTML = account
    ? `<button id="test">Test OneDrive</button><button id="out" class="secondary">Sign out</button>`
    : `<button id="in">Sign in with Microsoft</button>`;
  $("in")?.addEventListener("click", () => pca.loginRedirect({ scopes: SCOPES, prompt: "select_account" }));
  $("out")?.addEventListener("click", () => pca.logoutRedirect({ account: account! }));
  $("test")?.addEventListener("click", () => testOneDrive(account!));
}

async function token(account: AccountInfo): Promise<string> {
  try {
    return (await pca.acquireTokenSilent({ account, scopes: SCOPES })).accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      log("Silent token failed; redirecting to sign in again…");
      await pca.acquireTokenRedirect({ account, scopes: SCOPES });
    }
    throw e;
  }
}

async function graph(path: string, accessToken: string, init: RequestInit = {}) {
  const r = await fetch(GRAPH + path, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}

async function testOneDrive(account: AccountInfo) {
  try {
    const t0 = performance.now();
    const at = await token(account);
    log(`Got token silently in ${Math.round(performance.now() - t0)} ms`);
    const hello = await graph("/me/drive/special/approot:/spike/hello.json:/content", at);
    log(`Read spike/hello.json (written by the Mac agent): ${JSON.stringify(hello)}`);
    const name = `from-${standalone ? "homescreen" : "browser"}-${Date.now()}.json`;
    const body = JSON.stringify({ at: new Date().toISOString(), standalone, ua: navigator.userAgent });
    await graph(`/me/drive/special/approot:/spike/${name}:/content`, at, { method: "PUT", body, headers: { "Content-Type": "application/json" } });
    log(`Wrote spike/${name} ✅  (the Mac can read it back)`);
    show(account, { "OneDrive test": "Read + write OK ✅" });
  } catch (e: any) {
    log(`OneDrive test failed: ${e.errorCode ?? e.message ?? e}`);
  }
}

(async () => {
  if (!__CLIENT_ID__) { log("Build is missing the client ID."); return; }
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  if (result?.account) { pca.setActiveAccount(result.account); log("Signed in via redirect ✅"); }
  const account = pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);
  show(account);
  log(`Ready. ${standalone ? "Standalone" : "Browser"} mode. Base ${base}`);
})().catch((e) => log(`Startup error: ${e.errorCode ?? e.message ?? e}`));
