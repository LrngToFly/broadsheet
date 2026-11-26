// Phase 0 spike (d): can Gemma 4 12B (via Ollama) summarize real newsletters well and fast enough?
// Reads the .eml files exported by `node mail/mail.ts export`, asks Gemma for structured output
// with thinking OFF and ON, measures time/tokens/memory, and writes an HTML report to judge.
//
// Usage (from the spikes folder):  node gemma/gemma.ts [--modes off,on] [--limit N]

import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MAIL_DIR = join(here, "..", "mail", "out");
const OUT_DIR = join(here, "out");
const OLLAMA = "http://localhost:11434";
const MODEL = process.env.MODEL ?? "gemma4:12b";
const NUM_CTX = 16384;

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const MODES = arg("--modes", "off,on").split(",") as ("off" | "on")[];
const LIMIT = Number(arg("--limit", "20"));

const SECTIONS = ["Current Events", "Financial & Retirement", "Technology", "Gardening", "Outdoors", "Everything Else"];

const READER_PROFILE = `The reader is a retired-minded software engineer interested in: current events and politics,
financial and retirement planning (markets, investing, withdrawal strategy), technology, gardening,
and backpacking/outdoor activities. Prefers substantive analysis over hype, sales pitches or clickbait.`;

// JSON schema handed to Ollama's `format` parameter: the model must return exactly this shape.
const SCHEMA = {
  type: "object",
  properties: {
    is_article: { type: "boolean", description: "false for promotions, receipts, sign-in links, welcome or thank-you notes with no real content" },
    summary: { type: "string", description: "3-5 sentence neutral summary" },
    key_points: { type: "array", items: { type: "string" }, maxItems: 5 },
    section: { type: "string", enum: SECTIONS },
    tags: { type: "array", items: { type: "string" }, maxItems: 6 },
    interest: { type: "integer", minimum: 0, maximum: 100, description: "how likely this reader wants to read it" },
    why_its_here: { type: "string", description: "one short line explaining the interest score to the reader" },
    read_minutes: { type: "integer", minimum: 1 },
  },
  required: ["is_article", "summary", "key_points", "section", "tags", "interest", "why_its_here", "read_minutes"],
  additionalProperties: false,
};

const SYSTEM = `You are the editor of "The Broadsheet", a private newspaper built from one reader's newsletters.
For the newsletter you are given, reply with ONLY a JSON object (no prose, no code fence) matching this JSON Schema:
${JSON.stringify(SCHEMA)}
Be accurate and neutral; never invent facts that are not in the text. Choose the single best section.
Score interest against this reader profile:
${READER_PROFILE}`;

// This Ollama build can't enforce a schema for gemma4 (nvfp4 weights), so we extract + validate in code
// and retry once with the validation error. The real agent will do the same with a Zod schema.
function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(body);
}

function validate(d: any): string | null {
  if (typeof d !== "object" || d === null) return "not an object";
  for (const k of SCHEMA.required) if (!(k in d)) return `missing "${k}"`;
  if (typeof d.is_article !== "boolean") return "is_article must be boolean";
  if (typeof d.summary !== "string" || d.summary.length < 20) return "summary too short";
  if (!SECTIONS.includes(d.section)) return `section must be one of ${SECTIONS.join(", ")}`;
  if (!Array.isArray(d.key_points) || !Array.isArray(d.tags)) return "key_points and tags must be arrays";
  if (!Number.isInteger(d.interest) || d.interest < 0 || d.interest > 100) return "interest must be an integer 0-100";
  if (!Number.isInteger(d.read_minutes) || d.read_minutes < 1) return "read_minutes must be a positive integer";
  return null;
}

type Result = {
  mode: "off" | "on";
  ok: boolean;
  error?: string;
  data?: any;
  seconds: number;
  loadSeconds: number;
  promptTokens: number;
  outputTokens: number;
  tokPerSec: number;
  thinkingChars: number;
  attempts: number;
};

