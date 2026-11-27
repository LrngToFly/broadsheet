import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { AccountInfo } from "@azure/msal-browser";
import { NEWS_IN_BRIEF_SECTION_ID, type Edition, type HiddenCard, type HideReason, type ItemCard, type RulesFile, type Suggestion } from "@broadsheet/shared";
import { NeedsSignIn, signIn, signOut, startAuth } from "./auth.ts";
import { clearData, imageUrl, loadArticle, loadEdition, loadRules, loadStatus, localMode, prefetch, type Status } from "./data.ts";
import { applyOverlay, useReaderActions, type NewAction, type Overlay, type SettingsOverlay } from "./actions.ts";

// ---- Routing: #/ (Front Page), #/s/<section>, #/i/<item>, #/n/<item>, #/saved, #/hidden, #/rules -------

type Route =
  | { page: "front" } | { page: "saved" } | { page: "hidden" } | { page: "rules" } | { page: "section"; id: string } | { page: "item"; id: string }
  | { page: "newsletter"; id: string } // the whole newsletter a brief or piece came from, opened from that piece
  | { page: "read" } // what you've read, left out of the lists after a refresh
  | { page: "briefs"; id: string }; // all of a section's briefs

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "s" && id) return { page: "section", id: decodeURIComponent(id) };
  if (kind === "i" && id) return { page: "item", id: decodeURIComponent(id) };
  if (kind === "n" && id) return { page: "newsletter", id: decodeURIComponent(id) };
  if (kind === "saved") return { page: "saved" };
  if (kind === "read") return { page: "read" };
  if (kind === "b" && id) return { page: "briefs", id: decodeURIComponent(id) };
  if (kind === "hidden") return { page: "hidden" };
  if (kind === "rules") return { page: "rules" };
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
          {item.alsoIn.length > 0 && ` · also in ${item.alsoIn.join(", ")}`}
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

const isBrief = (i: ItemCard) => i.kind === "brief";
const alsoIn = (i: ItemCard) => (i.alsoIn.length ? `also in ${i.alsoIn.join(", ")}` : null);

/** Short stories from roundup newsletters (PLAN.md §4.4): a headline and a sentence or two each. */
function BriefList({ title, items, read, more }: { title: string; items: ItemCard[]; read: Set<string>; more?: { href: string; label: string } }) {
  if (!items.length) return null;
  return (
    <section className="in-brief" aria-label={title}>
      <h2 className="in-brief-title">{title}</h2>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={read.has(i.id) ? "read" : ""}>
            <a href={`#/i/${encodeURIComponent(i.id)}`}>
              <h3>{i.title}</h3>
              <p className="summary">{i.status === "summarized" ? i.summary : i.opening}</p>
              <p className="meta">
                {[i.source, ago(i.publishedAt), alsoIn(i)].filter(Boolean).join(" · ")}
                {i.rating !== null && <span className="mark"> · {RATING_ICON[String(i.rating)]}</span>}
                {i.saved && <span className="mark"> · ★</span>}
              </p>
            </a>
          </li>
        ))}
      </ul>
      {more && <a className="in-brief-more" href={more.href}>{more.label}</a>}
    </section>
  );
}

/** At most this many briefs in News in Brief and in each section's In brief list; a link shows the rest. */
const BRIEFS_SHOWN = 4;

/** The lead story, then News in Brief (Current Events briefs), then the rest of the top stories. */
function FrontPage({ items, read }: { items: ItemCard[]; read: Set<string> }) {
  const articles = items.filter((i) => !isBrief(i)).slice(0, 20);
  const briefs = items.filter((i) => isBrief(i) && i.section === NEWS_IN_BRIEF_SECTION_ID);
  const news = (
    <BriefList
      title="News in Brief"
      items={briefs.slice(0, BRIEFS_SHOWN)}
      read={read}
      more={briefs.length > BRIEFS_SHOWN ? { href: `#/b/${NEWS_IN_BRIEF_SECTION_ID}`, label: `All ${briefs.length} briefs →` } : undefined}
    />
  );
  if (!articles.length) return briefs.length ? news : <ItemList items={[]} read={read} />;
  return (
    <>
      <ItemList items={articles.slice(0, 1)} read={read} />
      {news}
      {articles.length > 1 && <div className="list">{articles.slice(1).map((i) => <Card key={i.id} item={i} read={read.has(i.id)} />)}</div>}
    </>
  );
}

