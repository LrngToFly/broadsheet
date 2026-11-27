// Read a raw email (MIME) into the facts the pipeline needs.
import { simpleParser, type AddressObject } from "mailparser";

export type ParsedEmail = {
  /** RFC 5322 Message-ID: stable for the life of the email, wherever it's moved. */
  messageId: string;
  subject: string;
  from: { name: string; address: string };
  date: Date;
  /** The List-Id header, if any, e.g. "examplewriter.substack.com". */
  listId: string | null;
  /** The List-Post header: the post's web address (Substack sets it). */
  listPost: string | null;
  hasListUnsubscribe: boolean;
  /** Lower-cased header names → values, for platform detection. */
  headers: Map<string, string>;
  html: string | null;
  text: string;
};

export async function parseEmail(mime: string | Buffer): Promise<ParsedEmail> {
  const m = await simpleParser(mime, { skipImageLinks: true, skipTextToHtml: true });
  const from = (m.from as AddressObject | undefined)?.value[0];
  const headers = new Map<string, string>();
  for (const line of m.headerLines) headers.set(line.key.toLowerCase(), line.line.slice(line.key.length + 1).replace(/\s+/g, " ").trim());
  const bracketed = (v: string | undefined) => v?.match(/<([^>]+)>/)?.[1] ?? null;
  return {
    messageId: m.messageId ?? `no-id:${m.subject}:${m.date?.toISOString()}`,
    subject: (m.subject ?? "").trim() || "(no subject)",
    from: { name: (from?.name ?? "").trim(), address: (from?.address ?? "").toLowerCase() },
    date: m.date ?? new Date(),
    listId: bracketed(headers.get("list-id"))?.toLowerCase() ?? null,
    listPost: bracketed(headers.get("list-post")),
    hasListUnsubscribe: headers.has("list-unsubscribe"),
    headers,
    html: typeof m.html === "string" ? m.html : null,
    text: m.text ?? "",
  };
}

const PLATFORMS: [string, RegExp][] = [
  ["substack", /substack\.com/],
  ["beehiiv", /beehiiv/],
  ["ghost", /ghost\.io|\bx-ghost-/],
  ["buttondown", /buttondown/],
  ["kit", /convertkit|kit-mail|\bck\.page/],
  ["mailchimp", /mcsv\.net|mailchimp|\bx-mc-user\b/],
  ["medium", /medium\.com/],
];

/** Which newsletter platform sent it, from the sender, List-Id or platform-specific header names. */
export function platformOf(e: Pick<ParsedEmail, "from" | "listId" | "headers">): string | null {
  const haystack = [e.from.address, e.listId ?? "", ...e.headers.keys()].join(" ").toLowerCase();
  for (const [name, re] of PLATFORMS) if (re.test(haystack)) return name;
  return null;
}
