// Gemma's Rules-page work (PLAN.md §4.3, docs/phase-2.md P4), done in Stage B while you're away:
//   - draft a rule from an item you hid, or from words you typed, or redraft one you reworded;
//   - preview it: which of the current items it would hide, so you can see whether it's too broad;
//   - re-score interest after you change "In your own words" (from the summaries: quick).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CheckRule, InstructionRule, type Condition } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import { conditionMatches, type EmailFacts } from "../pipeline/classify.ts";
import { extractJson } from "./enrich.ts";
import type { LlmProvider } from "./provider.ts";

export const MAX_DRAFT_ATTEMPTS = 3;
const PREVIEW_BATCH = 30;

// ---- Drafting ----------------------------------------------------------------------------------------

const DraftReply = z.object({
  kind: z.enum(["check", "instruction", "none"]),
  wording: z.string().max(200).nullable().optional(),
  source_only: z.boolean().optional(),
  /** For a typed rule: the one newsletter it names, if any. */
  newsletter: z.string().nullable().optional(),
  match: z.enum(["all", "any"]).optional(),
  // Checked properly only for a check rule (Gemma sometimes adds conditions to an instruction too).
  conditions: z.array(z.unknown()).optional(),
  instruction: z.string().max(500).nullable().optional(),
  why_none: z.string().max(300).nullable().optional(),
});
type DraftReply = z.infer<typeof DraftReply>;

type RequestRow = {
  id: number; kind: "hidden-item" | "typed" | "edit"; item_id: string | null; source_id: string | null; facts_json: string | null;
  excerpt: string | null; reason: string | null; note: string | null; text: string | null; rule_id: string | null; attempts: number;
};

const REASONS: Record<string, string> = { "not-article": "not an article", ad: "an ad or promo", topic: "not my topic", author: "not this author" };