/** A section's page: its briefs first (In brief), then its articles. */
function SectionPage({ id, items, read }: { id: string; items: ItemCard[]; read: Set<string> }) {
  const briefs = items.filter(isBrief);
  const articles = items.filter((i) => !isBrief(i));
  return (
    <>
      <BriefList
        title="In brief"
        items={briefs.slice(0, BRIEFS_SHOWN)}
        read={read}
        more={briefs.length > BRIEFS_SHOWN ? { href: `#/b/${encodeURIComponent(id)}`, label: `All ${briefs.length} briefs →` } : undefined}
      />
      {(articles.length > 0 || briefs.length === 0) && <ItemList items={articles} read={read} />}
    </>
  );
}

// ---- Article -----------------------------------------------------------------------------------------

type Act = (a: NewAction) => void;

type ArticleProps = { item: ItemCard; sections: { id: string; name: string }[]; act: Act; read: boolean; markRead: (id: string, r: boolean) => void; onHide: (item: ItemCard) => void };

function ActionBar({ item, sections, act, read, markRead, onHide }: ArticleProps) {
  const [why, setWhy] = useState<string | null>(null); // the "why?" box, when open
  const rate = (r: -1 | 0 | 1) => {
    act({ type: "rate", itemId: item.id, rating: item.rating === r ? null : r });
    setWhy(null);
  };
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
      <button className="link hide-link" onClick={() => onHide(item)}>🚫 Don't show things like this</button>
      {item.rating !== null &&
        (why === null ? (
          <button className="link why-link" onClick={() => setWhy("")}>Say why you rated it {RATING_ICON[String(item.rating)]} (optional)</button>
        ) : (
          <form
            className="why-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (why.trim()) act({ type: "rate", itemId: item.id, rating: item.rating, note: why.trim() });
              setWhy(null);
            }}
          >
            <input autoFocus maxLength={1000} placeholder="e.g. A distraction story, not about the people in it" value={why} onChange={(e) => setWhy(e.target.value)} />
            <button type="submit">Save</button>
            <button type="button" className="link" onClick={() => setWhy(null)}>Cancel</button>
          </form>
        ))}
    </div>
  );
}

/** An article's HTML from the App Folder, sanitized, with its images from the cache. */
function ArticleBody({ content }: { content: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    loadArticle(content).then(
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
  }, [content]);

  return error ? <p className="error">Couldn't load this article ({error}). It may not be available offline yet.</p> : <div className="article-body" ref={body} />;
}

