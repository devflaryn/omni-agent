#!/usr/bin/env bash
# Double-click on macOS: starts the server hidden and opens Omni Agent in a native window.
# Optional first argument: the working directory for pi. Needs Node 22+ and `python3 -m pip install pywebview`
# (without pywebview it falls back to the default browser).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
PY="$(command -v python3 || echo /Library/Frameworks/Python.framework/Versions/3.13/bin/python3)"
exec "$PY" "$HERE/desktop/omni_desktop.pyw" "$@"
