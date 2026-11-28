// A small Microsoft Graph client: auth header, JSON, paging, and polite retries.
const GRAPH = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type GraphOptions = { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch };

/** noAuth: for OneDrive's pre-authorized upload URLs, which refuse a sign-in header. */
type Init = { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean; noAuth?: boolean };

export class Graph {
  private readonly token: () => Promise<string>;
  private readonly opts: GraphOptions;

  constructor(token: () => Promise<string>, opts: GraphOptions = {}) {
    this.token = token;
    this.opts = opts;
  }

  /** Calls Graph and returns parsed JSON (or text for non-JSON replies; or the raw Response with raw: true). */
  async call<T = any>(path: string, init: Init = {}): Promise<T> {
    const url = path.startsWith("https://") ? path : GRAPH + path;
    const max = this.opts.maxAttempts ?? 4;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const doFetch = this.opts.fetch ?? fetch;

    for (let attempt = 1; ; attempt++) {
      const isJsonBody = init.body !== undefined && typeof init.body !== "string" && !(init.body instanceof Uint8Array);
      const res: Response = await doFetch(url, {
        method: init.method ?? "GET",
        headers: {
          ...(init.noAuth ? {} : { Authorization: `Bearer ${await this.token()}` }),
          ...(isJsonBody ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : isJsonBody ? JSON.stringify(init.body) : (init.body as RequestInit["body"]),
      });

      // Throttled or temporarily unavailable: wait as Graph asks (or back off) and try again.
      if ([429, 502, 503, 504].includes(res.status) && attempt < max) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        let code: string | undefined;
        let message = text;
        try {
          const err = JSON.parse(text).error;
          code = err?.code;
          message = err?.message ?? text;
        } catch {}
        throw new GraphError(res.status, code, `${init.method ?? "GET"} ${path.replace(GRAPH, "")} → ${res.status} ${code ?? ""} ${message}`.trim());
      }
      if (init.raw) return res as T;
      if (res.status === 204) return undefined as T;
      const type = res.headers.get("content-type") ?? "";
      return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
    }
  }

  /** Follows @odata.nextLink and returns every item. */
  async all<T = any>(path: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { value: T[]; "@odata.nextLink"?: string } = await this.call(next, { headers });
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out;
  }
}