function Article(props: ArticleProps) {
  const { item, markRead } = props;
  // Opening an article counts as reading it.
  useEffect(() => markRead(item.id, true), [item.id, markRead]);

  return (
    <article className="article">
      <BackBar title={item.title} />
      <h1>{item.title}</h1>
      <p className="meta">
        {byline(item)} · {new Date(item.publishedAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {item.readMinutes} min read
        {" · "}
        <a href={`#/s/${item.section}`}>{props.sections.find((s) => s.id === item.section)?.name ?? item.section}</a>
        {alsoIn(item) && ` · ${alsoIn(item)}`}
      </p>
      <ActionBar {...props} />
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
      <ArticleBody content={item.content} />
      <ActionBar {...props} />
      {item.newsletter && (
        <p className="original">
          <a href={`#/n/${encodeURIComponent(item.id)}`}>Read the whole newsletter: {item.newsletter.title} →</a>
        </p>
      )}
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

/** The whole newsletter a brief or piece came from. */
function Newsletter({ item }: { item: ItemCard }) {
  if (!item.newsletter) return <p className="empty">This article isn't part of a larger newsletter.</p>;
  return (
    <article className="article">
      <BackBar title={item.newsletter.title} />
      <h1>{item.newsletter.title}</h1>
      <p className="meta">{byline(item)} · {new Date(item.publishedAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · the whole newsletter</p>
      <ArticleBody content={item.newsletter.content} />
    </article>
  );
}

/**
 * Back to where you came from (keeps your place in the list), or to the front page. It stays pinned to the top of
 * the screen while you scroll through an article, so it's always one tap away.
 */
function BackBar({ title }: { title: string }) {
  return (
    <div className="backbar">
      <a className="back" href="#/" onClick={(e) => (history.length > 1 ? (e.preventDefault(), history.back()) : undefined)}>
        ‹ Back
      </a>
      <span className="backbar-title" aria-hidden="true">{title}</span>
    </div>
  );
}

// ---- Hiding (PLAN.md §4.3) ---------------------------------------------------------------------------

const REASONS: [HideReason, string][] = [
  ["not-article", "Not an article"],
  ["ad", "Ad or promo"],
  ["topic", "Not my topic"],
  ["author", "Not this author"],
];
const reasonLabel = (r: HideReason | null) => REASONS.find(([k]) => k === r)?.[1];

/** After you hide something: optional reasons and a note, or Undo. The item is already gone. */
function HideSheet({ item, act, close }: { item: { id: string; title: string }; act: Act; close: () => void }) {
  const [reason, setReason] = useState<HideReason | null>(null);
  const [note, setNote] = useState("");
  const done = () => {
    if (reason || note.trim()) act({ type: "hide", itemId: item.id, reason, note: note.trim() || null });
    close();
  };
  return (
    <div className="sheet-backdrop" onClick={done}>
      <div className="sheet" role="dialog" aria-label="Why hide this?" onClick={(e) => e.stopPropagation()}>
        <p className="sheet-title">Hidden: <strong>{item.title}</strong></p>
        <p className="fine">Why? (optional, it helps the Broadsheet learn)</p>
        <div className="chips">
          {REASONS.map(([k, label]) => (
            <button key={k} className={reason === k ? "on" : ""} aria-pressed={reason === k} onClick={() => setReason(reason === k ? null : k)}>
              {label}
            </button>
          ))}
        </div>
        <textarea placeholder="Anything else? e.g. These live-video posts are never worth it" maxLength={1000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="sheet-buttons">
          <button className="link" onClick={() => (act({ type: "unhide", itemId: item.id }), close())}>Undo</button>
          <button className="primary" onClick={done}>Done</button>
        </div>
      </div>
    </div>
  );
}

function whyText(h: HiddenCard): string {
  if (h.why.kind === "rule") return `Rule: ${h.why.wording}`;
  if (h.why.kind === "not-article") return "Gemma thought this wasn't an article";
  const r = reasonLabel(h.why.reason);
  return r ? `You hid this: ${r}` : "You hid this";
}

function HiddenList({ hidden, act }: { hidden: (HiddenCard & { comingBack: boolean })[]; act: Act }) {
  if (!hidden.length) return <p className="empty">Nothing hidden in the last few days.</p>;
  return (
    <div className="list">
      <p className="fine hidden-intro">Left out of the paper in the last few days, and why. <strong>Show it again</strong> puts it back, and its email returns to its folder.</p>
      {hidden.map((h) => (
        <div key={h.id} className="hidden-row">
          <h2>{h.url ? <a href={h.url} target="_blank" rel="noopener noreferrer">{h.title}</a> : h.title}</h2>
          <p className="meta">{[h.source, h.author && h.author !== h.source ? h.author : null].filter(Boolean).join(" · ")} · {ago(h.publishedAt)}</p>
          <p className="why">{whyText(h)}{h.why.kind === "you" && h.why.note ? ` — "${h.why.note}"` : ""}</p>
          {h.comingBack ? (
            <p className="fine">Coming back with the next update (within about 15 minutes).</p>
          ) : (
            <button className="show-again" onClick={() => act({ type: "unhide", itemId: h.id })}>Show it again</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The Hidden list as you see it: the edition's, with your own unsent hides and un-hides on top. */
function hiddenWithOverlay(edition: Edition, overlay: Map<string, Overlay>): (HiddenCard & { comingBack: boolean })[] {
  const mine = edition.items
    .filter((i) => overlay.get(i.id)?.hidden === true)
    .map((i) => {
      const o = overlay.get(i.id)!;
      return { id: i.id, title: i.title, source: i.source, author: i.author, publishedAt: i.publishedAt, url: i.url, why: { kind: "you" as const, reason: o.reason ?? null, note: o.note ?? null }, comingBack: false };
    });
  const theirs = (edition.hidden ?? []).map((h) => {
    const o = overlay.get(h.id);
    const why = o?.hidden === true ? { kind: "you" as const, reason: o.reason ?? null, note: o.note ?? null } : h.why;
    return { ...h, why, comingBack: o?.hidden === false };
  });
  return [...mine, ...theirs];
}

// ---- The Rules page (P4) -----------------------------------------------------------------------------

const KIND_LABEL = { check: "Exact match (free, instant)", instruction: "Gemma checks for", include: "Include" } as const;

function OwnWords({ rules, pending, act }: { rules: RulesFile; pending: string | undefined; act: Act }) {
  const saved = pending ?? rules.ownWords.text;
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  return (
    <section className="rules-block">
      <h2>In your own words</h2>
      <p className="fine">
        What you want from the Broadsheet and what you don't, and why. Gemma reads this with every article, and it comes before anything it learns from your ratings.
      </p>
      <textarea
        rows={5}
        maxLength={4000}
        placeholder="e.g. Rank lower the stories about gossip and spectacle, like celebrity feuds or horse-race polling, unless they cover real policy or money."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button className="primary" disabled={text.trim() === saved.trim()} onClick={() => act({ type: "own-words", text: text.trim() })}>
          Save
        </button>
        {pending !== undefined && <span className="fine">Saved. Gemma re-scores today's articles the next time the Mac is free.</span>}
      </div>
      {rules.learnedProfile && (
        <details className="learned">
          <summary>What Gemma has learned from your ratings</summary>
          <p>{rules.learnedProfile.text}</p>
          <p className="fine">Rewritten {ago(rules.learnedProfile.builtAt)}. Your own words above win where the two disagree.</p>
        </details>
      )}
    </section>
  );
}

function fromText(s: Suggestion): string {
  if (s.from.kind === "typed") return `You typed: "${s.from.text}"`;
  const reason = reasonLabel((s.from.reason as HideReason | null) ?? null);
  return `From an item you hid: "${s.from.title}"${reason ? ` (${reason})` : ""}${s.from.note ? `, "${s.from.note}"` : ""}`;
}

function SuggestionCard({ s, act, op, edit }: { s: Suggestion; act: Act; op: string | undefined; edit: string | undefined }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (op === "approve") return <div className="rule-card done">✓ Approved: {s.wording}. It takes effect on the next update.</div>;
  if (op === "dismiss") return null;
  const drafting = s.status === "drafting" || edit !== undefined;
  return (
    <div className="rule-card">
      <p className="from fine">{fromText(s)}</p>
      {s.status === "failed" ? (
        <p>Gemma couldn't draft a rule from this{s.error ? `: ${s.error}` : "."}</p>
      ) : drafting ? (
        <p className="fine">Gemma is drafting a rule{edit ? ` from your new wording "${edit}"` : ""}. It's done the next time the Mac is free.</p>
      ) : (
        <>
          <p className="wording">{s.wording}</p>
          <p className="fine">
            {KIND_LABEL[s.ruleKind ?? "instruction"]}: {s.detail} · {s.source ? `only ${s.source}` : "all newsletters"}
          </p>
          <p className="fine">
            {s.wouldHide.length ? `Would hide ${s.wouldHide.length} of the current articles:` : "Wouldn't hide any of the current articles."}
          </p>
          {s.wouldHide.length > 0 && (
            <ul className="would-hide">
              {s.wouldHide.map((i) => (
                <li key={i.id}>
                  {i.title} <span className="fine">({i.source})</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {editing !== null ? (
        <form
          className="why-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing.trim()) act({ type: "rule-edit", ruleId: s.id, text: editing.trim() });
            setEditing(null);
          }}
        >
          <input autoFocus maxLength={500} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <button type="submit">Redraft</button>
          <button type="button" className="link" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : (
        <div className="row">
          {s.status === "ready" && !drafting && <button className="primary" onClick={() => act({ type: "rule", ruleId: s.id, op: "approve" })}>Approve</button>}
          {s.status === "ready" && !drafting && <button onClick={() => setEditing(s.wording ?? "")}>Edit</button>}
          <button className="link" onClick={() => act({ type: "rule", ruleId: s.id, op: "dismiss" })}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function RuleRow({ r, act, op, edit }: { r: RulesFile["rules"][number]; act: Act; op: string | undefined; edit: string | undefined }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (op === "delete") return null;
  const on = op === "on" ? true : op === "off" ? false : r.status === "active";
  return (
    <div className={`rule-card${on ? "" : " off"}`}>
      <p className="wording">{edit ?? r.wording}</p>
      <p className="fine">
        {r.redrafting || edit ? "Gemma is redrafting it from your new wording." : `${KIND_LABEL[r.kind]}: ${r.detail}`} · {r.source ? `only ${r.source}` : "all newsletters"}
        {r.kind !== "include" && ` · hid ${r.hits30d} in the last 30 days`}
      </p>
      {editing !== null ? (
        <form
          className="why-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing.trim() && editing.trim() !== r.wording) act({ type: "rule-edit", ruleId: r.id, text: editing.trim() });
            setEditing(null);
          }}
        >
          <input autoFocus maxLength={500} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <button type="submit">Redraft</button>
          <button type="button" className="link" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : (
        <div className="row">
          <button className={on ? "on" : ""} aria-pressed={on} onClick={() => act({ type: "rule", ruleId: r.id, op: on ? "off" : "on" })}>
            {on ? "On" : "Off"}
          </button>
          <button onClick={() => setEditing(r.wording)}>Edit</button>
          <button className="link" onClick={() => confirm(`Delete the rule "${r.wording}"?`) && act({ type: "rule", ruleId: r.id, op: "delete" })}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function RulesPage({ rules, settings, act, hiddenCount }: { rules: RulesFile | null; settings: SettingsOverlay; act: Act; hiddenCount: number }) {
  const [typed, setTyped] = useState("");
  if (!rules) return <p className="empty">The Rules page appears after the Mac's next update (within about 15 minutes).</p>;
  const added = settings.added.filter((a) => !rules.suggestions.some((s) => s.from.kind === "typed" && s.from.text === a.text));
  return (
    <div className="rules-page">
      <OwnWords rules={rules} pending={settings.ownWords} act={act} />

      <section className="rules-block">
        <h2>Suggestions</h2>
        {rules.suggestions.length === 0 && added.length === 0 && (
          <p className="fine">None waiting. When you hide something, Gemma may suggest a rule here, and nothing beyond that one item is hidden until you approve it.</p>
        )}
        {added.map((a) => (
          <div key={a.at} className="rule-card">
            <p className="from fine">You typed: "{a.text}"</p>
            <p className="fine">Gemma drafts it the next time the Mac is free.</p>
          </div>
        ))}
        {rules.suggestions.map((s) => (
          <SuggestionCard key={s.id} s={s} act={act} op={settings.ops.get(s.id)} edit={settings.edits.get(s.id)} />
        ))}
      </section>

      <section className="rules-block">
        <h2>Add a rule</h2>
        <form
          className="why-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) act({ type: "rule-add", text: typed.trim() });
            setTyped("");
          }}
        >
          <input maxLength={500} placeholder="e.g. Never show posts about crypto" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button type="submit" disabled={!typed.trim()}>Draft it</button>
        </form>
        <p className="fine">Gemma turns it into a rule and shows you what it would hide before you approve it.</p>
      </section>

      <section className="rules-block">
        <h2>Your rules</h2>
        {rules.rules.length === 0 && <p className="fine">No rules yet.</p>}
        {rules.rules.map((r) => (
          <RuleRow key={r.id} r={r} act={act} op={settings.ops.get(r.id)} edit={settings.edits.get(r.id)} />
        ))}
      </section>

      <p>
        <a href="#/hidden">See what's hidden{hiddenCount ? ` (${hiddenCount})` : ""} →</a>
      </p>
    </div>
  );
}

// ---- The app -----------------------------------------------------------------------------------------

type State =
  | { kind: "starting" }
  | { kind: "signed-out"; error?: string }
  | { kind: "loading"; account: AccountInfo }
  | { kind: "ready"; account: AccountInfo; edition: Edition; status: Status | null; rules: RulesFile | null; offline: boolean }
  | { kind: "error"; account: AccountInfo; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "starting" });
  const [refreshing, setRefreshing] = useState(false);
  const route = useRoute();

  const load = useCallback(async (account: AccountInfo) => {
    setRefreshing(true);
    try {
      const [{ edition, offline }, status, rules] = await Promise.all([loadEdition(), loadStatus(), loadRules()]);
      setState({ kind: "ready", account, edition, status, rules, offline });
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
  const rules = state.kind === "ready" ? state.rules : null;
  const { overlay, settings, act, waiting, read, markRead } = useReaderActions(rawEdition, rules);
  // Suggestions ready for you to look at (the badge), less the ones you've already answered.
  const waitingSuggestions = (rules?.suggestions ?? []).filter((s) => s.status === "ready" && !settings.ops.has(s.id)).length;
  // The edition with your own not-yet-synced changes on top.
  const edition = useMemo(
    () => (rawEdition ? { ...rawEdition, items: rawEdition.items.filter((i) => overlay.get(i.id)?.hidden !== true).map((i) => applyOverlay(i, overlay.get(i.id))) } : null),
    [rawEdition, overlay],
  );
  const hiddenList = useMemo(() => (rawEdition ? hiddenWithOverlay(rawEdition, overlay) : []), [rawEdition, overlay]);
  const [hiding, setHiding] = useState<{ id: string; title: string } | null>(null);
  const hide = useCallback(
    (item: ItemCard) => {
      act({ type: "hide", itemId: item.id, reason: null, note: null });
      setHiding({ id: item.id, title: item.title });
      if (history.length > 1) history.back();
      else location.hash = "#/";
    },
    [act],
  );

  // Read before the last refresh: left out of the lists (still under Read). Something you read now stays until the
  // next refresh, just dimmed, so the list doesn't shift under you.
  const [readAtLoad, setReadAtLoad] = useState<Set<string>>(new Set());
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => setReadAtLoad(new Set(readRef.current)), [rawEdition]);
  const unreadItems = useMemo(() => (edition ? edition.items.filter((i) => !readAtLoad.has(i.id)) : []), [edition, readAtLoad]);
  const readItems = useMemo(() => (edition ? edition.items.filter((i) => read.has(i.id)) : []), [edition, read]);

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

  const item = (route.page === "item" || route.page === "newsletter") && edition ? edition.items.find((i) => i.id === route.id) : undefined;
  const active = route.page === "section" || route.page === "briefs" ? route.id : route.page === "item" || route.page === "newsletter" ? null : route.page;
  const saved = edition ? edition.items.filter((i) => i.saved) : [];

  return (
    <>
      <header className={`masthead${route.page === "item" || route.page === "newsletter" ? " scrolls" : ""}`}>
        <div className="masthead-row">
          <a href="#/" className="masthead-title">The Broadsheet</a>
          <div className="masthead-buttons">
            <a href="#/rules" className={`rules-link${active === "rules" ? " on" : ""}`} aria-label={`Rules${waitingSuggestions ? `, ${waitingSuggestions} suggestions waiting` : ""}`}>
              Rules{waitingSuggestions > 0 && <span className="badge">{waitingSuggestions}</span>}
            </a>
            <button className="icon" aria-label="Refresh" disabled={refreshing} onClick={() => load(state.account)}>
              {refreshing ? "…" : "↻"}
            </button>
          </div>
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
        {edition && route.page === "front" && <FrontPage items={unreadItems} read={read} />}
        {edition && route.page === "section" && <SectionPage id={route.id} items={unreadItems.filter((i) => i.section === route.id)} read={read} />}
        {edition && route.page === "briefs" && (
          <BriefList title={`In brief: ${edition.sections.find((s) => s.id === route.id)?.name ?? route.id}`} items={unreadItems.filter((i) => isBrief(i) && i.section === route.id)} read={read} />
        )}
        {edition && route.page === "read" && <ItemList items={readItems} read={new Set()} empty="Nothing read yet. Articles you open leave the lists after the next refresh, and gather here." />}
        {edition && route.page === "saved" && <ItemList items={saved} read={read} empty="Nothing saved. Saved articles are kept after the others expire." />}
        {edition && route.page === "hidden" && <HiddenList hidden={hiddenList} act={act} />}
        {edition && route.page === "rules" && <RulesPage rules={rules} settings={settings} act={act} hiddenCount={hiddenList.length} />}
        {edition && route.page === "item" &&
          (item ? <Article item={item} sections={edition.sections} act={act} read={read.has(item.id)} markRead={markRead} onHide={hide} /> : <p className="empty">That article has expired. <a href="#/">Back to the Front Page</a></p>)}
        {edition && route.page === "newsletter" &&
          (item ? <Newsletter item={item} /> : <p className="empty">That newsletter has expired. <a href="#/">Back to the Front Page</a></p>)}
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
            <a href="#/read" className="footer-link">Read{readItems.length ? ` (${readItems.length})` : ""}</a>
            {" · "}
            <a href="#/hidden" className="footer-link">Hidden{hiddenList.length ? ` (${hiddenList.length})` : ""}</a>
            {" · "}
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
      {hiding && <HideSheet item={hiding} act={act} close={() => setHiding(null)} />}
    </>
  );
}
