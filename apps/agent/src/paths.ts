// Where the agent keeps things on the Mac. BROADSHEET_HOME overrides the data folder (used by tests).
import { homedir } from "node:os";
import { join } from "node:path";

export function paths(env: NodeJS.ProcessEnv = process.env) {
  const home = env.BROADSHEET_HOME ?? join(homedir(), "Library", "Application Support", "Broadsheet");
  return {
    home,
    config: join(home, "broadsheet.config.json"),
    db: join(home, "broadsheet.db"),
    /** Microsoft sign-in tokens, encrypted with a key kept in the Keychain. */
    tokenCache: join(home, "msal-cache.bin"),
    /** Cleaned article HTML and images while an item is current (PLAN.md §7.2). */
    content: join(home, "content"),
    /** Daily database backups (the last 7). */
    backups: join(home, "backups"),
    /** Written when the database is found damaged; Admin shows it. */
    problem: join(home, "problem.json"),
    /** broadsheet eval: the saved test set, model runs and comparison pages. */
    eval: join(home, "eval"),
    logs: env.BROADSHEET_LOGS ?? join(homedir(), "Library", "Logs", "Broadsheet"),
  };
}
export type Paths = ReturnType<typeof paths>;
