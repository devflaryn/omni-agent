#!/usr/bin/env bash
# Builds the iPhone app on the Mac over SSH, from any machine with git, node and ssh (Git Bash on the PC included), and installs it.
# Run it from anywhere in the repository:
#
#   bash ios/build.sh              Release build, signed with the free Apple ID, installed on the iPhone and opened. This is the
#                                  7-day reinstall: run it again whenever the app stops opening.
#   bash ios/build.sh sim          Debug build for the simulator; prints where the .app is on the Mac
#   bash ios/build.sh test         The unit tests (OmniAgentTests) on a throwaway simulator, deleted afterwards
#   bash ios/build.sh debug-device A debug build on the iPhone (for a test hub: see docs/accounts.md, "The iPhone app")
#
# It builds the UI (npm run build), sends the COMMITTED HEAD to the Mac as a git bundle (nothing is pushed anywhere), checks it out in
# ~/omni-ios-build/src and builds there; DerivedData is ~/omni-ios-build/dd. Uncommitted changes are not included.
#
# Signing: the signing key is in the Mac's login keychain, which an SSH session sees locked. So the device build runs as a one-off
# job in the session of whoever is logged in at the Mac, where the keychain is already open; nothing asks for a password. If nobody
# is logged in at the Mac, log in there first. Xcode must have the Apple ID signed in (Xcode > Settings > Accounts), once.
#
#   OMNI_MAC_SSH       ssh destination (default: macbook)
#   OMNI_MAC_SSH_OPTS  extra ssh/scp options, e.g. "-o HostName=192.168.0.35 -o HostKeyAlias=192.168.0.30"
#   OMNI_IPHONE        the iPhone's UDID (default: the owner's iPhone 11)
#   OMNI_XCODE         the Xcode to use (default: /Applications/Xcode-27.1.0.app)
#   OMNI_IOS_TEAM      the signing team (default: the free team ZSGGNXRGCM)
# Nothing here uses sudo or xcode-select.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${OMNI_MAC_SSH:-macbook}"
read -r -a OPTS <<< "${OMNI_MAC_SSH_OPTS:-}"
IPHONE="${OMNI_IPHONE:-00008030-001069DE1AA2202E}"
XCODE="${OMNI_XCODE:-/Applications/Xcode-27.1.0.app}"
TEAM="${OMNI_IOS_TEAM:-ZSGGNXRGCM}"
BUNDLE_ID=tech.tomcamp.omniagent
MODE="${1:-device}"
case "$MODE" in device|debug-device|sim|test) ;; *) echo "usage: ios/build.sh [device|debug-device|sim|test]" >&2; exit 2 ;; esac

mac() { ssh -T "${OPTS[@]}" "$HOST" "$@"; }

cd "$ROOT"
echo "== the UI build"
npm run --silent build
if ! git diff --quiet -- dist/ui || [ -n "$(git ls-files --others --exclude-standard dist/ui)" ]; then
  echo "dist/ui changed: commit it first, since the Mac builds what is committed." >&2; exit 1
fi
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are not part of this build"
SHA="$(git rev-parse HEAD)"

