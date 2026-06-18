#!/usr/bin/env bash
#
# smtp-login-checker — one-command launcher.
#
# Downloads the source into a temporary folder, starts the local checker, and
# opens it in your browser. Nothing is installed permanently and nothing is sent
# anywhere: the server binds to 127.0.0.1 and your credentials only ever travel
# from this machine to the mail server you test.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/dotreflection/smtp-login-checker/main/install.sh)"
#
# The temporary folder is deleted automatically when you stop the tool (Ctrl+C).

set -euo pipefail

REPO="dotreflection/smtp-login-checker"
REF="${SMTP_CHECKER_REF:-main}"

say()  { printf '  %s\n' "$1"; }
fail() { printf '\n  Error: %s\n\n' "$1" >&2; exit 1; }

# --- Prerequisites ----------------------------------------------------------
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar  >/dev/null 2>&1 || fail "tar is required."
command -v node >/dev/null 2>&1 || fail "Node.js 18+ is required. Install it from https://nodejs.org"

NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || fail "Node.js 18+ is required (found $(node -v))."

# --- Temp workspace (auto-cleaned) ------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/smtp-login-checker.XXXXXX")"
OPENER_PID=""
cleanup() {
  [ -n "$OPENER_PID" ] && kill "$OPENER_PID" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

printf '\n'
say "smtp-login-checker"
say "Downloading source into a temporary folder…"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" \
  | tar -xz -C "$TMP" --strip-components=1 \
  || fail "Could not download or extract the source."

[ -f "$TMP/server.js" ] || fail "Download looks incomplete (server.js missing)."

# --- Pick a free port (unless the user pinned one) --------------------------
if [ -z "${PORT:-}" ]; then
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
fi
URL="http://127.0.0.1:${PORT}"

# --- Open the browser once the server is up ---------------------------------
opener() {
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$URL" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if   command -v open      >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open  >/dev/null 2>&1; then xdg-open "$URL"
  else say "Open this in your browser: $URL"; fi
}
opener &
OPENER_PID=$!

say "Starting locally on ${URL}"
say "Your credentials never leave this machine. Press Ctrl+C to stop."
printf '\n'

# Note: run node as a child (not `exec`) so this shell stays alive to fire the
# cleanup trap and remove the temporary folder when you press Ctrl+C.
cd "$TMP"
PORT="$PORT" node server.js
