// Microsoft sign-in for the newsletter account (PLAN.md §12). The agent uses the device-code flow:
// you approve it once on any device, and MSAL then renews tokens silently with the refresh token.
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-node";
import { encryptedCachePlugin, clearTokenCache, type KeyStore, keychainKeyStore } from "./token-cache.ts";

/** Delegated permissions the agent asks for. The reader asks only for Files.ReadWrite.AppFolder. */
export const AGENT_SCOPES = ["Mail.ReadWrite", "Files.ReadWrite.AppFolder", "User.Read", "offline_access"];
const AUTHORITY = "https://login.microsoftonline.com/consumers"; // personal Microsoft accounts

export class NotSignedInError extends Error {
  constructor(reason: string) {
    super(`${reason} Run: broadsheet login`);
  }
}

export class Auth {
  private readonly pca: PublicClientApplication;
  private readonly cacheFile: string;
  private readonly keys: KeyStore;

  constructor(opts: { clientId: string; cacheFile: string; keys?: KeyStore }) {
    this.cacheFile = opts.cacheFile;
    this.keys = opts.keys ?? keychainKeyStore;
    this.pca = new PublicClientApplication({
      auth: { clientId: opts.clientId, authority: AUTHORITY },
      cache: { cachePlugin: encryptedCachePlugin(opts.cacheFile, this.keys) },
    });
  }

  async account(): Promise<AccountInfo | null> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    return accounts[0] ?? null;
  }

  /** An access token for Microsoft Graph, renewed silently when needed. */
  async token(forceRefresh = false): Promise<string> {
    const account = await this.account();
    if (!account) throw new NotSignedInError("Not signed in.");
    try {
      const r = await this.pca.acquireTokenSilent({ account, scopes: AGENT_SCOPES, forceRefresh });
      return r.accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) {
        throw new NotSignedInError(`Microsoft needs you to sign in again (${e.errorCode}).`);
      }
      throw e;
    }
  }

  /** Interactive device-code sign-in. `show` receives Microsoft's message with the web address and code. */
  async login(show: (message: string) => void): Promise<AccountInfo> {
    const r = await this.pca.acquireTokenByDeviceCode({
      scopes: AGENT_SCOPES,
      deviceCodeCallback: (resp) => show(resp.message),
    });
    if (!r?.account) throw new Error("Sign-in finished without an account.");
    return r.account;
  }

  /** Bring in a token cache written by the Phase 0 spike, so you don't have to sign in again. */
  async importPlainCache(json: string): Promise<AccountInfo | null> {
    const cache = this.pca.getTokenCache();
    cache.deserialize(json);
    const account = await this.account();
    if (account) await this.pca.acquireTokenSilent({ account, scopes: AGENT_SCOPES, forceRefresh: true }); // proves it works, and saves
    return account;
  }

  async logout(): Promise<void> {
    await clearTokenCache(this.cacheFile, this.keys);
  }
}
