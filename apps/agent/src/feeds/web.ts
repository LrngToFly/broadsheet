// The full post from its public web page, when the email and the feed only have a teaser (PLAN.md §3.4).
// Mozilla Readability (Firefox's Reader View engine) picks out the article. Public pages only: no
// sign-in, no cookies, so it can never get past a paywall.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { USER_AGENT } from "./feed.ts";

export async function fetchWebArticle(url: string, doFetch: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await doFetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const { document } = parseHTML(await res.text());
    const article = new Readability(document as unknown as Document, { charThreshold: 500 }).parse();
    return article?.content ?? null;
  } catch {
    return null;
  }
}
