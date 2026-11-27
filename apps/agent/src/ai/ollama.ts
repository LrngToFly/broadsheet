// Checks on the local Ollama server. (The LlmProvider that calls the model arrives in M5.)

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
