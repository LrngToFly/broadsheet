#!/bin/zsh
# Set up the Broadsheet on this Mac (docs/DEPLOY.md, steps 4 to 6). Safe to run again: it skips what's done.
#
#   scripts/install.sh --client-id <id>   set up everything, asking before each download or install
#   scripts/install.sh --check            only check, and say what it would do; changes nothing
#   scripts/install.sh --yes              answer yes to every question (for a second run, say)
#   scripts/install.sh --no-admin         skip building the Admin app
set -euo pipefail
cd "$(dirname "$0")/.."

CLIENT_ID=""
CHECK=0
YES=0
ADMIN=1
MODEL="gemma4:12b"
HOME_DIR="$HOME/Library/Application Support/Broadsheet"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-id) CLIENT_ID="${2:-}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --yes) YES=1; shift ;;
    --no-admin) ADMIN=0; shift ;;
    *) echo "Unknown option: $1 (see the top of this script)"; exit 1 ;;
  esac
done

ok()    { print -P "  %F{green}✓%f $1"; }
todo()  { print -P "  %F{yellow}•%f $1"; }
bad()   { print -P "  %F{red}✗%f $1"; }
step()  { print -P "\n%B$1%b"; }
# ask "Install Node?" → true for yes. In --check mode it only reports.
ask() {
  if (( CHECK )); then todo "would ask: $1"; return 1; fi
  if (( YES )); then return 0; fi
  read -r "reply?  $1 [y/N] "
  [[ "$reply" == [yY]* ]]
}
run() { if (( CHECK )); then todo "would run: $*"; else "$@"; fi; }

step "1. This Mac"
if [[ "$(uname -m)" == "arm64" ]]; then ok "Apple silicon"; else bad "This isn't an Apple silicon Mac: Gemma would be too slow. Stopping."; exit 1; fi
MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if (( MEM_GB >= 16 )); then ok "${MEM_GB} GB of memory"; else bad "${MEM_GB} GB of memory: 16 GB or more is needed for the AI model."; exit 1; fi
FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
if (( FREE_GB >= 15 )); then ok "${FREE_GB} GB free on disk"; else todo "Only ${FREE_GB} GB free: the AI model needs about 8 GB."; fi

step "2. Tools"
if command -v brew >/dev/null; then ok "Homebrew"; else
  bad "Homebrew isn't installed. Install it from https://brew.sh, then run this again."; exit 1
fi
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if (( ${NODE_MAJOR:-0} >= 26 )); then ok "Node $(node -v)"; else
  todo "Node 26 or newer is needed (found: $(node -v 2>/dev/null || echo none))"
  if ask "Install Node with Homebrew?"; then brew install node; fi
fi
if command -v pnpm >/dev/null; then ok "pnpm $(pnpm -v)"; else
  todo "pnpm isn't installed"
  if ask "Install pnpm with Homebrew?"; then brew install pnpm; fi
fi
if command -v ollama >/dev/null; then ok "Ollama"; else
  todo "Ollama (runs the AI model on this Mac) isn't installed"
  if ask "Install Ollama with Homebrew?"; then brew install ollama; fi
fi
if command -v ollama >/dev/null; then
  if curl -fs http://127.0.0.1:11434/api/version >/dev/null; then ok "Ollama is running"; else
    todo "Ollama isn't running"
    if ask "Start Ollama now and at every login (brew services)?"; then brew services start ollama; sleep 3; fi
  fi
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"; then ok "The $MODEL model"; else
    todo "The $MODEL model isn't downloaded (about 8 GB)"
    if ask "Download $MODEL now?"; then ollama pull "$MODEL"; fi
  fi
fi

step "3. The agent"
if [[ -d node_modules ]]; then ok "Packages installed"; else todo "Packages aren't installed"; run pnpm install; fi
if [[ -f "$HOME_DIR/broadsheet.config.json" ]]; then ok "Config file: $HOME_DIR/broadsheet.config.json"; else
  if [[ -z "$CLIENT_ID" ]] && (( ! CHECK )); then read -r "CLIENT_ID?  Your Microsoft app's client ID (docs/DEPLOY.md step 2): "; fi
  if [[ -z "$CLIENT_ID" ]] && (( CHECK )); then todo "would create the config file (needs --client-id)"; else run pnpm -s agent init --client-id "$CLIENT_ID"; fi
fi
if [[ -f "$HOME_DIR/msal-cache.bin" ]]; then ok "Signed in"; else
  todo "Not signed in yet: sign in with the NEWSLETTER account, not your personal one"
  run pnpm -s agent login
fi
run pnpm -s agent folders --create
step "4. Checking everything"
if (( CHECK )); then pnpm -s agent doctor || true; else pnpm -s agent doctor || { bad "Fix what doctor reports, then run this again."; exit 1; }; fi
if [[ -f "$HOME/Library/LaunchAgents/com.thebroadsheet.agent.plist" ]]; then ok "Scheduled every 15 minutes"; else
  todo "Not scheduled yet"
  if ask "Run the agent every 15 minutes in the background?"; then pnpm -s agent install; fi
fi

if (( ADMIN )); then
  step "5. Broadsheet Admin (the Mac app)"
  if [[ -d "$HOME/Applications/Broadsheet Admin.app" ]]; then ok "Installed; apps/admin/build.sh rebuilds it"
  elif [[ -d /Applications/Xcode.app ]]; then
    todo "Not installed"
    if ask "Build and install Broadsheet Admin (uses Xcode)?"; then apps/admin/build.sh; fi
  else todo "Xcode isn't installed: Admin is optional; everything it does is also a command (pnpm agent)"; fi
fi

READER=$(sed -nE 's/.*"readerUrl": *"([^"]+)".*/\1/p' "$HOME_DIR/broadsheet.config.json" 2>/dev/null || true)
print -P "\n%BDone.%b ${CHECK:+(check only: nothing was changed)}"
[[ -n "$READER" ]] && echo "Your reader: $READER (sign in with the newsletter account; Share → Add to Home Screen on iPhone)."
echo "Gemma reads new newsletters the next time you leave the Mac alone for 10 minutes."
