// Cache copies of an article's images (PLAN.md §7.3 and §9). The reader then loads images from your
// private OneDrive instead of the newsletter's servers, so opening an article on your phone doesn't
// tell anyone (tracking or ad servers) that you read it.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";

export const MAX_IMAGES = 25;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // OneDrive's simple-upload limit

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export type CachedImage = { url: string; file: string; path: string; bytes: number };

/** "images/<hash>.<ext>": the image's path in the App Folder; the same image in two posts is stored once. */
export const imageName = (url: string, ext: string) => `images/${createHash("sha256").update(url).digest("hex").slice(0, 20)}.${ext}`;

/**
 * Download the images in `html` into `<dir>/images/`. Returns the publishable HTML: each cached image's
 * src becomes data-src="images/…" (the reader swaps in the OneDrive copy); images that couldn't be
 * cached are removed, so a reader device never fetches anything from the newsletter's servers.
 */
export async function cacheImages(
  html: string,
  dir: string,
  doFetch: typeof fetch = fetch,
): Promise<{ html: string; images: CachedImage[]; hero: string | null }> {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const images: CachedImage[] = [];
  const byUrl = new Map<string, CachedImage | null>();
  await mkdir(join(dir, "images"), { recursive: true });

  for (const img of [...document.querySelectorAll("img")]) {
    const url = img.getAttribute("src") ?? "";
    if (!/^https?:\/\//i.test(url) || byUrl.size >= MAX_IMAGES) {
      img.remove();
      continue;
    }
    if (!byUrl.has(url)) byUrl.set(url, await download(url, dir, doFetch));
    const cached = byUrl.get(url);
    if (!cached) {
      img.remove();
      continue;
    }
    if (!images.includes(cached)) images.push(cached);
    img.removeAttribute("src");
    img.setAttribute("data-src", cached.path);
    img.setAttribute("loading", "lazy");
  }
  // Links around removed images would now be empty.
  for (const a of [...document.querySelectorAll("a")]) if (!(a.textContent ?? "").trim() && !a.querySelector("img")) a.remove();

  const hero = images.find((i) => i.bytes > 15_000)?.path ?? images[0]?.path ?? null;
  return { html: document.body.innerHTML, images, hero };
}

async function download(url: string, dir: string, doFetch: typeof fetch): Promise<CachedImage | null> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Mozilla/5.0 (Macintosh) TheBroadsheet/1.0" } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = EXT[type];
    if (!res.ok || !ext) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > MAX_IMAGE_BYTES || body.byteLength === 0) return null;
    const path = imageName(url, ext);
    const file = join(dir, path);
    await writeFile(file, body);
    return { url, file, path, bytes: body.byteLength };
  } catch {
    return null;
  }
}

export const readImage = (file: string) => readFile(file);
