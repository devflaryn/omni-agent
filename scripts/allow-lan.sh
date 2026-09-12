#!/usr/bin/env bash
# macOS: let the node binary accept incoming connections so other devices can reach Omni Agent with --lan.
# (Windows: scripts\allow-lan.cmd. Linux: open TCP 4400 in ufw/firewalld yourself.)
set -euo pipefail
NODE="${OMNI_NODE:-$(command -v node)}"
NODE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE")"
if [ "$(uname -s)" != "Darwin" ]; then echo "This helper is for macOS; on Linux open TCP ${1:-4400} in your firewall."; exit 1; fi
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if [ "$($FW --getglobalstate | grep -c enabled)" = "0" ]; then
  echo "The macOS application firewall is off, nothing to allow. Start with --lan and open the printed link."; exit 0
fi
echo "Allowing incoming connections for $NODE (asks for your password)…"
sudo "$FW" --add "$NODE" >/dev/null
sudo "$FW" --unblockapp "$NODE" >/dev/null
echo "Done. Start Omni Agent with --lan (or \"lan\": true in omni.config.json) and open the printed link on the other device."