free_kb=$(mac "df -k / | tail -1 | awk '{print \$4}'")
echo "== the Mac has $((free_kb / 1024 / 1024)) GB free"
[ "$free_kb" -gt $((4 * 1024 * 1024)) ] || { echo "under 4 GB free on the Mac: stopping" >&2; exit 3; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git bundle create -q "$TMP/omni.bundle" HEAD
echo "== to the Mac ($HOST): $(git log -1 --format='%h %s')"
mac "mkdir -p ~/omni-ios-build"
scp -q "${OPTS[@]}" "$TMP/omni.bundle" "$HOST:omni-ios-build/omni.bundle"
mac bash -s <<EOF
set -euo pipefail
cd ~/omni-ios-build
[ -d src/.git ] || git init -q src
git -C src fetch -q ../omni.bundle HEAD
git -C src checkout -q -f --detach $SHA
git -C src clean -fdxq
rm -f omni.bundle
EOF

# What runs on the Mac. PATH carries node for the build phase that bundles the UI.
ENVS="export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin DEVELOPER_DIR='$XCODE/Contents/Developer'; cd ~/omni-ios-build"
BUILD="xcodebuild -project src/ios/OmniAgent.xcodeproj -scheme OmniAgent -derivedDataPath ~/omni-ios-build/dd"

# A command in the logged-in session at the Mac, as a launchd job; its output comes back here.
in_session() {
  local script="$1" label="tech.tomcamp.omniagent.build"
  mac bash -s <<EOF
set -uo pipefail
cd ~/omni-ios-build
if [ "\$(stat -f %Su /dev/console)" != "\$(id -un)" ]; then
  echo "Nobody is logged in at the Mac as \$(id -un), so the app cannot be signed. Log in at the Mac, then run this again." >&2; exit 4
fi
rm -f job.log job.status
cat > job.sh <<'JOB'
$ENVS
( $script ) > job.log 2>&1
echo \$? > job.status
JOB
cat > job.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>\$HOME/omni-ios-build/job.sh</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
PLIST
launchctl bootout gui/\$(id -u)/$label 2>/dev/null || true
launchctl bootstrap gui/\$(id -u) job.plist
for _ in \$(seq 1 1800); do [ -f job.status ] && break; sleep 1; done
launchctl bootout gui/\$(id -u)/$label 2>/dev/null || true
status=\$(cat job.status 2>/dev/null || echo 124)
rm -f job.sh job.plist job.status
if [ "\$status" != 0 ]; then grep -E 'error:|errSec|No Account|provisioning' job.log | sort -u | head -20; fi
exit "\$status"
EOF
}

install_and_open() {
  local config="$1"
  mac bash -s <<EOF
set -uo pipefail
$ENVS
xcrun devicectl device install app --device $IPHONE dd/Build/Products/$config-iphoneos/OmniAgent.app | tail -3
if ! xcrun devicectl device process launch --device $IPHONE $BUNDLE_ID 2>&1 | tail -3; then
  echo "Installed, but iOS did not open it. Unlock the iPhone. The first time, also trust the developer: Settings > General > VPN & Device Management > Apple Development: (the Apple ID) > Trust."
fi
EOF
}

case "$MODE" in
  device)
    echo "== release build for the iPhone, signed in the Mac's logged-in session"
    in_session "$BUILD -configuration Release -destination 'platform=iOS,id=$IPHONE' -allowProvisioningUpdates DEVELOPMENT_TEAM=$TEAM build"
    install_and_open Release
    ;;
  debug-device)
    echo "== debug build for the iPhone, signed in the Mac's logged-in session"
    in_session "$BUILD -configuration Debug -destination 'platform=iOS,id=$IPHONE' -allowProvisioningUpdates DEVELOPMENT_TEAM=$TEAM build"
    install_and_open Debug
    ;;
  sim)
    mac "$ENVS; $BUILD -configuration Debug -destination 'generic/platform=iOS Simulator' build > build-sim.log 2>&1 || { grep -E 'error:' build-sim.log | sort -u | head -20; exit 1; }"
    echo "built: ~/omni-ios-build/dd/Build/Products/Debug-iphonesimulator/OmniAgent.app"
    ;;
  test)
    mac bash -s <<EOF
set -uo pipefail
$ENVS
runtime=\$(xcrun simctl list runtimes available | grep -o 'com.apple.CoreSimulator.SimRuntime.iOS-[0-9-]*' | tail -1)
U=\$(xcrun simctl create omni-unit-tests com.apple.CoreSimulator.SimDeviceType.iPhone-17 "\$runtime")
trap 'xcrun simctl shutdown \$U >/dev/null 2>&1 || true; xcrun simctl delete \$U' EXIT
$BUILD -configuration Debug -destination "id=\$U" test > build-test.log 2>&1 && ok=0 || ok=\$?
grep -E "Test Case .*(passed|failed)|error:|Executed" build-test.log | sed 's/^.*Test Case/Test Case/' | sort -u | tail -40
exit \$ok
EOF
    ;;
esac
mac "df -h / | tail -1"
