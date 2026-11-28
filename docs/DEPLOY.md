# Setting up your own Broadsheet

This guide sets up your own copy: your own newsletter mailbox, your own Microsoft app registration, your own reader website and the agent on your own Mac. Nothing is shared with anyone else's copy. Allow about an hour, most of it waiting for downloads.

**You'll need**

- A Mac with Apple silicon and 16 GB of memory or more (24 GB if you use the Mac for other things too). The AI model takes about 8 GB while it works.
- A GitHub account (free).
- About 15 GB of free disk space (the AI model is about 8 GB).
- Xcode (free, from the App Store), only to build the Mac Admin app. You can skip it and manage everything from Terminal.

Steps 1 to 3 are done in a web browser, steps 4 to 6 on the Mac. `scripts/install.sh` does most of steps 4 to 6 for you.

---

## 1. A mailbox just for newsletters (10 minutes, then as you go)

1. At [outlook.com](https://outlook.com), choose **Create free account**, e.g. `yourname.newsletters@outlook.com`. The Broadsheet signs in only to this account, never to your personal mail.
2. Move your subscriptions to it:
   - **Substack:** *Settings → Account → Email*, change it to the new address. All your Substack subscriptions, paid ones included, follow.
   - **Others:** use the "manage subscription" or "update email" link at the bottom of each newsletter.
   - **Stragglers:** a temporary rule in your personal mailbox can *redirect* known newsletter senders to the new address (*Settings → Mail → Rules*, action **Redirect to**, which keeps the original sender). Remove it once everything has moved.
3. Sign in to the new account in a browser every few months: Microsoft may close free accounts that see no sign-ins for a long time.

## 2. Register the Broadsheet with Microsoft (10 minutes, once)

This gives your copy its own identity for signing in. It's free and needs no Azure subscription.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) with any personal Microsoft account (your newsletter account is fine).
2. **App registrations → New registration.** Name it "The Broadsheet". Under *Supported account types*, choose **Personal Microsoft accounts only**. Leave *Redirect URI* empty for now and click **Register**.
3. Copy the **Application (client) ID** from the overview page. You'll need it twice.
4. **Authentication → Add a platform → Single-page application.** Add these redirect URIs, replacing `<you>` with your GitHub username in lower case and `broadsheet` with your repository's name if you renamed it:
   - `https://<you>.github.io/broadsheet/redirect.html`
   - `http://localhost:5173/broadsheet/redirect.html` (only for working on the reader locally)
5. Still under **Authentication**, set **Allow public client flows** to **Yes** (the agent on your Mac signs in with a code, as a TV app would). Save.
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions:** add `Mail.ReadWrite`, `Files.ReadWrite.AppFolder`, `User.Read` and `offline_access`. No admin consent is needed for personal accounts.

The agent asks for all four. The reader asks only for `Files.ReadWrite.AppFolder` and `User.Read`: it can see only the Broadsheet's own folder in your OneDrive, nothing else.

## 3. Your reader website (5 minutes)

1. **Fork** this repository to your GitHub account (the **Fork** button at the top of its GitHub page).
2. In your fork, open the **Actions** tab and enable workflows if GitHub asks.
3. **Settings → Pages:** set *Source* to **GitHub Actions**.
4. **Settings → Secrets and variables → Actions → Variables → New repository variable:** name `ENTRA_CLIENT_ID`, value the client ID from step 2.
5. **Actions → Deploy reader to GitHub Pages → Run workflow.** In a minute or two your reader is at `https://<you>.github.io/broadsheet/`. It will say it has nothing to show until the agent's first run.

The website holds only code. Your newsletters, summaries and ratings stay in your own OneDrive and are read in the browser after you sign in.

## 4. The Mac (20 minutes, mostly downloads)

1. **Keep it awake:** *System Settings → Energy* (or *Battery → Options* on a laptop): turn on **Prevent automatic sleeping when the display is off**. The display can still sleep.
2. **Homebrew,** if you don't have it: follow [brew.sh](https://brew.sh).
3. **Get your fork** into a folder you'll keep (the agent runs from it), e.g.:
   ```bash
   mkdir -p ~/Developer && cd ~/Developer
   git clone https://github.com/<you>/broadsheet.git "The Broadsheet"
   cd "The Broadsheet"
   ```
4. **Run the install script**, with your client ID:
   ```bash
   scripts/install.sh --client-id <your client id>
   ```
   It checks the Mac, offers to install what's missing (Node, pnpm, Ollama and the Gemma model, about 8 GB, each only with your OK), then walks you through steps 5 and 6. It's safe to run again; it skips what's already done.

## 5. The agent (what the script does, if you'd rather do it by hand)

```bash
brew install node pnpm ollama
brew services start ollama              # Ollama starts at login from now on
ollama pull gemma4:12b                  # about 8 GB
pnpm install
pnpm agent init --client-id <id>        # creates ~/Library/Application Support/Broadsheet/broadsheet.config.json
pnpm agent login                        # sign in with the NEWSLETTER account (a code you enter in a browser)
pnpm agent folders --create             # creates "The Broadsheet" and its section folders in that mailbox
pnpm agent doctor                       # checks sign-in, folders, OneDrive, Ollama and the model
pnpm agent install                      # runs the agent every 15 minutes, in the background
```

`init` works out your reader's address from your fork's GitHub address (`readerUrl` in the config file). The first run collects the last few days of newsletters; Gemma reads them the next time you leave the Mac alone for 10 minutes.

## 6. Broadsheet Admin, the Mac app (5 minutes, optional)

With Xcode installed:

```bash
apps/admin/build.sh
```

It builds the app and installs it as `~/Applications/Broadsheet Admin.app`, with a newspaper icon in the menu bar. To start it with the Mac: *System Settings → General → Login Items → +*.

Everything Admin does is also a `broadsheet` command (`pnpm agent` on its own lists them).

## 7. Read it

Open `https://<you>.github.io/broadsheet/` on your iPhone or iPad, sign in with the **newsletter account**, and *Share → Add to Home Screen* to use it like an app.

Then make it yours:

- **Rules → In your own words:** a few sentences on what you want and what you don't. Gemma reads them with every article.
- **Rate** what you read (👍 👌 👎, with a "why" when you can). The order follows.
- **Sections:** Admin's Sections page renames, adds or removes them; the Outlook folders follow.
- **Newsletters:** Admin's Sources page sets a newsletter's section, splits roundups into briefs, pins one you always want, or turns one off.

## If something's wrong

- `pnpm agent doctor` checks everything and says what to fix.
- `pnpm agent status` shows the schedule and the last runs; Admin's Status and Log pages show the same.
- **"Signed out" or sign-in loops in the reader:** the redirect URI in step 2.4 must match your reader's address exactly, ending in `redirect.html`.
- **Nothing gets summarized:** Gemma works only while the Mac is idle (10 minutes by default). `pnpm agent run --force` runs it now.
- **Back up and move:** the agent backs up its database every day (`pnpm agent backups`); Admin's Data page exports everything to one file for a new Mac.
