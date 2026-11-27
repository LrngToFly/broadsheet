import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { AccountInfo } from "@azure/msal-browser";
import type { Edition, ItemCard } from "@broadsheet/shared";
import { NeedsSignIn, signIn, signOut, startAuth } from "./auth.ts";
import { clearData, imageUrl, loadArticle, loadEdition, loadStatus, localMode, prefetch, type Status } from "./data.ts";
import { applyOverlay, useReaderActions, type NewAction } from "./actions.ts";

// ---- Routing: #/ (Front Page), #/s/<section>, #/i/<item> ---------------------------------------------

type Route = { page: "front" } | { page: "saved" } | { page: "section"; id: string } | { page: "item"; id: string };

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "s" && id) return { page: "section", id: decodeURIComponent(id) };
  if (kind === "i" && id) return { page: "item", id: decodeURIComponent(id) };
  if (kind === "saved") return { page: "saved" };
  return { page: "front" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

// ---- Small helpers -----------------------------------------------------------------------------------

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const byline = (i: ItemCard) => [i.source, i.author && i.author !== i.source ? i.author : null].filter(Boolean).join(" · ");

function CachedImage({ path, className, alt = "" }: { path: string; className?: string; alt?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    imageUrl(path).then((u) => live && setSrc(u), () => {});
    return () => {
      live = false;
    };
  }, [path]);
  return src ? <img src={src} className={className} alt={alt} /> : <div className={`${className ?? ""} img-placeholder`} />;
}

// ---- Cards -------------------------------------------------------------------------------------------

const RATING_ICON: Record<string, string> = { "1": "👍", "0": "👌", "-1": "👎" };

function Card({ item, lead = false, read = false }: { item: ItemCard; lead?: boolean; read?: boolean }) {
  return (
    <a className={`card${lead ? " lead" : ""}${read ? " read" : ""}`} href={`#/i/${encodeURIComponent(item.id)}`}>
      {lead && item.image && <CachedImage path={item.image} className="card-image" />}
      <div className="card-body">
        <h2>{item.title}</h2>
        <p className="meta">
          {byline(item)} · {ago(item.publishedAt)} · {item.readMinutes} min read
          {item.rating !== null && <span className="mark"> · {RATING_ICON[String(item.rating)]}</span>}
          {item.saved && <span className="mark"> · ★</span>}
        </p>
        {item.status === "summarized" ? <p className="summary">{item.summary}</p> : <p className="summary pending">{item.opening}</p>}
        {item.status === "pending" && <span className="tag pending-tag">summary pending</span>}
        {item.whyItsHere && <p className="why">{item.whyItsHere}</p>}
      </div>
      {!lead && item.image && <CachedImage path={item.image} className="thumb" />}
    </a>
  );
}

function ItemList({ items, read, empty = "Nothing here right now." }: { items: ItemCard[]; read: Set<string>; empty?: string }) {
  if (!items.length) return <p className="empty">{empty}</p>;
  return (
    <div className="list">
      {items.map((i, n) => (
        <Card key={i.id} item={i} lead={n === 0} read={read.has(i.id)} />
      ))}
    </div>
  );
}

// ---- Article -----------------------------------------------------------------------------------------

type Act = (a: NewAction) => void;

