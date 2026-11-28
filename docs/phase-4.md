# Phase 4 — Ready to share

Goal (from [PLAN.md §10](../PLAN.md#10-phased-delivery)): someone else can set up their own copy of the Broadsheet from the docs alone, on their own Mac, Microsoft account and GitHub, with nothing of anyone else's in it.

| # | Milestone | Someone else can… | Status |
|---|---|---|---|
| S1 | **Nothing tied to one copy:** the reader's address comes from the config file (set by `broadsheet init` from the fork's GitHub address), not the code; an audit for anything else specific to the original copy | run it without editing code | built |
| S2 | **The setup guide** ([docs/DEPLOY.md](DEPLOY.md)): the newsletter account, the Microsoft app registration (with the right sign-in addresses), the fork and GitHub Pages, the Mac, the agent, Admin; checked against what the code does | follow it step by step | built |
| S3 | **The install script** (`scripts/install.sh`): checks the Mac (Apple silicon, memory, Node, pnpm, Ollama and the model, Xcode), installs what's missing with your OK, then runs `init`, `login`, `folders --create`, `doctor`, `install` and builds Admin. Safe to run again | set up the Mac in one command | built |
| S4 | **A first-install scan** (`broadsheet backfill --days N`, PLAN.md §12 question 11): file the newsletter account's older Inbox mail into section folders and create its sources, without putting old mail in the paper | start with a tidy mailbox | |
| S5 | **`doctor` as the setup checker:** also checks the schedule, the reader's address, backups and Admin, and says what to do about each problem | find what's wrong without help | |

## S1 to S3 (2026-11-28)

- **The audit** found one thing tied to the original copy: Admin's "Open the Broadsheet" pointed at that copy's reader. It now comes from `readerUrl` in the config file, which `broadsheet init` works out from the fork's GitHub address (`github.com/<owner>/<repo>` → `https://<owner>.github.io/<repo>/`), or `--reader-url` sets. Two features had been written around the original copy's own newsletters: the cartoon of the day is now a per-newsletter setting (**Show its cartoon of the day**, `broadsheet source <id> --cartoon`, migration 16), like **Always show its newest post**, and the docs, tests and code comments now use made-up newsletters throughout. Everything else was already per copy: the reader's web address follows the repository's name, and the Microsoft app's client ID comes from each person's GitHub variable and config file.
- **The guide**, [docs/DEPLOY.md](DEPLOY.md), replaces the draft in PLAN.md §11, which had the wrong sign-in address (the reader signs in through `…/redirect.html`) and an install step the agent doesn't do (it runs from the cloned folder).
- **`scripts/install.sh`** checks the Mac (Apple silicon, 16 GB or more, disk space), the tools (Homebrew, Node 26, pnpm, Ollama running, the Gemma model) and the agent (packages, config, sign-in, folders, `doctor`, the schedule, Admin). It asks before each install or download, skips what's done, and `--check` only reports. On the original Mac, `--check` passed everything and caught that macOS was set to sleep after a minute of idle time.

