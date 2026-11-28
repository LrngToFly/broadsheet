// Cache copies of an article's images (PLAN.md §7.3 and §9). The reader then loads images from your
// private OneDrive instead of the newsletter's servers, so opening an article on your phone doesn't
// tell anyone (tracking or ad servers) that you read it.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";

/** Images kept per article (weather and chart newsletters can carry 50). Failed downloads don't count. */
export const MAX_IMAGES = 60;
/** Per image: animated weather maps run to 6–7 MB. Over 4 MB they go up to OneDrive in pieces (onedrive.ts). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Per article, so one huge email can't fill the OneDrive folder or a phone's data plan. */
export const MAX_ARTICLE_IMAGE_BYTES = 150 * 1024 * 1024;
/** Downloads tried per article, counting failures, so a page of broken links can't take all day. */
const MAX_ATTEMPTS = 100;

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
  let total = 0;
  await mkdir(join(dir, "images"), { recursive: true });

  for (const img of [...document.querySelectorAll("img")]) {
    const url = img.getAttribute("src") ?? "";
    const full = images.length >= MAX_IMAGES || byUrl.size >= MAX_ATTEMPTS || total >= MAX_ARTICLE_IMAGE_BYTES;
    if (!/^https?:\/\//i.test(url) || (full && !byUrl.has(url))) {
      img.remove();
      continue;
    }
    if (!byUrl.has(url)) {
      const got = await download(url, dir, doFetch, Math.min(MAX_IMAGE_BYTES, MAX_ARTICLE_IMAGE_BYTES - total));
      if (got) total += got.bytes;
      byUrl.set(url, got);
    }
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

async function download(url: string, dir: string, doFetch: typeof fetch, maxBytes: number): Promise<CachedImage | null> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "Mozilla/5.0 (Macintosh) TheBroadsheet/1.0" } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = EXT[type];
    if (!res.ok || !ext) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > maxBytes || body.byteLength === 0) return null;
    const path = imageName(url, ext);
    const file = join(dir, path);
    await writeFile(file, body);
    return { url, file, path, bytes: body.byteLength };
  } catch {
    return null;
  }
}

export const readImage = (file: string) => readFile(file);
