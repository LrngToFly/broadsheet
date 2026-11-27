# Phase 1 — Prototype (Gemma)

Goal (from [PLAN.md §11](../PLAN.md#11-phased-delivery)): today's newsletters appear summarized on your phone and filed in Outlook, without you noticing the Mac working.

Phase 1 is built in milestones. Each one ends with something you can run.

| # | Milestone | You can… | Status |
|---|---|---|---|
| M1 | **Foundations:** pnpm monorepo, shared schemas (config, edition, AI output, rules), agent config file, SQLite database | run `broadsheet init` and `broadsheet doctor` to create and check your config file and database | ✅ done |
| M2 | **Sign-in and Graph:** device-code login, tokens saved encrypted with the key in the Keychain, mail and OneDrive clients, `broadsheet doctor` checks sign-in, folders, OneDrive and Ollama | run `broadsheet login` and `broadsheet doctor` | ✅ done |
| M3 | **Stage A, email:** fetch new Inbox and `_Add` mail, include/skip/hide decisions (account mail, muted sources, Check rules), move to `_Sorting` or a fixed section, content cleanup, seen IDs, `broadsheet run --stage a [--dry-run]` | watch new newsletters move out of the Inbox | ✅ done |
| M4 | **Stage A, feeds and publishing:** follow feeds from the config file, polling, best version, image caching, `edition.json` + item files in OneDrive with "summary pending" | see items appear in OneDrive within minutes | ✅ done |
| M5 | **Stage B, Gemma:** idle gating, enrichment with validation and retry, Instruction rules, filing from `_Sorting`, first-cut ranking, retention pruning, `status.json`, `broadsheet run [--stage a\|b] [--force]` | see summaries and sections fill in while you're away | ✅ done |
| M6 | **Reader PWA:** React reader replacing the sign-in spike: Front Page, section tabs, item cards, full article view, offline cache | read the Broadsheet on your iPhone | next |
| M7 | **Running on its own:** launchd LaunchAgent at background priority every 15 minutes, logs, install/uninstall commands | forget about it | |

Not in Phase 1 (Phase 2+): ratings, Move to section, Save, Don't show things like this, the Rules page, personalization, the Admin app.

## Configuration in Phase 1

Until the Admin app exists, sources, rules, sections and settings come from one JSON file:

```
~/Library/Application Support/Broadsheet/broadsheet.config.json
```

Start from [`config.example.json`](../apps/agent/config.example.json). To follow a blog by URL, preview it first with `broadsheet feed-check <url>`, then add it to `sources`. The file stays on your Mac and is never committed. The agent reads it on every run and copies it into the SQLite database, so switching to the Admin app later loses nothing.
