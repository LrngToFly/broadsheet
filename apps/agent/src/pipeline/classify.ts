// What to do with one email (PLAN.md §3.2, §3.6 step 3 and §4.3). A pure function: no I/O, easy to test.
import type { Condition } from "@broadsheet/shared";

export type EmailFacts = {
  sender: string; // lower-case address
  senderName: string;
  subject: string;
  listId: string | null;
  hasListUnsubscribe: boolean;
  platform: string | null;
  text: string;
  wordCount: number;
  links: string[];
  /** It was dropped into the _Add folder: always include it. */
  fromAddFolder: boolean;
};

export type SourceRow = {
  id: string;
  match: { sender?: string; domain?: string; listId?: string } | null;
  status: "new" | "enabled" | "muted";
  fixedSectionId: string | null;
};

export type RuleRow =
  | { id: string; kind: "check"; match: "all" | "any"; conditions: Condition[]; sourceId: string | null; mail: "deleted-items" | "leave" }
  | { id: string; kind: "include"; match: "all" | "any"; conditions: Condition[]; sourceId: string | null; sectionId: string | null };

export type Decision =
  | { action: "include"; sectionId: string | null; sectionFrom: "fixed" | null; why: string }
  | { action: "skip"; why: string }
  | { action: "hide"; ruleId: string; mail: "deleted-items" | "leave"; why: string };

export const domainOf = (address: string) => address.split("@")[1] ?? "";

// ---- Source matching -------------------------------------------------------------------------------

/** The configured or known source for this sender: exact sender first, then List-Id, then domain. */
export function matchSource(f: Pick<EmailFacts, "sender" | "listId">, sources: SourceRow[]): SourceRow | null {
  const domain = domainOf(f.sender);
  return (
    sources.find((s) => s.match?.sender?.toLowerCase() === f.sender) ??
    (f.listId ? sources.find((s) => s.match?.listId?.toLowerCase() === f.listId) : undefined) ??
    sources.find((s) => s.match?.domain && (domain === s.match.domain.toLowerCase() || domain.endsWith(`.${s.match.domain.toLowerCase()}`))) ??
    null
  );
}

/** A new source for a sender seen for the first time (dedicated mode). */
export function newSourceFor(f: Pick<EmailFacts, "sender" | "senderName" | "listId">, takenIds: Set<string>) {
  const base = slug(f.listId?.endsWith(".substack.com") ? f.listId.split(".")[0]! : (f.listId ?? f.sender.replace("@", "-at-"))) || "source";
  let id = base;
  for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
  const { publication } = splitSenderName(f.senderName);
  return {
    id,
    displayName: publication || f.senderName || f.sender,
    match: f.listId ? { listId: f.listId } : { sender: f.sender },
  };
}

/** Substack sends as "Author from Publication". */
export function splitSenderName(name: string): { author: string | null; publication: string } {
  const m = name.match(/^(.+?) from (.+)$/);
  return m ? { author: m[1]!.trim(), publication: m[2]!.trim() } : { author: null, publication: name.trim() };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// ---- Account and transactional mail ---------------------------------------------------------------

const ACCOUNT_SENDERS = /@(accountprotection\.microsoft\.com|account\.microsoft\.com|microsoft\.com|outlook\.com|email\.microsoftonline\.com)$/;

const TRANSACTIONAL_SUBJECT = new RegExp(
  [
    String.raw`\b(log ?in|sign ?in|magic) (link|code)\b`,
    String.raw`\bverification code\b`,
    String.raw`\bverify your (email|account)\b`,
    String.raw`\bconfirm your (email|subscription|account)\b`,
    String.raw`\b(reset your password|password reset)\b`,
    String.raw`\bsecurity (alert|code|notice)\b`,
    String.raw`\breceipt\b`,
    String.raw`\b(payment|order) (received|confirmation|confirmed|failed)\b`,
    String.raw`\byour (order|invoice)\b`,
    String.raw`\bsubscription (confirmed|receipt|renewal|cancel)`,
    String.raw`\bthank(s| you) for (subscribing|signing up|joining|your (order|purchase|payment|subscription))\b`,
    String.raw`^welcome to\b`,
  ].join("|"),
  "i",
);

/** Account or transactional mail is left in the Inbox (PLAN.md §3.2). Returns the reason, or null. */
export function accountMailReason(f: EmailFacts): string | null {
  if (ACCOUNT_SENDERS.test(f.sender)) return "Microsoft account email";
  if (TRANSACTIONAL_SUBJECT.test(f.subject) && f.wordCount < 600) return "sign-in, receipt or welcome email";
  return null;
}

// ---- Rules ----------------------------------------------------------------------------------------

export function conditionMatches(c: Condition, f: EmailFacts): boolean {
  if (c.field === "wordCount") return c.op === "lessThan" ? f.wordCount < c.value : f.wordCount > c.value;
  const values: string[] = {
    sender: [f.sender],
    domain: [domainOf(f.sender)],
    subject: [f.subject],
    listId: f.listId ? [f.listId] : [],
    body: [f.text],
    linksTo: f.links,
  }[c.field];
  const want = c.value.toLowerCase();
  return values.some((v) => {
    const have = v.toLowerCase();
    if (c.op === "equals") return have === want;
    if (c.op === "contains") return have.includes(want);
    return new RegExp(c.value, "i").test(v);
  });
}

export function ruleMatches(r: { match: "all" | "any"; conditions: Condition[]; sourceId: string | null }, f: EmailFacts, sourceId: string | null): boolean {
  if (r.sourceId && r.sourceId !== sourceId) return false;
  return r.match === "all" ? r.conditions.every((c) => conditionMatches(c, f)) : r.conditions.some((c) => conditionMatches(c, f));
}

// ---- The decision ---------------------------------------------------------------------------------

export function classify(f: EmailFacts, ctx: { mode: "dedicated" | "shared"; source: SourceRow | null; rules: RuleRow[] }): Decision {
  const { source, rules } = ctx;
  let includeRuleSection: string | null = null;

  if (!f.fromAddFolder) {
    const account = accountMailReason(f);
    if (account) return { action: "skip", why: account };
    if (source?.status === "muted") return { action: "skip", why: `source "${source.id}" is turned off` };
    if (ctx.mode === "shared") {
      const inc = rules.find((r) => r.kind === "include" && ruleMatches(r, f, source?.id ?? null));
      if (!inc) return { action: "skip", why: "no include rule matches (shared mailbox mode)" };
      if (inc.kind === "include") includeRuleSection = inc.sectionId;
    }
    for (const r of rules) {
      if (r.kind === "check" && ruleMatches(r, f, source?.id ?? null)) {
        return { action: "hide", ruleId: r.id, mail: r.mail, why: `rule "${r.id}"` };
      }
    }
  }

  const fixed = source?.fixedSectionId ?? includeRuleSection;
  return fixed
    ? { action: "include", sectionId: fixed, sectionFrom: "fixed", why: f.fromAddFolder ? "dropped in _Add" : "fixed section" }
    : { action: "include", sectionId: null, sectionFrom: null, why: f.fromAddFolder ? "dropped in _Add" : "newsletter" };
}
