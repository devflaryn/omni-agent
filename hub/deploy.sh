#!/usr/bin/env bash
# Puts the hub on the VPS. Re-runnable: run it again after any change to the hub or the crypto core.
#
#   bash hub/deploy.sh            from the top of the repository
#
# What it changes on the VPS, and nothing else:
#   /opt/omni-hub/                 the hub's code, root-owned, read-only to the service
#   /etc/omni-hub/bootstrap.env    root-only 0600. Made once, never overwritten, never printed
#   /etc/systemd/system/omni-hub.service
# The service starts only once the certificate exists, so this can run before certbot. nginx and certbot are separate
# steps on purpose: they touch what other services depend on.
set -euo pipefail

SSH_EXE="${OMNI_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
TARGET="${OMNI_VPS:-root@72.62.59.232}"
KNOWN_HOSTS="${OMNI_KNOWN_HOSTS:-C:\\Users\\berat\\.omni-agent\\relay\\known_hosts}"
remote() {
  "$SSH_EXE" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" -o GlobalKnownHostsFile=none "$TARGET" "$@"
}

# Exactly what the hub imports, in the same layout. A checkout on Windows can have CRLF, so it is stripped.
FILES=(hub/server.mjs hub/ws.mjs hub/store.mjs ui/account-core.js ui/device-log.js hub/omni-hub.service)
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
for file in "${FILES[@]}"; do
  mkdir -p "$staging/$(dirname "$file")"
  tr -d '\r' < "$file" > "$staging/$file"
done
# ui/*.js are ES modules, and this is what says so.
printf '{ "private": true, "type": "module" }\n' > "$staging/package.json"

tar -C "$staging" -cf - . | remote 'rm -rf /opt/omni-hub.new && mkdir -p /opt/omni-hub.new && tar -xf - --no-same-owner -C /opt/omni-hub.new'

remote 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/omni-hub.new
mv hub/omni-hub.service /etc/systemd/system/omni-hub.service.new
chown -R root:root .
chmod -R u=rwX,go=rX .
chown root:root /etc/systemd/system/omni-hub.service.new
chmod 644 /etc/systemd/system/omni-hub.service.new
mv -f /etc/systemd/system/omni-hub.service.new /etc/systemd/system/omni-hub.service

# The token opens the first registration once. It must survive a redeploy, and once spent the hub ignores it.
install -d -m 700 -o root -g root /etc/omni-hub
if [ ! -s /etc/omni-hub/bootstrap.env ]; then
  ( umask 077; printf 'OMNI_HUB_BOOTSTRAP_TOKEN=%s\n' "$(openssl rand -base64 32)" > /etc/omni-hub/bootstrap.env )
fi
chown root:root /etc/omni-hub/bootstrap.env
chmod 600 /etc/omni-hub/bootstrap.env

rm -rf /opt/omni-hub.old
[ -d /opt/omni-hub ] && mv /opt/omni-hub /opt/omni-hub.old
mv /opt/omni-hub.new /opt/omni-hub
rm -rf /opt/omni-hub.old

systemctl daemon-reload
if [ -e /etc/letsencrypt/live/tomcamp.tech/privkey.pem ]; then
  systemctl enable omni-hub
  systemctl restart omni-hub
  sleep 1
  systemctl is-active omni-hub
else
  echo "no certificate yet: the hub is installed and not started"
fi
REMOTE
