#!/bin/bash
# Builds Omni Agent.app and its DMG on the Mac, from any machine with git, node and ssh (Git Bash on the PC included).
#   bash mac/build.sh [--copy-dmg-to DIR]
# It builds the UI (npm run build), sends the COMMITTED HEAD to the Mac as a git bundle (nothing is pushed anywhere), checks it out
# in ~/omni-mac-build/src, runs mac/make-app.sh there, and prints where the app and DMG are. Uncommitted changes are not included.
#
#   OMNI_MAC_SSH        ssh destination (default: macbook)
#   OMNI_MAC_SSH_OPTS   extra ssh/scp options, e.g. "-o HostName=192.168.0.35 -o HostKeyAlias=192.168.0.30"
#   OMNI_MAC_DIR        build folder in the Mac's home (default: omni-mac-build)
#   OMNI_MAC_DEVELOPER_DIR  the Xcode to use (default: the first /Applications/Xcode*.app when the selected one has no swiftc)
# On the Mac itself, `bash mac/make-app.sh` does the same without the copy.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${OMNI_MAC_SSH:-macbook}"
read -r -a OPTS <<< "${OMNI_MAC_SSH_OPTS:-}"
DIR="${OMNI_MAC_DIR:-omni-mac-build}"
COPY_TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --copy-dmg-to) COPY_TO="$2"; shift 2 ;;
    *) echo "usage: mac/build.sh [--copy-dmg-to DIR]" >&2; exit 2 ;;
  esac
done

cd "$ROOT"
echo "== the UI build"
npm run --silent build
if ! git diff --quiet -- dist/ui || [ -n "$(git ls-files --others --exclude-standard dist/ui)" ]; then
  echo "dist/ui changed: commit it first, since the Mac builds what is committed." >&2; exit 1
fi
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are not part of this build"
SHA="$(git rev-parse HEAD)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git bundle create -q "$TMP/omni.bundle" HEAD
echo "== to the Mac ($HOST): $(git log -1 --format='%h %s')"
ssh "${OPTS[@]}" "$HOST" "mkdir -p ~/$DIR"
scp -q "${OPTS[@]}" "$TMP/omni.bundle" "$HOST:$DIR/omni.bundle"

ssh -T "${OPTS[@]}" "$HOST" bash -s <<EOF
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH
cd ~/$DIR
[ -d src/.git ] || git init -q src
git -C src fetch -q ../omni.bundle HEAD
git -C src checkout -q -f --detach $SHA
git -C src clean -fdq
rm -f omni.bundle
if [ -n "${OMNI_MAC_DEVELOPER_DIR:-}" ]; then export DEVELOPER_DIR="${OMNI_MAC_DEVELOPER_DIR:-}"; fi
bash src/mac/make-app.sh ~/$DIR/out
EOF

if [ -n "$COPY_TO" ]; then
  mkdir -p "$COPY_TO"
  ssh "${OPTS[@]}" "$HOST" "cat ~/$DIR/out/'Omni Agent.dmg'" > "$COPY_TO/Omni Agent.dmg"
  echo "copied: $COPY_TO/Omni Agent.dmg"
fi
