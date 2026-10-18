#!/usr/bin/env bash
# Omni Agent — console mode on macOS / Linux (the .cmd files are the Windows equivalents).
#   ./start.sh                  local only, pi works in ~/Desktop
#   ./start.sh /some/project    pi works in that folder
#   ./start.sh . --lan          also reachable from other devices on your network (token required)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD="${1:-$HOME/Desktop}"
[ "$WD" = "." ] && WD="$HOME/Desktop"
shift || true
echo "Omni Agent  (pi cwd: $WD)"
PORT="${OMNI_PORT:-4400}"
( sleep 1.5; if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT"; fi ) >/dev/null 2>&1 &
exec node "$HERE/server/index.mjs" --cwd "$WD" "$@"
