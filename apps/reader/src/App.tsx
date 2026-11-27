import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { AccountInfo } from "@azure/msal-browser";
import type { Edition, ItemCard } from "@broadsheet/shared";
import { NeedsSignIn, signIn, signOut, startAuth } from "./auth.ts";
import { clearData, imageUrl, loadArticle, loadEdition, loadStatus, localMode, prefetch, type Status } from "./data.ts";

// ---- Routing: #/ (Front Page), #/s/<section>, #/i/<item> ---------------------------------------------

type Route = { page: "front" } | { page: "section"; id: string } | { page: "item"; id: string };

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "s" && id) return { page: "section", id: decodeURIComponent(id) };
  if (kind === "i" && id) return { page: "item", id: decodeURIComponent(id) };
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

function Card({ item, lead = false }: { item: ItemCard; lead?: boolean }) {
  return (
    <a className={`card${lead ? " lead" : ""}`} href={`#/i/${encodeURIComponent(item.id)}`}>
      {lead && item.image && <CachedImage path={item.image} className="card-image" />}
      <div className="card-body">
        <h2>{item.title}</h2>
        <p className="meta">
          {byline(item)} · {ago(item.publishedAt)} · {item.readMinutes} min read
        </p>
        {item.status === "summarized" ? <p className="summary">{item.summary}</p> : <p className="summary pending">{item.opening}</p>}
        {item.status === "pending" && <span className="tag pending-tag">summary pending</span>}
        {item.whyItsHere && <p className="why">{item.whyItsHere}</p>}
      </div>
      {!lead && item.image && <CachedImage path={item.image} className="thumb" />}
    </a>
  );
}

function ItemList({ items }: { items: ItemCard[] }) {
  if (!items.length) return <p className="empty">Nothing here right now.</p>;
  return (
    <div className="list">
      {items.map((i, n) => (
        <Card key={i.id} item={i} lead={n === 0} />
      ))}
    </div>
  );
}

// ---- Article -----------------------------------------------------------------------------------------

function Article({ item }: { item: ItemCard }) {
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
      </p>
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

  const sectionsWithItems = useMemo(() => {
    if (state.kind !== "ready") return [];
    return state.edition.sections.filter((s) => state.edition.items.some((i) => i.section === s.id));
  }, [state]);

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

  const edition = state.kind === "ready" ? state.edition : null;
  const item = route.page === "item" && edition ? edition.items.find((i) => i.id === route.id) : undefined;
  const active = route.page === "section" ? route.id : route.page === "front" ? "front" : null;

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
          </nav>
        )}
      </header>

      <main>
        {state.kind === "loading" && <p className="empty">Fetching today's edition…</p>}
        {state.kind === "error" && <p className="error">Couldn't load the edition: {state.message}</p>}
        {edition && route.page === "front" && <ItemList items={edition.items.slice(0, 20)} />}
        {edition && route.page === "section" && <ItemList items={edition.items.filter((i) => i.section === route.id)} />}
        {edition && route.page === "item" && (item ? <Article item={item} /> : <p className="empty">That article has expired. <a href="#/">Back to the Front Page</a></p>)}
      </main>

      {state.kind === "ready" && (
        <footer>
          <p>
            Edition updated {ago(state.edition.generatedAt)}
            {state.offline && " · offline copy"}
            {state.status && state.status.pending > 0 && ` · ${state.status.pending} waiting for a summary`}
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