function ActionBar({ item, sections, act, read, markRead }: { item: ItemCard; sections: { id: string; name: string }[]; act: Act; read: boolean; markRead: (id: string, r: boolean) => void }) {
  const rate = (r: -1 | 0 | 1) => act({ type: "rate", itemId: item.id, rating: item.rating === r ? null : r });
  return (
    <div className="actions">
      <div className="rate" role="group" aria-label="Rate this">
        {([1, 0, -1] as const).map((r) => (
          <button key={r} className={item.rating === r ? "on" : ""} aria-pressed={item.rating === r} onClick={() => rate(r)} title={{ 1: "More like this", 0: "It was fine", "-1": "Less like this" }[r]}>
            {RATING_ICON[String(r)]}
          </button>
        ))}
      </div>
      <button className={item.saved ? "on" : ""} aria-pressed={item.saved} onClick={() => act({ type: "save", itemId: item.id, saved: !item.saved })}>
        {item.saved ? "★ Saved" : "☆ Save"}
      </button>
      <select aria-label="Move to section" value="" onChange={(e) => e.target.value && act({ type: "move", itemId: item.id, section: e.target.value })}>
        <option value="">Move to…</option>
        {sections.filter((s) => s.id !== item.section).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <button className="link" onClick={() => markRead(item.id, !read)}>{read ? "Mark unread" : "Mark read"}</button>
    </div>
  );
}

function Article({ item, sections, act, read, markRead }: { item: ItemCard; sections: { id: string; name: string }[]; act: Act; read: boolean; markRead: (id: string, r: boolean) => void }) {
  // Opening an article counts as reading it.
  useEffect(() => markRead(item.id, true), [item.id, markRead]);
  const body = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    loadArticle(item.content).then(
      (html) => {
        if (!live || !body.current) return;
        // The agent already cleaned this; sanitize again here because it came from a newsletter.
        body.current.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["data-src", "loading"], FORBID_TAGS: ["style", "form"] });
        for (const a of body.current.querySelectorAll("a")) {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        for (const img of body.current.querySelectorAll<HTMLImageElement>("img[data-src]")) {
          imageUrl(img.dataset.src!).then((u) => (img.src = u), () => img.remove());
        }
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [item.content]);

  return (
    <article className="article">
      <a className="back" href="#/" onClick={(e) => (history.length > 1 ? (e.preventDefault(), history.back()) : undefined)}>
        ‹ Back
      </a>
      <h1>{item.title}</h1>
      <p className="meta">
        {byline(item)} · {new Date(item.publishedAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {item.readMinutes} min read
        {" · "}
        <a href={`#/s/${item.section}`}>{sections.find((s) => s.id === item.section)?.name ?? item.section}</a>
      </p>
      <ActionBar item={item} sections={sections} act={act} read={read} markRead={markRead} />
      {item.status === "summarized" && (
        <aside className="brief">
          <p>{item.summary}</p>
          {item.keyPoints.length > 0 && (
            <ul>
              {item.keyPoints.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          )}
          {item.whyItsHere && <p className="why">{item.whyItsHere}</p>}
        </aside>
      )}
      {error ? <p className="error">Couldn't load this article ({error}). It may not be available offline yet.</p> : <div className="article-body" ref={body} />}
      <ActionBar item={item} sections={sections} act={act} read={read} markRead={markRead} />
      {item.url && (
        <p className="original">
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            Open the original ↗
          </a>
        </p>
      )}
    </article>
  );
}

// ---- The app -----------------------------------------------------------------------------------------

type State =
  | { kind: "starting" }
  | { kind: "signed-out"; error?: string }
  | { kind: "loading"; account: AccountInfo }
  | { kind: "ready"; account: AccountInfo; edition: Edition; status: Status | null; offline: boolean }
  | { kind: "error"; account: AccountInfo; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "starting" });
  const [refreshing, setRefreshing] = useState(false);
  const route = useRoute();

  const load = useCallback(async (account: AccountInfo) => {
    setRefreshing(true);
    try {
      const [{ edition, offline }, status] = await Promise.all([loadEdition(), loadStatus()]);
      setState({ kind: "ready", account, edition, status, offline });
      prefetch(edition).catch(() => {});
    } catch (e) {
      if (e instanceof NeedsSignIn) setState({ kind: "signed-out", error: "Please sign in again." });
      else setState({ kind: "error", account, message: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (localMode) {
      const account = { username: "local", homeAccountId: "local", environment: "", tenantId: "", localAccountId: "" } as AccountInfo;
      setState({ kind: "loading", account });
      load(account);
      return;
    }
    startAuth().then(
      (account) => (account ? (setState({ kind: "loading", account }), load(account)) : setState({ kind: "signed-out" })),
      (e: Error) => setState({ kind: "signed-out", error: e.message }),
    );
  }, [load]);

  // Fetch the newest edition when you come back to the app.
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && state.kind === "ready" && load(state.account);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [state, load]);

  const rawEdition = state.kind === "ready" ? state.edition : null;
  const { overlay, act, waiting, read, markRead } = useReaderActions(rawEdition);
  // The edition with your own not-yet-synced changes on top.
  const edition = useMemo(
    () => (rawEdition ? { ...rawEdition, items: rawEdition.items.map((i) => applyOverlay(i, overlay.get(i.id))) } : null),
    [rawEdition, overlay],
  );

  const sectionsWithItems = useMemo(() => {
    if (!edition) return [];
    return edition.sections.filter((s) => edition.items.some((i) => i.section === s.id));
  }, [edition]);

  if (state.kind === "starting") return <div className="splash">The Broadsheet</div>;

  if (state.kind === "signed-out") {
    return (
      <main className="signin">
        <h1 className="masthead-title">The Broadsheet</h1>
        <p>Your private newspaper, made from your newsletters.</p>
        {state.error && <p className="error">{state.error}</p>}
        <button onClick={() => signIn()}>Sign in with Microsoft</button>
        <p className="fine">Sign in with your newsletter account. The Broadsheet can read only its own folder in your OneDrive.</p>
      </main>
    );
  }

  const item = route.page === "item" && edition ? edition.items.find((i) => i.id === route.id) : undefined;
  const active = route.page === "section" ? route.id : route.page === "front" || route.page === "saved" ? route.page : null;
  const saved = edition ? edition.items.filter((i) => i.saved) : [];

  return (
    <>
      <header className="masthead">
        <div className="masthead-row">
          <a href="#/" className="masthead-title">The Broadsheet</a>
          <button className="icon" aria-label="Refresh" disabled={refreshing} onClick={() => load(state.account)}>
            {refreshing ? "…" : "↻"}
          </button>
        </div>
        <p className="dateline">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
        {edition && (
          <nav className="sections">
            <a href="#/" className={active === "front" ? "on" : ""}>Front Page</a>
            {sectionsWithItems.map((s) => (
              <a key={s.id} href={`#/s/${s.id}`} className={active === s.id ? "on" : ""}>
                {s.name}
              </a>
            ))}
            {saved.length > 0 && <a href="#/saved" className={active === "saved" ? "on" : ""}>★ Saved</a>}
          </nav>
        )}
      </header>

      <main>
        {state.kind === "loading" && <p className="empty">Fetching today's edition…</p>}
        {state.kind === "error" && <p className="error">Couldn't load the edition: {state.message}</p>}
        {edition && route.page === "front" && <ItemList items={edition.items.slice(0, 20)} read={read} />}
        {edition && route.page === "section" && <ItemList items={edition.items.filter((i) => i.section === route.id)} read={read} />}
        {edition && route.page === "saved" && <ItemList items={saved} read={read} empty="Nothing saved. Saved articles are kept after the others expire." />}
        {edition && route.page === "item" &&
          (item ? <Article item={item} sections={edition.sections} act={act} read={read.has(item.id)} markRead={markRead} /> : <p className="empty">That article has expired. <a href="#/">Back to the Front Page</a></p>)}
      </main>

      {state.kind === "ready" && (
        <footer>
          <p>
            Edition updated {ago(state.edition.generatedAt)}
            {state.offline && " · offline copy"}
            {state.status && state.status.pending > 0 && ` · ${state.status.pending} waiting for a summary`}
            {waiting > 0 && ` · ${waiting} change${waiting === 1 ? "" : "s"} waiting to sync`}
          </p>
          <p>
            <button
              className="link"
              onClick={async () => {
                await clearData();
                signOut();
              }}
            >
              Sign out
            </button>
          </p>
        </footer>
      )}
    </>
  );
}
