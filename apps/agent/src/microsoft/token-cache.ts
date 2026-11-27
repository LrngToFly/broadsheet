// MSAL's token cache (it holds the long-lived refresh token) stored as an encrypted file.
// The 256-bit key lives in the macOS Keychain, the same pattern Chrome uses on macOS. The cache is
// too large to keep in a Keychain item written through the `security` tool, but the key is small.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import { readSecret, writeSecret, deleteSecret, type KeychainItem } from "../keychain.ts";

export const CACHE_KEY_ITEM: KeychainItem = {
  service: "The Broadsheet",
  account: "token-cache-key",
  label: "The Broadsheet sign-in key",
};

const MAGIC = Buffer.from("BSTC1"); // format marker + version

export function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer, key: Buffer): string {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Broadsheet token cache file");
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(MAGIC.length + 28)), decipher.final()]).toString("utf8");
}

export type KeyStore = {
  get(): Promise<Buffer | null>;
  create(): Promise<Buffer>;
  remove(): Promise<void>;
};

export const keychainKeyStore: KeyStore = {
  async get() {
    const text = await readSecret(CACHE_KEY_ITEM);
    return text ? Buffer.from(text, "base64url") : null;
  },
  async create() {
    const key = randomBytes(32);
    await writeSecret(CACHE_KEY_ITEM, key.toString("base64url"));
    return key;
  },
  async remove() {
    await deleteSecret(CACHE_KEY_ITEM);
  },
};

export function encryptedCachePlugin(file: string, keys: KeyStore = keychainKeyStore): ICachePlugin {
  let key: Buffer | null = null;
  const getKey = async (create: boolean) => (key ??= (await keys.get()) ?? (create ? await keys.create() : null));

  return {
    async beforeCacheAccess(ctx: TokenCacheContext) {
      let data: Buffer;
      try {
        data = await readFile(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      const k = await getKey(false);
      if (!k) throw new Error("The sign-in key is missing from the Keychain. Run: broadsheet login");
      ctx.tokenCache.deserialize(decrypt(data, k));
    },
    async afterCacheAccess(ctx: TokenCacheContext) {
      if (!ctx.cacheHasChanged) return;
      const k = await getKey(true);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, encrypt(ctx.tokenCache.serialize(), k!), { mode: 0o600 });
      await rename(tmp, file); // atomic replace, so a crash never leaves half a file
    },
  };
}

/** Forget the sign-in completely: the encrypted file and its key. */
export async function clearTokenCache(file: string, keys: KeyStore = keychainKeyStore) {
  await rm(file, { force: true });
  await keys.remove();
}
