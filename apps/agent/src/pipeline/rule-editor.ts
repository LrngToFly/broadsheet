// Exact rules from Admin's condition editor (docs/phase-3.md A4): test one against recent mail, and save it. Check
// rules hide matching emails before any AI; include rules send matching emails to a section. Rules in plain English
// (instructions) are drafted by Gemma instead (ai/rule-draft.ts).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CheckRule, IncludeRule, type Condition } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import { domainOf } from "./classify.ts";
import { previewRule } from "../ai/rule-draft.ts";
import type { LlmProvider } from "../ai/provider.ts";
import type { MailPort } from "./stage-a-email.ts";
import { hideWhatItCatches } from "./rules.ts";

export const ExactRule = z.discriminatedUnion("kind", [CheckRule, IncludeRule]);
export type ExactRule = z.infer<typeof ExactRule>;

/** A rule from the editor, which may not have an id yet: one is made from its wording. */
export function parseExactRule(db: Db, input: unknown): ExactRule {
  const raw = { ...((input ?? {}) as Record<string, unknown>) }; // a copy: the caller's object is left alone
  if (!raw.id && typeof raw.wording === "string") {
    const base = raw.wording.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "rule";
    let id = base;
    for (let n = 2; db.prepare("SELECT 1 FROM rules WHERE id = ?").get(id); n++) id = `${base}-${n}`;
    raw.id = id;
  }
  const parsed = ExactRule.safeParse(raw);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

type Facts = { sender: string; subject: string; listId: string | null; links: string[]; wordCount: number; text: string | null };

/** true, false, or null when it can't be told (body text of an email that's no longer in the paper). */
function conditionResult(c: Condition, f: Facts): boolean | null {
  if (c.field === "wordCount") return c.op === "lessThan" ? f.wordCount < c.value : f.wordCount > c.value;
  if (c.field === "body" && f.text === null) return null;
  const values = { sender: [f.sender], domain: [domainOf(f.sender)], subject: [f.subject], listId: f.listId ? [f.listId] : [], body: [f.text ?? ""], linksTo: f.links }[c.field];
  const want = c.value.toLowerCase();
  return values.some((v) => (c.op === "equals" ? v.toLowerCase() === want : c.op === "contains" ? v.toLowerCase().includes(want) : new RegExp(c.value, "i").test(v)));
}

/** All / any, where "can't tell" stays "can't tell" unless the other conditions settle it. */
export function ruleResult(rule: { match: "all" | "any"; conditions: Condition[] }, f: Facts): boolean | null {
  const results = rule.conditions.map((c) => conditionResult(c, f));
  if (rule.match === "all") return results.includes(false) ? false : results.includes(null) ? null : true;
  return results.includes(true) ? true : results.includes(null) ? null : false;
}

export type TestResult = {
  /** Emails looked at (the mail log: the last `days` days). */
  checked: number;
  days: number;
  matched: { subject: string; sender: string; receivedAt: string; decision: string; why: string | null }[];
  /** Emails whose body text is gone, so a body condition couldn't be checked. */
  unknown: number;
};

/** Which emails of the last `days` days the rule would have caught (newest first). */
export async function testRule(db: Db, contentDir: string, rule: ExactRule, opts: { now: Date; days: number }): Promise<TestResult> {
  const since = new Date(opts.now.getTime() - opts.days * 86_400_000).toISOString();
  const rows = db.prepare("SELECT * FROM mail_log WHERE received_at >= ? ORDER BY received_at DESC").all(since) as any[];
  const result: TestResult = { checked: 0, days: opts.days, matched: [], unknown: 0 };
  for (const r of rows) {
    if (rule.source && r.source_id !== rule.source) continue;
    result.checked++;
    // Body text exists only while the email is in the paper.
    const text = r.item_id ? await readFile(join(contentDir, r.item_id, "article.txt"), "utf8").catch(() => null) : null;
    const facts: Facts = { sender: r.sender.toLowerCase(), subject: r.subject, listId: r.list_id?.toLowerCase() ?? null, links: JSON.parse(r.links_json), wordCount: r.word_count, text };
    const hit = ruleResult(rule, facts);
    if (hit === null) result.unknown++;
    else if (hit) result.matched.push({ subject: r.subject, sender: r.sender, receivedAt: r.received_at, decision: r.decision, why: r.why });
  }
  return result;
}

const noAi: LlmProvider = {
  id: "none",
  chat: async () => {
    throw new Error("not needed for exact rules");
  },
  isLoaded: async () => false,
  unload: async () => {},
};

/**
 * Save an exact rule (new or changed). A check rule can also hide the current articles it catches now (their emails
 * go where the rule says), the same as approving a suggestion.
 */
export async function saveExactRule(
  db: Db,
  mail: MailPort,
  rule: ExactRule,
  opts: { contentDir: string; cutoff: string; now: string; hideCurrent: boolean },
): Promise<{ id: string; created: boolean; hid: number }> {
  const created = !db.prepare("SELECT 1 FROM rules WHERE id = ?").get(rule.id);
  db.prepare(
    `INSERT INTO rules (id, kind, wording, match_mode, conditions_json, instruction, source_id, mail_action, section_id, status, origin, updated_at, preview_json)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'admin', ?, '[]')
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, wording = excluded.wording, match_mode = excluded.match_mode, conditions_json = excluded.conditions_json,
       instruction = NULL, source_id = excluded.source_id, mail_action = excluded.mail_action, section_id = excluded.section_id, status = excluded.status,
       version = rules.version + 1, updated_at = excluded.updated_at`,
  ).run(
    rule.id, rule.kind, rule.wording, rule.match, JSON.stringify(rule.conditions), rule.source ?? null,
    rule.kind === "check" ? rule.mail : null, rule.kind === "include" ? (rule.section ?? null) : null, rule.status, opts.now,
  );
  let hid = 0;
  if (rule.kind === "check" && rule.status === "active" && opts.hideCurrent) {
    const caught = await previewRule(db, { kind: "check", match: rule.match, conditions: rule.conditions, instruction: null, sourceId: rule.source ?? null }, { llm: noAi, contentDir: opts.contentDir, cutoff: opts.cutoff });
    const before = (db.prepare("SELECT count(*) n FROM items WHERE hidden_by = ?").get(rule.id) as { n: number }).n;
    await hideWhatItCatches(db, mail, rule.id, rule.mail, caught, opts.now);
    hid = (db.prepare("SELECT count(*) n FROM items WHERE hidden_by = ?").get(rule.id) as { n: number }).n - before;
  }
  return { id: rule.id, created, hid };
}
