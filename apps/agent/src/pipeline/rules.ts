// Rules and your own words from the reader's Rules page (PLAN.md §4.3, docs/phase-2.md P4). The reader never
// changes the database itself: it sends actions, applied here at the start of a run. Drafting with Gemma
// happens later, while you're away (ai/rule-draft.ts).
import { RULES_FILE_SCHEMA_VERSION, type Condition, type ReaderAction, type RuleCard, type RulesFile, type Suggestion } from "@broadsheet/shared";
import { transaction, type Db } from "../db/db.ts";
import type { MailPort } from "./stage-a-email.ts";
import { currentProfile, ownWords } from "../ai/profile.ts";
import type { Config } from "@broadsheet/shared";

type SettingAction = Exclude<ReaderAction, { itemId: string }>;

export const OWN_WORDS_KEY = "profile:own-words";
export const OWN_WORDS_AT_KEY = "profile:own-words-at";
const DELETED_ITEMS = "deleteditems";
/** A suggestion still being drafted is shown with this id, so it can be dismissed. */
export const requestCardId = (id: number) => `request-${id}`;

const getState = (db: Db, key: string) => (db.prepare("SELECT value FROM agent_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const setState = (db: Db, key: string, value: string) => db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)").run(key, value);

/** Apply one Rules-page action. Returns false if there was nothing to apply it to. */
export async function applySetting(db: Db, mail: MailPort, a: SettingAction, now: string): Promise<boolean> {
  switch (a.type) {
    case "own-words": {
      const before = getState(db, OWN_WORDS_KEY) ?? null;
      const text = a.text.trim();
      transaction(db, () => {
        setState(db, OWN_WORDS_KEY, text);
        setState(db, OWN_WORDS_AT_KEY, a.at);
        // Gemma re-scores what's in the paper now against your new words (from its summaries; quick).
        if (text !== before) db.prepare("UPDATE items SET rescore = 1 WHERE ai_status = 'done' AND hidden_by IS NULL").run();
      });
      return true;
    }
    case "rule-add":
      db.prepare("INSERT INTO rule_requests (kind, text, created_at, updated_at) VALUES ('typed', ?, ?, ?)").run(a.text.trim(), now, now);
      return true;
    case "rule-edit": {
      const rule = db.prepare("SELECT id FROM rules WHERE id = ?").get(a.ruleId);
      if (!rule) return false;
      // A newer edit replaces one Gemma hasn't got to yet.
      db.prepare("UPDATE rule_requests SET status = 'dismissed', updated_at = ? WHERE kind = 'edit' AND rule_id = ? AND status = 'pending'").run(now, a.ruleId);
      db.prepare("INSERT INTO rule_requests (kind, rule_id, text, created_at, updated_at) VALUES ('edit', ?, ?, ?, ?)").run(a.ruleId, a.text.trim(), now, now);
      return true;
    }
    case "rule":
      return ruleOp(db, mail, a.ruleId, a.op, now);
  }
}

async function ruleOp(db: Db, mail: MailPort, ruleId: string, op: "approve" | "dismiss" | "on" | "off" | "delete", now: string): Promise<boolean> {
  const req = ruleId.match(/^request-(\d+)$/);
  if (req) {
    // A suggestion Gemma is still drafting (or couldn't draft): dismissing it is all that makes sense.
    if (op !== "dismiss" && op !== "delete") return false;
    return db.prepare("UPDATE rule_requests SET status = 'dismissed', excerpt = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')").run(now, Number(req[1])).changes > 0;
  }
  const rule = db.prepare("SELECT id, status, mail_action, preview_json FROM rules WHERE id = ?").get(ruleId) as
    | { id: string; status: string; mail_action: string | null; preview_json: string }
    | undefined;
  if (!rule) return false;

  switch (op) {
    case "approve": {
      if (rule.status !== "suggested") return false;
      db.prepare("UPDATE rules SET status = 'active', updated_at = ? WHERE id = ?").run(now, ruleId);
      await hideWhatItCatches(db, mail, rule.id, rule.mail_action, JSON.parse(rule.preview_json) as { id: string }[], now);
      return true;
    }
    case "dismiss":
    case "delete":
      transaction(db, () => {
        db.prepare("DELETE FROM rules WHERE id = ?").run(ruleId);
        db.prepare("UPDATE rule_requests SET status = 'dismissed', updated_at = ? WHERE rule_id = ? AND status = 'pending'").run(now, ruleId);
      });
      return true;
    case "on":
    case "off":
      if (rule.status === "suggested") return false;
      db.prepare("UPDATE rules SET status = ?, updated_at = ? WHERE id = ?").run(op === "on" ? "active" : "off", now, ruleId);
      return true;
  }
}

/** On approval, the rule hides the current items its preview showed (not ones you saved or showed again). */
async function hideWhatItCatches(db: Db, mail: MailPort, ruleId: string, mailAction: string | null, preview: { id: string }[], now: string) {
  const ours = new Set<string | null>([
    ...(db.prepare("SELECT mail_folder_id FROM sections").all() as { mail_folder_id: string | null }[]).map((s) => s.mail_folder_id),
    getState(db, "folder:_sorting") ?? null,
  ]);
  ours.delete(null);
  for (const { id } of preview) {
    const it = db.prepare("SELECT id, channel, message_id, mail_folder_id FROM items WHERE id = ? AND hidden_by IS NULL AND shown_anyway = 0 AND saved = 0").get(id) as any;
    if (!it) continue;
    transaction(db, () => {
      db.prepare("UPDATE items SET hidden_by = ?, hidden_at = ? WHERE id = ?").run(ruleId, now, id);
      db.prepare("INSERT OR IGNORE INTO rule_hits (rule_id, item_id, at) VALUES (?, ?, ?)").run(ruleId, id, now);
    });
    if (mailAction === "deleted-items" && it.channel === "email" && it.message_id && ours.has(it.mail_folder_id)) {
      await mail.move(it.message_id, DELETED_ITEMS).then(
        () => db.prepare("UPDATE items SET mail_folder_id = ? WHERE id = ?").run(DELETED_ITEMS, id),
        () => {}, // the item is hidden either way; the email can stay where it is
      );
    }
  }
}

// ---- rules.json for the reader ---------------------------------------------------------------------

/** A check rule's conditions in words, e.g. 'subject contains "is live" and fewer than 200 words'. */
export function describeConditions(match: string | null, conditions: Condition[]): string {
  const names: Record<string, string> = { sender: "sender", domain: "sender's domain", subject: "subject", listId: "list", body: "text", linksTo: "a link" };
  const one = (c: Condition) =>
    c.field === "wordCount"
      ? `${c.op === "lessThan" ? "fewer" : "more"} than ${c.value} words`
      : `${names[c.field]} ${c.op === "matches" ? "matches" : c.op === "equals" ? "is" : c.field === "linksTo" ? "goes to" : "contains"} "${c.value}"`;
  return conditions.map(one).join(match === "any" ? " or " : " and ");
}

export function buildRulesFile(db: Db, config: Pick<Config, "readerProfile">, now: Date): RulesFile {
  const sourceName = new Map((db.prepare("SELECT id, coalesce(display_name, id) AS name FROM sources").all() as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const hits = new Map((db.prepare("SELECT rule_id, count(*) n FROM rule_hits WHERE at >= ? GROUP BY rule_id").all(since) as { rule_id: string; n: number }[]).map((r) => [r.rule_id, r.n]));
  const redrafting = new Set((db.prepare("SELECT rule_id FROM rule_requests WHERE kind = 'edit' AND status = 'pending'").all() as { rule_id: string }[]).map((r) => r.rule_id));

  const rows = db.prepare("SELECT * FROM rules ORDER BY updated_at DESC").all() as any[];
  const detail = (r: any) => (r.kind === "instruction" ? r.instruction : describeConditions(r.match_mode, JSON.parse(r.conditions_json ?? "[]")));
  const rules: RuleCard[] = rows
    .filter((r) => r.status !== "suggested")
    .map((r) => ({
      id: r.id,
      wording: r.wording,
      kind: r.kind,
      detail: detail(r),
      source: r.source_id ? (sourceName.get(r.source_id) ?? r.source_id) : null,
      status: r.status,
      mail: r.mail_action,
      hits30d: hits.get(r.id) ?? 0,
      redrafting: redrafting.has(r.id),
    }));

  const requests = db.prepare("SELECT * FROM rule_requests ORDER BY created_at DESC").all() as any[];
  const fromOf = (q: any): Suggestion["from"] =>
    q?.kind === "hidden-item"
      ? { kind: "hidden-item", title: JSON.parse(q.facts_json ?? "{}").subject ?? "an item you hid", reason: q.reason, note: q.note }
      : { kind: "typed", text: q?.text ?? "" };
  const ready: Suggestion[] = rows
    .filter((r) => r.status === "suggested")
    .map((r) => {
      const q = requests.find((x) => x.rule_id === r.id && x.kind !== "edit");
      return {
        id: r.id,
        status: redrafting.has(r.id) ? "drafting" : "ready",
        from: fromOf(q),
        wording: r.wording,
        ruleKind: r.kind,
        detail: detail(r),
        source: r.source_id ? (sourceName.get(r.source_id) ?? r.source_id) : null,
        wouldHide: JSON.parse(r.preview_json),
        error: null,
      };
    });
  const waiting: Suggestion[] = requests
    .filter((q) => q.kind !== "edit" && (q.status === "pending" || q.status === "failed"))
    .map((q) => ({
      id: requestCardId(q.id),
      status: q.status === "pending" ? "drafting" : "failed",
      from: fromOf(q),
      wording: null,
      ruleKind: null,
      detail: null,
      source: q.source_id ? (sourceName.get(q.source_id) ?? q.source_id) : null,
      wouldHide: [],
      error: q.error,
    }));

  const learned = currentProfile(db, config);
  return {
    schemaVersion: RULES_FILE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    ownWords: { text: ownWords(db, config), updatedAt: getState(db, OWN_WORDS_AT_KEY) ?? null },
    learnedProfile: learned.from === "learned" ? { text: learned.text, builtAt: new Date(learned.builtAt!).toISOString() } : null,
    suggestions: [...ready, ...waiting],
    rules,
  };
}