async function ollama(path: string, body?: unknown) {
  const res = await fetch(OLLAMA + path, body ? { method: "POST", body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const loadedModels = async () => ((await ollama("/api/ps")).models ?? []) as any[];

function toText(parsed: any): string {
  const html = parsed.html || "";
  const text = html
    ? convert(html, {
        wordwrap: false,
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "a", options: { ignoreHref: true } },
          { selector: "table", format: "block" },
        ],
      })
    : parsed.text || "";
  // Drop typical newsletter footer boilerplate after the unsubscribe/manage-subscription line.
  const cut = text.search(/\n.*(unsubscribe|manage your subscription|you're on the free list)/i);
  return (cut > 500 ? text.slice(0, cut) : text).replace(/\n{3,}/g, "\n\n").trim();
}

async function summarize(text: string, subject: string, from: string, mode: "off" | "on"): Promise<Result> {
  const started = Date.now();
  const messages: any[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `From: ${from}\nSubject: ${subject}\n\n${text}` },
  ];
  const totals = { load: 0, prompt: 0, out: 0, evalNs: 0, thinking: 0 };
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await ollama("/api/chat", {
        model: MODEL, stream: false, think: mode === "on", keep_alive: "5m",
        options: { num_ctx: NUM_CTX, temperature: 0.2 },
        messages,
      });
      totals.load += r.load_duration ?? 0;
      totals.prompt += r.prompt_eval_count ?? 0;
      totals.out += r.eval_count ?? 0;
      totals.evalNs += r.eval_duration ?? 0;
      totals.thinking += (r.message?.thinking ?? "").length;
      const raw = r.message?.content ?? "";
      let data: any;
      try { data = extractJson(raw); lastError = validate(data) ?? ""; }
      catch { lastError = "not valid JSON"; }
      const base = {
        mode, seconds: (Date.now() - started) / 1000, loadSeconds: totals.load / 1e9,
        promptTokens: totals.prompt, outputTokens: totals.out,
        tokPerSec: totals.evalNs ? totals.out / (totals.evalNs / 1e9) : 0, thinkingChars: totals.thinking, attempts: attempt,
      };
      if (!lastError) return { ...base, ok: true, data };
      messages.push({ role: "assistant", content: raw }, { role: "user", content: `That reply was invalid (${lastError}). Reply again with ONLY the corrected JSON object.` });
      if (attempt === 2) return { ...base, ok: false, error: lastError };
    } catch (e: any) {
      lastError = e.message;
    }
  }
  return { mode, ok: false, error: lastError, seconds: (Date.now() - started) / 1000, loadSeconds: 0, promptTokens: 0, outputTokens: 0, tokPerSec: 0, thinkingChars: 0, attempts: 2 };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function report(rows: any[], memGB: number | null): string {
  const cards = rows.map((row) => {
    const cols = row.results.map((r: Result) => `
      <div class="col">
        <h4>Thinking ${r.mode.toUpperCase()} · ${r.seconds.toFixed(1)}s · ${r.outputTokens} tok @ ${r.tokPerSec.toFixed(1)}/s${r.loadSeconds > 1 ? ` · load ${r.loadSeconds.toFixed(1)}s` : ""}${r.attempts > 1 ? " · retried" : ""}</h4>
        ${r.ok ? `
        <p class="meta"><b>${esc(r.data.section)}</b> · interest <b>${esc(r.data.interest)}</b> · ${esc(r.data.read_minutes)} min · ${r.data.is_article ? "article" : "<span class=warn>not an article</span>"}</p>
        <p>${esc(r.data.summary)}</p>
        <ul>${(r.data.key_points ?? []).map((k: string) => `<li>${esc(k)}</li>`).join("")}</ul>
        <p class="why">Why it's here: ${esc(r.data.why_its_here)}</p>
        <p class="tags">${(r.data.tags ?? []).map((t: string) => `<span>${esc(t)}</span>`).join(" ")}</p>`
        : `<p class="warn">${esc(r.error)}</p>`}
      </div>`).join("");
    return `<section><h3>${esc(row.subject)}</h3><p class="meta">${esc(row.from)} · ${row.chars.toLocaleString()} characters of text · ${row.results[0]?.promptTokens ?? "?"} input tokens</p><div class="cols">${cols}</div></section>`;
  }).join("");
  const stat = (mode: string) => {
    const rs = rows.flatMap((r) => r.results).filter((r: Result) => r.mode === mode && r.ok);
    if (!rs.length) return "";
    const avg = (f: (r: Result) => number) => (rs.reduce((a: number, r: Result) => a + f(r), 0) / rs.length).toFixed(1);
    return `<li>Thinking <b>${mode}</b>: avg ${avg((r) => r.seconds)} s per newsletter, ${avg((r) => r.outputTokens)} output tokens, ${avg((r) => r.tokPerSec)} tok/s, ${rs.length}/${rows.length} valid JSON</li>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gemma newsletter test</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#222}
@media (prefers-color-scheme: dark){body{background:#1b1b1d;color:#ddd}section{border-color:#333!important}.tags span{background:#333!important}}
h1{margin-bottom:.2rem} section{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:1.5rem} h3{margin:.2rem 0} h4{margin:.5rem 0;font-size:.85rem;color:#888}
.meta{color:#888;font-size:.85rem;margin:.2rem 0} .why{font-style:italic} .warn{color:#c0392b} .tags span{background:#eee;border-radius:4px;padding:1px 6px;font-size:.8rem}
</style></head><body>
<h1>Gemma newsletter test</h1>
<p class="meta">Model ${MODEL} · context ${NUM_CTX} · ${new Date().toLocaleString()}${memGB ? ` · model memory while loaded: ${memGB.toFixed(1)} GB` : ""}</p>
<ul>${MODES.map(stat).join("")}</ul>
${cards}</body></html>`;
}

// ---- main ----
const files = (await readdir(MAIL_DIR)).filter((f) => f.endsWith(".eml")).sort().slice(0, LIMIT);
if (!files.length) throw new Error(`No .eml files in ${MAIL_DIR}. Run: node mail/mail.ts export 20`);

const wasLoaded = (await loadedModels()).some((m) => m.name === MODEL || m.model === MODEL);
let memGB: number | null = null;
const rows: any[] = [];

for (const f of files) {
  const parsed = await simpleParser(await readFile(join(MAIL_DIR, f)));
  const subject = parsed.subject ?? "(no subject)";
  const from = parsed.from?.text ?? "";
  const text = toText(parsed);
  const row: any = { file: f, subject, from, chars: text.length, results: [] };
  for (const mode of MODES) {
    process.stdout.write(`${f} thinking ${mode}… `);
    const r = await summarize(text, subject, from, mode);
    console.log(r.ok ? `${r.seconds.toFixed(1)}s, ${r.outputTokens} tok, section=${r.data.section}, interest=${r.data.interest}` : `FAILED: ${r.error}`);
    row.results.push(r);
    if (memGB === null) {
      const m = (await loadedModels()).find((m) => m.name === MODEL || m.model === MODEL);
      if (m) memGB = (m.size ?? 0) / 1024 ** 3;
    }
  }
  rows.push(row);
}

// Unload only if this run loaded the model (never disturb someone else's session).
if (!wasLoaded) await ollama("/api/generate", { model: MODEL, keep_alive: 0 });

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "results.json"), JSON.stringify(rows, null, 2));
await writeFile(join(OUT_DIR, "report.html"), report(rows, memGB));
console.log(`\nModel memory while loaded: ${memGB?.toFixed(1)} GB. ${wasLoaded ? "Left loaded (was already loaded)." : "Unloaded."}`);
console.log(`Report: ${join(OUT_DIR, "report.html")}`);
