// Microsoft sign-in, proven on an iPhone home-screen app in Phase 0. The reader asks only for its own
// OneDrive App Folder: it can't see your mail or the rest of your OneDrive.
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";

export const SCOPES = ["Files.ReadWrite.AppFolder", "User.Read"];
const base = new URL(import.meta.env.BASE_URL, location.origin).href;

export const msal = new PublicClientApplication({
  auth: {
    clientId: __CLIENT_ID__,
    authority: "https://login.microsoftonline.com/consumers",
    redirectUri: base + "redirect.html",
    postLogoutRedirectUri: base,
  },
  cache: { cacheLocation: "localStorage" },
});

export class NeedsSignIn extends Error {}

/** Finish a sign-in that just came back from Microsoft, and return the signed-in account (if any). */
export async function startAuth(): Promise<AccountInfo | null> {
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  if (account) msal.setActiveAccount(account);
  return account;
}

export async function token(): Promise<string> {
  const account = msal.getActiveAccount();
  if (!account) throw new NeedsSignIn("Not signed in");
  try {
    return (await msal.acquireTokenSilent({ account, scopes: SCOPES })).accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) throw new NeedsSignIn(e.errorCode);
    throw e;
  }
}

export const signIn = () => msal.loginRedirect({ scopes: SCOPES, prompt: "select_account" });
export const signOut = () => msal.logoutRedirect({ account: msal.getActiveAccount() ?? undefined });
