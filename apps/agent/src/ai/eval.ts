// `broadsheet eval` (PLAN.md §5, docs/phase-2.md P6): run the same saved newsletters through one or two models and
// write a local page to compare them side by side, with what the paper had and what you did (ratings, moves,
// hides) alongside. Everything stays on the Mac:
//   eval/set.json            the saved test set: each item's facts, what the paper had, and what you did
//   eval/set/<id>.txt        its text (kept until you save a new set or clear it)
//   eval/runs/<…>.json       each model's answers, reused while the set and the prompt are unchanged
//   eval/report-<time>.html  the comparison page
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Enrichment } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import type { LlmProvider } from "./provider.ts";
import { buildMessages, enrich, type EnrichContext } from "./enrich.ts";

// ---- The test set ------------------------------------------------------------------------------------

const Case = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  sourceId: z.string(),
  author: z.string().nullable(),
  publishedAt: z.string(),
  fixedSection: z.string().nullable(),
  piece: z.object({ kind: z.enum(["brief", "article"]), newsletter: z.string() }).nullable(),
  words: z.number(),
  /** What the paper had when the set was saved. */
  paper: z.object({
    model: z.string().nullable(),
    section: z.string().nullable(),
    interest: z.number().nullable(),
    isArticle: z.boolean().nullable(),
    summary: z.string().nullable(),
    keyPoints: z.array(z.string()),
    tags: z.array(z.string()),
    whyItsHere: z.string().nullable(),
  }),
  /** What you did with it: the closest thing to a right answer. */
  you: z.object({
    rating: z.number().nullable(),
    ratingNote: z.string().nullable(),
    movedTo: z.string().nullable(),
    hidden: z.string().nullable(),
  }),
});
export type EvalCase = z.infer<typeof Case>;
const EvalSet = z.object({ savedAt: z.string(), cases: z.array(Case) });
export type EvalSet = z.infer<typeof EvalSet>;

const MAX_BRIEFS = 4;
const MAX_NOT_ARTICLES = 2;

/**
 * Which current items make a good test: the ones you rated, moved or hid first (they come with your answer),
 * then the newest from each newsletter in turn, so no single newsletter dominates. A few briefs and a few that
 * Gemma called "not an article" are included, since those are judgments worth checking.
 */
