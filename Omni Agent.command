#!/usr/bin/env bash
# Double-click on macOS: starts the server hidden and opens Omni Agent in a native window.
# Optional first argument: the working directory for pi. Needs Node 22+ and `python3 -m pip install pywebview`
# (without pywebview it falls back to the default browser).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
# Prefer whichever python3 actually has pywebview (Homebrew's usually does not; python.org's often does).
PY=""
for cand in "$OMNI_PYTHON" /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 "$(command -v python3)"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if "$cand" -c "import webview" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[ -n "$PY" ] || PY="$(command -v python3 || echo /usr/bin/python3)"
exec "$PY" "$HERE/desktop/omni_desktop.pyw" "$@"
