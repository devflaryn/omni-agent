#!/bin/bash
# Builds "Omni Agent.app" and "Omni Agent.dmg" on a Mac, from this checkout. Run on the Mac (mac/build.sh runs it over SSH).
#   mac/make-app.sh [out dir]          default: ~/omni-mac-build/out
# Needs Xcode or the Command Line Tools for swiftc (DEVELOPER_DIR picks an Xcode that is not the selected one), and nothing else.
#
# The app is built in a new folder and only then moved into place. A signed binary must never be rewritten in place: macOS caches
# its signature by file and SIGKILLs the new bytes ("Code Signature Invalid") although codesign says it is fine.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$HOME/omni-mac-build/out}"
NAME="Omni Agent"
MIN_FREE_GB=4

mkdir -p "$OUT"
free_kb() { df -k "$OUT" | awk 'NR==2 {print $4}'; }
need() { # stop before a step would leave under MIN_FREE_GB free
  local kb; kb=$(free_kb)
  if (( kb - $1 * 1024 < MIN_FREE_GB * 1024 * 1024 )); then
    echo "make-app: only $((kb / 1024)) MB free; this step needs about $1 MB and must leave ${MIN_FREE_GB} GB. Stopping." >&2; exit 3
  fi
}
need 200

if [ -z "${DEVELOPER_DIR:-}" ] && ! xcrun -f swiftc >/dev/null 2>&1; then
  for x in /Applications/Xcode*.app; do [ -d "$x/Contents/Developer" ] && export DEVELOPER_DIR="$x/Contents/Developer" && break; done
fi
SWIFTC="$(xcrun -f swiftc)"

VERSION="$(plutil -extract version raw -o - "$SRC/package.json")"
BUILD="$(git -C "$SRC" rev-list --count HEAD 2>/dev/null || echo 1)"
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"

STAGE="$OUT/.staging-$$"
trap 'rm -rf "$STAGE" "$OUT/.dmg-$$" "$OUT/.old-$$" "$OUT/.tmp-$$.dmg"' EXIT
APP="$STAGE/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

echo "== compiling the shell ($("$SWIFTC" --version 2>/dev/null | head -1))"
for arch in arm64 x86_64; do
  "$SWIFTC" -O -swift-version 5 -target "$arch-apple-macos12.0" -framework AppKit -framework WebKit \
    -o "$STAGE/shell-$arch" "$SRC/mac/OmniAgent.swift"
done
lipo -create -output "$APP/Contents/MacOS/$NAME" "$STAGE/shell-arm64" "$STAGE/shell-x86_64"
rm -f "$STAGE"/shell-*

echo "== the icon"
ICONSET="$STAGE/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC/mac/AppIcon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$SRC/mac/AppIcon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$ICONSET"
rm -rf "$ICONSET"

echo "== the server and the UI build"
# The code the server runs, and the finished UI build. No node_modules: the server needs none, and without esbuild it never tries
# to rebuild the UI inside the bundle.
for d in server hub ui dist integrations scripts skills; do
  rsync -a --exclude .DS_Store "$SRC/$d" "$APP/Contents/Resources/app/"
done
mkdir -p "$APP/Contents/Resources/app/mac"
cp "$SRC/mac/launch.mjs" "$APP/Contents/Resources/app/mac/"
cp "$SRC/package.json" "$APP/Contents/Resources/app/"

sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" -e "s/__COMMIT__/$COMMIT/g" "$SRC/mac/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "== signing (ad hoc)"
codesign --force --sign - --identifier tech.tomcamp.omniagent "$APP"
codesign --verify --strict --verbose=1 "$APP"

echo "== into place"
need "$(du -sk "$APP" | awk '{print int($1/1024)*3}')"
if [ -e "$OUT/$NAME.app" ]; then mv "$OUT/$NAME.app" "$OUT/.old-$$"; fi
mv "$APP" "$OUT/$NAME.app"
rm -rf "$OUT/.old-$$"

echo "== the disk image"
DMGDIR="$OUT/.dmg-$$"
mkdir -p "$DMGDIR"
ditto "$OUT/$NAME.app" "$DMGDIR/$NAME.app"
ln -s /Applications "$DMGDIR/Applications"
hdiutil create -quiet -volname "$NAME" -srcfolder "$DMGDIR" -fs HFS+ -format UDZO -ov "$OUT/.tmp-$$.dmg"
mv -f "$OUT/.tmp-$$.dmg" "$OUT/$NAME.dmg"

echo
echo "app: $OUT/$NAME.app  ($(du -sh "$OUT/$NAME.app" | cut -f1), version $VERSION build $BUILD, $COMMIT)"
echo "dmg: $OUT/$NAME.dmg  ($(du -sh "$OUT/$NAME.dmg" | cut -f1))"
echo "free: $(( $(free_kb) / 1024 / 1024 )) GB"