export function buildDraftMessages(db: Db, q: RequestRow) {
  const sources = db.prepare("SELECT id, coalesce(display_name, id) AS name FROM sources WHERE status != 'muted' ORDER BY name").all() as { id: string; name: string }[];
  const existing = db.prepare("SELECT id, kind, wording FROM rules WHERE status = 'active' AND kind != 'include'").all() as { id: string; kind: string; wording: string }[];

  const system = [
    `You help the reader of "The Broadsheet", a private newspaper made from their newsletters, write rules that keep things out of the paper.`,
    `Reply with ONLY a JSON object, no prose:`,
    `{"kind": "check" | "instruction" | "none", "wording": "...", "source_only": true|false, "newsletter": "..." | null, "match": "all"|"any", "conditions": [...], "instruction": "...", "why_none": "..."}`,
    ``,
    `Two kinds of rule:`,
    `- "check": simple conditions tested on each email, free and exact. Use one whenever the pattern shows in these fields:`,
    `    sender (address), domain (sender's domain), subject, listId (the List-Id header), body (the text), linksTo (any link URL): op "contains", "equals" or "matches" (a regular expression), value a string`,
    `    wordCount: op "lessThan" or "greaterThan", value a number`,
    `  Give "match" ("all" = every condition, "any" = at least one) and "conditions", e.g. [{"field": "subject", "op": "contains", "value": "is live"}, {"field": "wordCount", "op": "lessThan", "value": 200}].`,
    `- "instruction": one plain-English sentence Gemma applies to each item, for patterns that need judgment, e.g. "Hide posts that are mainly an ad for the author's course." Put it in "instruction".`,
    `Set "source_only" to true when the pattern belongs to this one newsletter, false when it should apply to all of them.`,
    `When the reader names one newsletter, set "newsletter" to its name exactly as listed below; otherwise null.`,
    `Regular expressions are JavaScript ones and always case-insensitive: don't write (?i).`,
    `"wording" is what the reader sees: a short plain sentence, e.g. "Hide live-video posts from Studio Live".`,
    `Make the rule as narrow as the evidence: it must not catch ordinary articles. If the item looks like a one-off, or an existing rule already covers it, reply {"kind": "none", "why_none": "..."}.`,
    existing.length ? `\nExisting rules:\n${existing.map((r) => `- ${r.wording}`).join("\n")}` : ``,
  ].join("\n");

  let user: string;
  if (q.kind === "hidden-item") {
    const f = JSON.parse(q.facts_json ?? "{}");
    const source = sources.find((s) => s.id === q.source_id)?.name ?? q.source_id;
    user = [
      `The reader tapped "Don't show things like this" on this item.`,
      `Their reason: ${q.reason ? REASONS[q.reason] ?? q.reason : "(none given)"}`,
      `Their note: ${q.note ? `"${q.note}"` : "(none)"}`,
      ``,
      `Newsletter: ${source}`,
      `sender: ${f.sender ?? "unknown"}`,
      `listId: ${f.listId ?? "none"}`,
      `subject: ${f.subject}`,
      `wordCount: ${f.wordCount}`,
      `Links: ${(f.links ?? []).slice(0, 15).join(" ") || "none"}`,
      ``,
      `The text begins:`,
      (q.excerpt ?? "").slice(0, 2500),
    ].join("\n");
  } else if (q.kind === "typed") {
    user = [`The reader typed this rule: "${q.text}"`, ``, `Their newsletters:`, ...sources.map((s) => `- ${s.name}`)].join("\n");
  } else {
    const r = db.prepare("SELECT * FROM rules WHERE id = ?").get(q.rule_id) as any;
    const source = r?.source_id ? (sources.find((s) => s.id === r.source_id)?.name ?? r.source_id) : null;
    user = [
      `The reader reworded this rule${source ? ` (for ${source} only)` : ""}.`,
      `Before: "${r?.wording}"${r?.kind === "instruction" ? ` (instruction: ${r.instruction})` : r?.conditions_json ? ` (conditions: ${r.conditions_json})` : ""}`,
      `Now: "${q.text}"`,
      `Draft the rule they now mean.`,
    ].join("\n");
  }
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/** Turn Gemma's reply into a checked rule, or explain why there isn't one. */
export function ruleFromReply(
  raw: string,
  q: Pick<RequestRow, "kind" | "text" | "source_id">,
  ruleSource: string | null,
  sources: { id: string; name: string }[] = [],
):
  | { ok: true; rule: { kind: "check" | "instruction"; wording: string; match: "all" | "any" | null; conditions: z.infer<typeof Condition>[] | null; instruction: string | null; sourceId: string | null } }
  | { ok: false; none: boolean; error: string } {
  let d: DraftReply;
  try {
    d = DraftReply.parse(extractJson(raw));
  } catch (e) {
    const why = e instanceof z.ZodError ? z.prettifyError(e).split("\n").slice(0, 2).join(" ") : (e as Error).message.split("\n")[0];
    return { ok: false, none: false, error: `Gemma's reply wasn't a rule (${why})` };
  }
  if (d.kind === "none") return { ok: false, none: true, error: d.why_none || "Gemma didn't find a general rule here" };
  const wording = (d.wording || q.text || "").trim();
  const named = d.newsletter ? sources.find((s) => s.name.toLowerCase() === d.newsletter!.trim().toLowerCase() || s.id === d.newsletter!.trim()) : undefined;
  if (q.kind === "typed" && d.newsletter && !named) return { ok: false, none: false, error: `Gemma named a newsletter that isn't yours ("${d.newsletter}")` };
  const sourceId = q.kind === "edit" ? ruleSource : q.kind === "typed" ? (named?.id ?? null) : d.source_only ? q.source_id : null;
  // JavaScript has no inline (?i); matching is case-insensitive anyway.
  const conditions = (d.conditions ?? []).map((c) => (c && typeof c === "object" && "value" in c && typeof c.value === "string" ? { ...c, value: c.value.replace(/^\(\?i\)/, "") } : c));
  const common = { id: "draft", wording, ...(sourceId ? { source: sourceId } : {}) };
  const checked =
    d.kind === "check"
      ? CheckRule.safeParse({ ...common, kind: "check", match: d.match ?? "all", conditions })
      : InstructionRule.safeParse({ ...common, kind: "instruction", instruction: d.instruction ?? "" });
  if (!checked.success) return { ok: false, none: false, error: `Gemma's draft wasn't valid (${z.prettifyError(checked.error).split("\n")[0]})` };
  const r = checked.data;
  return {
    ok: true,
    rule: {
      kind: r.kind as "check" | "instruction",
      wording: r.wording,
      match: r.kind === "check" ? r.match : null,
      conditions: r.kind === "check" ? r.conditions : null,
      instruction: r.kind === "instruction" ? r.instruction : null,
      sourceId,
    },
  };
}

function newRuleId(db: Db, wording: string): string {
  const base = wording.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rule";
  let id = base;
  for (let n = 2; db.prepare("SELECT 1 FROM rules WHERE id = ?").get(id); n++) id = `${base}-${n}`;
  return id;
}

// ---- Preview: what it would hide now ------------------------------------------------------------------

type PreviewRule = { kind: "check" | "instruction"; match: "all" | "any" | null; conditions: z.infer<typeof Condition>[] | null; instruction: string | null; sourceId: string | null };

export async function previewRule(db: Db, rule: PreviewRule, opts: { llm: LlmProvider; contentDir: string; cutoff: string }): Promise<{ id: string; title: string; source: string }[]> {
  const items = db
    .prepare(
      `SELECT i.id, i.title, i.source_id, i.sender, i.list_id, i.word_count, i.summary, i.opening, s.match_json, coalesce(s.display_name, s.id) AS source_name
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.published_at >= ? AND i.shown_anyway = 0 AND (i.hidden_by IS NULL OR i.hidden_by = 'user')
       ORDER BY i.published_at DESC`,
    )
    .all(opts.cutoff) as any[];
  const inScope = items.filter((i) => !rule.sourceId || i.source_id === rule.sourceId);
  const ref = (i: any) => ({ id: i.id, title: i.title, source: i.source_name });

  if (rule.kind === "check") {
    const hits = [];
    for (const i of inScope) {
      const match = i.match_json ? JSON.parse(i.match_json) : {};
      const text = await readFile(join(opts.contentDir, i.id, "article.txt"), "utf8").catch(() => i.summary ?? i.opening ?? "");
      const html = await readFile(join(opts.contentDir, i.id, "article.html"), "utf8").catch(() => "");
      const facts: EmailFacts = {
        sender: (i.sender ?? match.sender ?? "").toLowerCase(),
        senderName: "",
        subject: i.title,
        listId: (i.list_id ?? match.listId ?? null)?.toLowerCase() ?? null,
        hasListUnsubscribe: false,
        platform: null,
        text,
        wordCount: i.word_count,
        links: [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!),
        fromAddFolder: false,
      };
      const conds = rule.conditions ?? [];
      if (rule.match === "any" ? conds.some((c) => conditionMatches(c, facts)) : conds.every((c) => conditionMatches(c, facts))) hits.push(ref(i));
    }
    return hits;
  }

  // An instruction needs judgment: ask Gemma about the items in batches, from their summaries.
  const hits: { id: string; title: string; source: string }[] = [];
  for (let n = 0; n < inScope.length; n += PREVIEW_BATCH) {
    const batch = inScope.slice(n, n + PREVIEW_BATCH);
    const list = batch.map((i, k) => `${k + 1}. [${i.source_name}] ${i.title} — ${(i.summary ?? i.opening ?? "").slice(0, 300).replace(/\s+/g, " ")}`).join("\n");
    const reply = await opts.llm.chat([
      {
        role: "system",
        content: `You check newspaper items against one rule. Reply with ONLY a JSON object {"numbers": [...]} listing the numbers of the items that clearly break the rule. Leave out anything unclear. The rule: "${rule.instruction}"`,
      },
      { role: "user", content: list },
    ]);
    try {
      const { numbers } = z.object({ numbers: z.array(z.number().int()) }).parse(extractJson(reply.text));
      for (const k of new Set(numbers)) if (batch[k - 1]) hits.push(ref(batch[k - 1]));
    } catch {
      // an unreadable answer previews as nothing caught; the rule itself is still fine to review
    }
  }
  return hits;
}

/** Draft (or redraft) one request. Returns a line for the log. */
export async function draftOne(db: Db, q: RequestRow, opts: { llm: LlmProvider; contentDir: string; cutoff: string; now: string }): Promise<string> {
  const { llm, now } = opts;
  const existing = q.kind === "edit" ? (db.prepare("SELECT * FROM rules WHERE id = ?").get(q.rule_id) as any) : undefined;
  if (q.kind === "edit" && !existing) {
    db.prepare("UPDATE rule_requests SET status = 'dismissed', updated_at = ? WHERE id = ?").run(now, q.id);
    return "the rule was deleted before Gemma could redraft it";
  }
  const reply = await llm.chat(buildDraftMessages(db, q));
  const sources = db.prepare("SELECT id, coalesce(display_name, id) AS name FROM sources").all() as { id: string; name: string }[];
  const r = ruleFromReply(reply.text, q, existing?.source_id ?? null, sources);

  if (!r.ok) {
    const attempts = q.attempts + 1;
    // "No general rule here" for an item you hid is a fine answer: nothing to suggest.
    if (r.none && q.kind === "hidden-item") {
      db.prepare("UPDATE rule_requests SET status = 'done', attempts = ?, error = ?, excerpt = NULL, updated_at = ? WHERE id = ?").run(attempts, r.error, now, q.id);
      return `no rule suggested (${r.error})`;
    }
    const failed = r.none || attempts >= MAX_DRAFT_ATTEMPTS;
    db.prepare("UPDATE rule_requests SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?").run(failed ? "failed" : "pending", attempts, r.error, now, q.id);
    return failed ? `couldn't draft: ${r.error}` : `will try again: ${r.error}`;
  }

  const rule = r.rule;
  const preview = await previewRule(db, rule, { llm, contentDir: opts.contentDir, cutoff: opts.cutoff });
  const ruleId = existing?.id ?? newRuleId(db, rule.wording);
  db.prepare(
    `INSERT INTO rules (id, kind, wording, match_mode, conditions_json, instruction, source_id, mail_action, status, origin, preview_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'deleted-items', 'suggested', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, wording = excluded.wording, match_mode = excluded.match_mode,
       conditions_json = excluded.conditions_json, instruction = excluded.instruction, source_id = excluded.source_id,
       preview_json = excluded.preview_json, version = rules.version + 1, updated_at = excluded.updated_at`,
  ).run(
    ruleId, rule.kind, rule.wording, rule.match, rule.conditions ? JSON.stringify(rule.conditions) : null, rule.instruction, rule.sourceId,
    q.kind === "typed" ? "typed" : "hidden-item", JSON.stringify(preview), now,
  );
  db.prepare("UPDATE rule_requests SET status = 'done', rule_id = ?, attempts = attempts + 1, error = NULL, excerpt = NULL, updated_at = ? WHERE id = ?").run(ruleId, now, q.id);
  return `${q.kind === "edit" ? "redrafted" : "suggested"} "${rule.wording}" (${rule.kind}; would hide ${preview.length} current item${preview.length === 1 ? "" : "s"})`;
}

export function pendingRequests(db: Db): RequestRow[] {
  return db.prepare("SELECT * FROM rule_requests WHERE status = 'pending' ORDER BY created_at").all() as RequestRow[];
}

// ---- Re-scoring after you change your words ----------------------------------------------------------------

const RescoreReply = z.object({ interest: z.number().int().min(0).max(100), why_its_here: z.string().min(1).max(200) });

export async function rescoreOne(
  llm: LlmProvider,
  item: { title: string; source: string; author: string | null; summary: string; keyPoints: string[]; tags: string[] },
  readerProfile: string,
): Promise<z.infer<typeof RescoreReply>> {
  const reply = await llm.chat([
    {
      role: "system",
      content: [
        `You are the editor of "The Broadsheet", a private newspaper. Score how interesting this item is to the reader, 0-100, and say why in one short line.`,
        `Reply with ONLY a JSON object: {"interest": <0-100>, "why_its_here": "..."}`,
        ``,
        `The reader:`,
        readerProfile || `No description yet. Prefers substantive writing over promotion.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [`Title: ${item.title}`, `Source: ${item.source}${item.author ? ` (by ${item.author})` : ""}`, `Tags: ${item.tags.join(", ")}`, ``, item.summary, ...item.keyPoints.map((k) => `- ${k}`)].join("\n"),
    },
  ]);
  return RescoreReply.parse(extractJson(reply.text));
}

