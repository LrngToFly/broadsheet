#!/bin/zsh
# Build Broadsheet Admin and install it as ~/Applications/Broadsheet Admin.app (docs/phase-3.md).
#   ./build.sh          build and install
#   ./build.sh --test   run the tests only
set -euo pipefail
cd "$(dirname "$0")"
# Use Xcode's tools whatever `xcode-select` points at (the Command Line Tools lack the full SDK and test tools).
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ "${1:-}" == "--test" ]]; then
  exec swift test
fi

swift build -c release
BIN="$(swift build -c release --show-bin-path)/BroadsheetAdmin"

APP="$HOME/Applications/Broadsheet Admin.app"
STAGE="$(mktemp -d)/Broadsheet Admin.app"
mkdir -p "$STAGE/Contents/MacOS"
cp "$BIN" "$STAGE/Contents/MacOS/BroadsheetAdmin"
cp Info.plist "$STAGE/Contents/Info.plist"
# Signed for this Mac only ("ad hoc"): enough to run your own build without Gatekeeper prompts.
codesign --force --sign - "$STAGE"

# Quit a running copy, swap in the new one, and start it.
osascript -e 'tell application id "com.thebroadsheet.admin" to quit' 2>/dev/null || true
mkdir -p "$HOME/Applications"
rm -rf "$APP"
mv "$STAGE" "$APP"
echo "Installed: $APP"
if [[ "${1:-}" != "--no-open" ]]; then open "$APP"; fi