export function pickCases(db: Db, count: number): string[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.source_id, i.kind, i.is_article, i.published_at,
              (i.rating IS NOT NULL OR i.section_source = 'user' OR i.hidden_by = 'user') AS yours
       FROM items i
       WHERE i.ai_status = 'done' AND i.kind != 'newsletter' AND (i.hidden_by IS NULL OR i.hidden_by = 'user')
       ORDER BY yours DESC, i.published_at DESC, i.id`,
    )
    .all() as { id: string; source_id: string; kind: string; is_article: number; published_at: string; yours: number }[];
  const picked: string[] = [];
  const perSource = new Map<string, number>();
  let briefs = 0;
  let notArticles = 0;
  // Pass 1: one per newsletter (yours first); pass 2: a second each; pass 3: anything left.
  for (const cap of [1, 2, Infinity]) {
    for (const r of rows) {
      if (picked.length >= count) return picked;
      if (picked.includes(r.id) || (perSource.get(r.source_id) ?? 0) >= cap) continue;
      if (r.kind === "brief" && briefs >= MAX_BRIEFS) continue;
      if (r.is_article === 0 && notArticles >= MAX_NOT_ARTICLES) continue;
      picked.push(r.id);
      perSource.set(r.source_id, (perSource.get(r.source_id) ?? 0) + 1);
      if (r.kind === "brief") briefs++;
      if (r.is_article === 0) notArticles++;
    }
  }
  return picked;
}

/** Save a new test set from the current items, replacing the old one (and its runs, which no longer apply). */
export async function saveSet(db: Db, contentDir: string, evalDir: string, count: number, now = new Date()): Promise<EvalSet> {
  const cases: EvalCase[] = [];
  const texts = new Map<string, string>();
  for (const id of pickCases(db, count)) {
    const r = db
      .prepare(
        `SELECT i.*, coalesce(s.display_name, s.id) AS source_name, parent.title AS newsletter_title, p.rating_note, p.moved_to_section
         FROM items i JOIN sources s ON s.id = i.source_id LEFT JOIN items parent ON parent.id = i.parent_id
           LEFT JOIN preference_records p ON p.item_id = i.id
         WHERE i.id = ?`,
      )
      .get(id) as any;
    const text = await readFile(join(contentDir, id, "article.txt"), "utf8").catch(() => null);
    if (!r || !text) continue;
    texts.set(id, text);
    cases.push({
      id,
      title: r.title,
      source: r.source_name,
      sourceId: r.source_id,
      author: r.author,
      publishedAt: r.published_at,
      fixedSection: r.section_source === "fixed" ? r.section_id : null,
      piece: r.parent_id ? { kind: r.kind === "brief" ? "brief" : "article", newsletter: r.newsletter_title ?? r.source_name } : null,
      words: r.word_count,
      paper: {
        model: r.model,
        section: r.section_source === "user" ? null : r.section_id, // you moved it: the AI's choice isn't kept
        interest: r.interest,
        isArticle: r.is_article === null ? null : Boolean(r.is_article),
        summary: r.summary,
        keyPoints: JSON.parse(r.key_points_json ?? "[]"),
        tags: JSON.parse(r.tags_json ?? "[]"),
        whyItsHere: r.why_its_here,
      },
      you: {
        rating: r.rating ?? null,
        ratingNote: r.rating_note ?? null,
        movedTo: r.section_source === "user" ? r.section_id : null,
        hidden: r.hidden_by === "user" ? (r.hidden_reason ?? "hidden") : null,
      },
    });
  }
  await rm(join(evalDir, "set"), { recursive: true, force: true });
  await rm(join(evalDir, "runs"), { recursive: true, force: true });
  await mkdir(join(evalDir, "set"), { recursive: true });
  for (const [id, text] of texts) await writeFile(join(evalDir, "set", `${id}.txt`), text);
  const set: EvalSet = { savedAt: now.toISOString(), cases };
  await writeFile(join(evalDir, "set.json"), JSON.stringify(set, null, 1));
  return set;
}

export async function loadSet(evalDir: string): Promise<EvalSet | null> {
  const raw = await readFile(join(evalDir, "set.json"), "utf8").catch(() => null);
  return raw ? EvalSet.parse(JSON.parse(raw)) : null;
}

/** Delete the saved set, its texts, runs and pages. */
export async function clearEval(evalDir: string) {
  await rm(evalDir, { recursive: true, force: true });
}

// ---- Running a model ---------------------------------------------------------------------------------

export type EvalContext = Omit<EnrichContext, "sourceId">;

export type EvalResult = { id: string; ok: boolean; data: Enrichment | null; error: string | null; seconds: number; attempts: number; outputTokens: number };
export type EvalRun = { model: string; fingerprint: string; startedAt: string; results: EvalResult[] };

const inputOf = (c: EvalCase, text: string) => ({ title: c.title, source: c.source, author: c.author, text, fixedSection: c.fixedSection, piece: c.piece });

/** Everything the model is sent, hashed: a saved run is reused only while this is unchanged. */
export async function fingerprint(set: EvalSet, evalDir: string, ctx: EvalContext): Promise<string> {
  const h = createHash("sha256");
  for (const c of set.cases) {
    const text = await readFile(join(evalDir, "set", `${c.id}.txt`), "utf8");
    for (const m of buildMessages(inputOf(c, text), { ...ctx, sourceId: c.sourceId }).messages) h.update(m.content);
  }
  return h.digest("hex").slice(0, 16);
}

const runFile = (evalDir: string, model: string, fp: string) => join(evalDir, "runs", `${model.replace(/[^\w.-]+/g, "_")}-${fp}.json`);

/** A finished run of this model on this set with this prompt, if there is one. */
export async function savedRun(evalDir: string, model: string, fp: string): Promise<EvalRun | null> {
  const raw = await readFile(runFile(evalDir, model, fp), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as EvalRun) : null;
}

export async function runModel(
  llm: LlmProvider,
  model: string,
  set: EvalSet,
  evalDir: string,
  ctx: EvalContext,
  opts: { limit?: number; onItem?: (n: number, total: number, c: EvalCase, r: EvalResult) => void } = {},
): Promise<EvalRun> {
  const fp = await fingerprint(set, evalDir, ctx);
  const cases = set.cases.slice(0, opts.limit ?? set.cases.length);
  const run: EvalRun = { model, fingerprint: fp, startedAt: new Date().toISOString(), results: [] };
  for (const [n, c] of cases.entries()) {
    const text = await readFile(join(evalDir, "set", `${c.id}.txt`), "utf8");
    let outputTokens = 0;
    const counting: LlmProvider = { ...llm, id: llm.id, chat: async (m, o) => { const r = await llm.chat(m, o); outputTokens += r.outputTokens; return r; }, isLoaded: () => llm.isLoaded(), unload: () => llm.unload() };
    const r = await enrich(counting, inputOf(c, text), { ...ctx, sourceId: c.sourceId }).catch((e: Error) => ({ ok: false as const, error: e.message, attempts: 1, seconds: 0 }));
    const result: EvalResult = r.ok
      ? { id: c.id, ok: true, data: r.data, error: null, seconds: r.seconds, attempts: r.attempts, outputTokens }
      : { id: c.id, ok: false, data: null, error: r.error, seconds: r.seconds, attempts: r.attempts, outputTokens };
    run.results.push(result);
    opts.onItem?.(n + 1, cases.length, c, result);
  }
  // Only a full run is kept for reuse; a --limit run is a quick look.
  if (cases.length === set.cases.length) {
    await mkdir(join(evalDir, "runs"), { recursive: true });
    await writeFile(runFile(evalDir, model, fp), JSON.stringify(run, null, 1));
  }
  return run;
}

// ---- Numbers -----------------------------------------------------------------------------------------

export type RunStats = {
  model: string;
  items: number;
  valid: number;
  /** Needed the retry with the validation error. */
  retried: number;
  avgSeconds: number;
  avgOutputTokens: number;
  interestMean: number | null;
  /** Spread of interest scores: near 0 means it scores everything the same, which ranks nothing. */
  interestSpread: number | null;
  /** Where you moved an item, how often it chose that section. */
  matchesYourMoves: { agree: number; of: number };
  /** How often it chose the section the paper had. */
  matchesPaper: { agree: number; of: number };
  /** Mean interest of items you rated 👍 minus items you rated 👎 (higher is better). */
  ratingGap: number | null;
  notArticles: number;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function stats(set: EvalSet, run: { model: string; results: EvalResult[] }): RunStats {
  const byId = new Map(set.cases.map((c) => [c.id, c]));
  const ok = run.results.filter((r) => r.ok && r.data);
  // Over the items it called articles: low scores for promotions would otherwise hide that it scores every
  // real article the same.
  const interests = ok.filter((r) => r.data!.is_article).map((r) => r.data!.interest);
  const m = mean(interests);
  const spread = m === null ? null : Math.sqrt(mean(interests.map((x) => (x - m) ** 2))!);
  const moves = ok.filter((r) => byId.get(r.id)?.you.movedTo);
  const paper = ok.filter((r) => byId.get(r.id)?.paper.section && !byId.get(r.id)?.fixedSection);
  const liked = mean(ok.filter((r) => byId.get(r.id)?.you.rating === 1).map((r) => r.data!.interest));
  const disliked = mean(ok.filter((r) => byId.get(r.id)?.you.rating === -1).map((r) => r.data!.interest));
  return {
    model: run.model,
    items: run.results.length,
    valid: ok.length,
    retried: ok.filter((r) => r.attempts > 1).length,
    avgSeconds: mean(run.results.map((r) => r.seconds)) ?? 0,
    avgOutputTokens: mean(run.results.map((r) => r.outputTokens)) ?? 0,
    interestMean: m,
    interestSpread: spread,
    matchesYourMoves: { agree: moves.filter((r) => r.data!.section === byId.get(r.id)!.you.movedTo).length, of: moves.length },
    matchesPaper: { agree: paper.filter((r) => r.data!.section === byId.get(r.id)!.paper.section).length, of: paper.length },
    ratingGap: liked !== null && disliked !== null ? liked - disliked : null,
    notArticles: ok.filter((r) => !r.data!.is_article).length,
  };
}

// ---- The page ----------------------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const RATING: Record<string, string> = { "1": "👍", "0": "👌", "-1": "👎" };

export function reportHtml(set: EvalSet, runs: EvalRun[], sections: { id: string; name: string }[], now = new Date()): string {
  const sectionName = (id: string | null | undefined) => (id ? (sections.find((s) => s.id === id)?.name ?? id) : "—");
  const all = runs.map((r) => stats(set, r));
  const fmt = (n: number | null, digits = 0) => (n === null ? "—" : n.toFixed(digits));
  const frac = (x: { agree: number; of: number }) => (x.of ? `${x.agree} of ${x.of}` : "—");

  const statRows: [string, string, (s: RunStats) => string][] = [
    ["Valid replies", "Replies that matched the schema (after one retry at most)", (s) => `${s.valid} of ${s.items}${s.retried ? ` (${s.retried} needed a retry)` : ""}`],
    ["Seconds per item", "Average time per newsletter on this Mac", (s) => fmt(s.avgSeconds, 1)],
    ["Words written", "Average output tokens per item", (s) => fmt(s.avgOutputTokens)],
    ["Interest: average", "Over the items it called articles", (s) => fmt(s.interestMean)],
    ["Interest: spread", "How differently it scores articles (standard deviation). Near 0 means it gives them all the same score, which ranks nothing.", (s) => fmt(s.interestSpread, 1)],
    ["👍 minus 👎", "Average interest of items you liked minus items you disliked. Higher means it agrees with you.", (s) => fmt(s.ratingGap)],
    ["Your section moves", "Where you moved an item, how often it chose that section", (s) => frac(s.matchesYourMoves)],
    ["Same section as the paper", "How often it agrees with the section the paper had", (s) => frac(s.matchesPaper)],
    ["Called “not an article”", "", (s) => String(s.notArticles)],
  ];

  const resultCell = (c: EvalCase, r: EvalResult | undefined) => {
    if (!r) return `<td class="none">not run</td>`;
    if (!r.ok || !r.data) return `<td class="bad">Failed: ${esc(r.error)}</td>`;
    const d = r.data;
    const sectionClass = c.you.movedTo ? (d.section === c.you.movedTo ? "good" : "bad") : d.section !== c.paper.section ? "diff" : "";
    return `<td>
      <p class="facts"><span class="${sectionClass}">${esc(sectionName(d.section))}</span> · interest <b>${d.interest}</b>${d.is_article ? "" : ` · <span class="bad">not an article</span>`}${d.hidden_by_rule ? ` · rule <b>${esc(d.hidden_by_rule)}</b>` : ""} · ${r.seconds.toFixed(0)} s</p>
      <p>${esc(d.summary)}</p>
      ${d.key_points.length ? `<ul>${d.key_points.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
      <p class="fine">${esc(d.why_its_here)}</p>
      <p class="tags">${d.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>
    </td>`;
  };
  const paperCell = (c: EvalCase) => {
    const p = c.paper;
    if (!p.summary) return `<td class="none">No summary</td>`;
    return `<td>
      <p class="facts">${esc(sectionName(p.section))} · interest <b>${p.interest ?? "—"}</b>${p.isArticle === false ? ` · <span class="bad">not an article</span>` : ""}</p>
      <p>${esc(p.summary)}</p>
      ${p.keyPoints.length ? `<ul>${p.keyPoints.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
      <p class="fine">${esc(p.whyItsHere)}</p>
      <p class="tags">${p.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>
    </td>`;
  };
  const yourCell = (c: EvalCase) =>
    [
      c.you.rating !== null ? `You rated it ${RATING[String(c.you.rating)]}${c.you.ratingNote ? `: “${esc(c.you.ratingNote)}”` : ""}` : null,
      c.you.movedTo ? `You moved it to <b>${esc(sectionName(c.you.movedTo))}</b>` : null,
      c.you.hidden ? `You hid it (${esc(c.you.hidden)})` : null,
      c.fixedSection ? `Always in ${esc(sectionName(c.fixedSection))}` : null,
    ].filter(Boolean).join(" · ");

  const byRun = runs.map((r) => new Map(r.results.map((x) => [x.id, x])));
  const heads = [`In the paper${set.cases[0]?.paper.model ? ` (${esc(set.cases[0].paper.model)})` : ""}`, ...runs.map((r) => esc(r.model))];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Broadsheet: model comparison</title>
<style>
  :root { --ink:#1d1b18; --muted:#6b665e; --rule:#d9d3c7; --paper:#faf7f0; --good:#1f7a3a; --bad:#b3261e; --diff:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --ink:#ece7dc; --muted:#a39d91; --rule:#3d3a34; --paper:#191816; --good:#6fcf8a; --bad:#f2918a; --diff:#e0b45a; } }
  body { font: 15px/1.45 -apple-system, system-ui, sans-serif; color: var(--ink); background: var(--paper); margin: 0 auto; padding: 1.5rem; max-width: 90rem; }
  h1, h2 { font-family: Georgia, serif; } h1 { margin: 0 0 .25rem; } h2 { font-size: 1.15rem; margin: 0 0 .2rem; }
  .fine, .meta { color: var(--muted); font-size: .85rem; } p { margin: .3rem 0; }
  table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid var(--rule); padding: .5rem .6rem; text-align: left; vertical-align: top; }
  .stats td:first-child { white-space: nowrap; } .stats td.num { font-variant-numeric: tabular-nums; }
  .case { margin: 2rem 0; } .case td { width: ${Math.floor(100 / heads.length)}%; } .case ul { margin: .3rem 0; padding-left: 1.1rem; }
  .facts { font-size: .88rem; } .good { color: var(--good); font-weight: 600; } .bad { color: var(--bad); } .diff { color: var(--diff); font-weight: 600; } .none { color: var(--muted); }
  .tags span { display: inline-block; font-size: .75rem; border: 1px solid var(--rule); border-radius: 999px; padding: 0 .45rem; margin: 0 .25rem .25rem 0; color: var(--muted); }
  .you { font-size: .88rem; }
</style></head><body>
<h1>Model comparison</h1>
<p class="meta">${set.cases.length} newsletters saved ${esc(new Date(set.savedAt).toLocaleString())} · page made ${esc(now.toLocaleString())} · the same prompt, your profile and your rules for every model</p>
<p class="fine">Section colours: <span class="good">green</span> agrees with where you moved it, <span class="bad">red</span> doesn't, <span class="diff">amber</span> differs from the paper.</p>

<table class="stats"><thead><tr><th></th>${all.map((s) => `<th>${esc(s.model)}</th>`).join("")}</tr></thead><tbody>
${statRows.map(([label, help, f]) => `<tr><td>${esc(label)}${help ? `<div class="fine">${esc(help)}</div>` : ""}</td>${all.map((s) => `<td class="num">${esc(f(s))}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>

${set.cases
  .map(
    (c) => `<section class="case">
  <h2>${esc(c.title)}</h2>
  <p class="meta">${esc(c.source)}${c.author && c.author !== c.source ? ` · ${esc(c.author)}` : ""} · ${c.words} words${c.piece ? ` · a ${c.piece.kind} from “${esc(c.piece.newsletter)}”` : ""}</p>
  ${yourCell(c) ? `<p class="you">${yourCell(c)}</p>` : ""}
  <table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody><tr>${paperCell(c)}${byRun.map((m) => resultCell(c, m.get(c.id))).join("")}</tr></tbody></table>
</section>`,
  )
  .join("\n")}
</body></html>
`;
}

