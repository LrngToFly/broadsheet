// Reading the edition from the OneDrive App Folder, with an on-device cache so the last edition (and
// every article you've opened) works offline.
import { Edition, RulesFile } from "@broadsheet/shared";
import { NeedsSignIn, token } from "./auth.ts";

const GRAPH = "https://graph.microsoft.com/v1.0/me/drive/special/approot:/";
const CACHE = "broadsheet-data-v1";
const cacheKey = (path: string) => new URL(`${import.meta.env.BASE_URL}__data/${path}`, location.origin).href;

export type Status = { generatedAt: string; pending: number; deferred: string | null; model: string; errors: string[] };

/** Development only (`pnpm dev`, then open with ?local): read a local copy instead of OneDrive. */
export const localMode = import.meta.env.DEV && new URLSearchParams(location.search).has("local");

async function download(path: string): Promise<Response> {
  if (localMode) {
    const res = await fetch(`${import.meta.env.BASE_URL}__local/${path}`);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res;
  }
  const res = await fetch(`${GRAPH}${path.split("/").map(encodeURIComponent).join("/")}:/content`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res;
}

/** Network first (so you see the newest), falling back to the last copy when offline. */
async function fresh(path: string): Promise<{ res: Response; fromCache: boolean }> {
  const cache = await caches.open(CACHE);
  try {
    const res = await download(path);
    await cache.put(cacheKey(path), res.clone());
    return { res, fromCache: false };
  } catch (e) {
    if (e instanceof NeedsSignIn) throw e; // signed out: don't quietly show an old copy
    const old = await cache.match(cacheKey(path));
    if (old) return { res: old, fromCache: true };
    throw e;
  }
}

/** Cache first: articles and images never change once published. */
async function stable(path: string): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(cacheKey(path));
  if (hit) return hit;
  const res = await download(path);
  // A full cache (a phone's storage is limited) mustn't stop it being shown; it just isn't kept for offline.
  await cache.put(cacheKey(path), res.clone()).catch(() => {});
  return res;
}

/** Write a small JSON file to the App Folder (the reader's only way to talk to the agent). */
export async function putJson(path: string, value: unknown): Promise<void> {
  if (localMode) {
    console.info("local mode: not sending", path, value);
    return;
  }
  const res = await fetch(`${GRAPH}${path.split("/").map(encodeURIComponent).join("/")}:/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}

export async function loadEdition(): Promise<{ edition: Edition; offline: boolean }> {
  const { res, fromCache } = await fresh("edition.json");
  return { edition: Edition.parse(await res.json()), offline: fromCache };
}

/** The Rules page (P4). Null until the agent has published one. */
export async function loadRules(): Promise<RulesFile | null> {
  try {
    return RulesFile.parse(await (await fresh("rules.json")).res.json());
  } catch (e) {
    if (e instanceof NeedsSignIn) throw e;
    return null;
  }
}

export async function loadStatus(): Promise<Status | null> {
  try {
    return (await (await fresh("status.json")).res.json()) as Status;
  } catch {
    return null;
  }
}

export async function loadArticle(path: string): Promise<string> {
  return (await stable(path)).text();
}

const imageUrls = new Map<string, Promise<string>>();
/** A local (blob:) address for a cached image, so the page never contacts the image's original server. */
export function imageUrl(path: string): Promise<string> {
  let p = imageUrls.get(path);
  if (!p) {
    p = stable(path).then(async (r) => URL.createObjectURL(await r.blob()));
    p.catch(() => imageUrls.delete(path));
    imageUrls.set(path, p);
  }
  return p;
}

/** Fetch and keep every article and hero image of an edition, so it can all be read offline. */
export async function prefetch(edition: Edition): Promise<void> {
  const newsletters = new Set<string>();
  for (const item of edition.items) {
    await stable(item.content).catch(() => {});
    if (item.newsletter && !newsletters.has(item.newsletter.content)) {
      newsletters.add(item.newsletter.content);
      await stable(item.newsletter.content).catch(() => {});
    }
    if (item.image) await imageUrl(item.image).catch(() => {});
  }
}

export async function clearData() {
  await caches.delete(CACHE);
}
