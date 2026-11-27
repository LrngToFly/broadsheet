// The local Ollama server: a health check for doctor, and the LlmProvider the agent uses.
import type { ChatMessage, ChatResult, LlmProvider } from "./provider.ts";

export type OllamaStatus =
  | { running: false; error: string }
  | { running: true; version: string; hasModel: boolean; loaded: boolean; models: string[] };

export async function ollamaStatus(baseUrl: string, model: string, doFetch: typeof fetch = fetch): Promise<OllamaStatus> {
  try {
    const get = async (path: string): Promise<any> => {
      const r = await doFetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`${path} → ${r.status}`);
      return r.json();
    };
    const [version, tags, ps] = await Promise.all([get("/api/version"), get("/api/tags"), get("/api/ps")]);
    const models: string[] = tags.models.map((m: { name: string }) => m.name);
    const same = (name: string) => name === model || name === `${model}:latest`;
    return {
      running: true,
      version: version.version,
      models,
      hasModel: models.some(same),
      loaded: ps.models.some((m: { name: string }) => same(m.name)),
    };
  } catch (e) {
    return { running: false, error: (e as Error).message };
  }
}

// ---- The provider -------------------------------------------------------------------------------------

export class OllamaProvider implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly temperature: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: { baseUrl: string; model: string; numCtx: number; temperature: number; doFetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.numCtx = opts.numCtx;
    this.temperature = opts.temperature;
    this.doFetch = opts.doFetch ?? fetch;
    this.id = `ollama:${opts.model}`;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<any> {
    const res = await this.doFetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  }

  async chat(messages: ChatMessage[], opts: { numCtx?: number } = {}): Promise<ChatResult> {
    const started = performance.now();
    const r = await this.post(
      "/api/chat",
      {
        model: this.model,
        messages,
        stream: false,
        think: false, // Phase 0: thinking was 2–6× slower with no better results
        keep_alive: "5m", // stays loaded between items of a batch; unloaded at the end
        options: { num_ctx: opts.numCtx ?? this.numCtx, temperature: this.temperature },
      },
      10 * 60_000,
    );
    return {
      text: r.message?.content ?? "",
      promptTokens: r.prompt_eval_count ?? 0,
      outputTokens: r.eval_count ?? 0,
      seconds: (performance.now() - started) / 1000,
    };
  }

  async isLoaded(): Promise<boolean> {
    const res = await this.doFetch(new URL("/api/ps", this.baseUrl), { signal: AbortSignal.timeout(5000) });
    const ps = (await res.json()) as { models: { name: string }[] };
    return ps.models.some((m) => m.name === this.model || m.name === `${this.model}:latest`);
  }

  async unload(): Promise<void> {
    await this.post("/api/generate", { model: this.model, keep_alive: 0 }, 60_000);
  }
}
