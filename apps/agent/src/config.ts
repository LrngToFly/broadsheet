import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Config } from "@broadsheet/shared";

export class ConfigError extends Error {}

/** Parse config text. Throws ConfigError with a readable list of problems. */
export function parseConfig(text: string, file = "config"): Config {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const r = Config.safeParse(json);
  if (!r.success) throw new ConfigError(`${file} has problems:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export async function loadConfig(file: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        `No config file at ${file}\nCopy apps/agent/config.example.json there and fill in your Entra client ID.`,
      );
    }
    throw e;
  }
  return parseConfig(text, file);
}
