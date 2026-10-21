#!/usr/bin/env bash
# Sets up the Omni relay on a VPS. Idempotent: run it again to update the relay or the key.
#
#   ssh root@<vps> 'bash -s' -- "<ssh public key of the Omni PC>" < relay/setup-vps.sh
#   (then copy relay/omni-relay.mjs to /opt/omni-relay/ and relay/omni-relay.service to /etc/systemd/system/)
#
# What it creates:
#   - user `omni-tunnel`: no password, no shell. Its one key may only open a REMOTE forward on
#     127.0.0.1:14443 (no -L, no shell, no agent, no X11), enforced twice: in authorized_keys and in an
#     sshd Match block. Checked with `sshd -t` and `sshd -T` before sshd is reloaded.
#   - nothing else: the relay service runs as a throwaway DynamicUser; nginx and the firewall are untouched.
set -euo pipefail
PUBKEY="${1:?usage: setup-vps.sh '<ssh public key>'}"
TUNNEL_PORT="${TUNNEL_PORT:-14443}"
case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "expected an ssh-ed25519 public key" >&2; exit 1;; esac

if ! id omni-tunnel >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/omni-tunnel --shell /usr/sbin/nologin omni-tunnel
fi
passwd -l omni-tunnel >/dev/null
install -d -m 700 -o omni-tunnel -g omni-tunnel /home/omni-tunnel/.ssh
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s",command="/bin/false" %s\n' "$TUNNEL_PORT" "$PUBKEY" > /home/omni-tunnel/.ssh/authorized_keys
chown omni-tunnel:omni-tunnel /home/omni-tunnel/.ssh/authorized_keys
chmod 600 /home/omni-tunnel/.ssh/authorized_keys

DROPIN=/etc/ssh/sshd_config.d/90-omni-tunnel.conf
cat > "$DROPIN.new" <<EOF
# Omni relay tunnel account: one remote forward, nothing else.
Match User omni-tunnel
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:$TUNNEL_PORT
    PermitOpen none
    GatewayPorts no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    ForceCommand /bin/false
    # When the PC's link drops silently (a VPN changing its exit IP), the dead session would keep
    # 127.0.0.1:$TUNNEL_PORT bound and every reconnect would fail "remote port forwarding failed".
    # Probing the client frees the port within ~30 s.
    ClientAliveInterval 10
    ClientAliveCountMax 3
EOF
cp -a "$DROPIN.new" "$DROPIN" && rm -f "$DROPIN.new"

# Validate, and prove the Match block touches only omni-tunnel, before sshd reads it.
if ! sshd -t; then rm -f "$DROPIN"; echo "sshd config invalid; drop-in removed" >&2; exit 1; fi
ROOT_BEFORE_OK=$(sshd -T -C user=root,host=x,addr=203.0.113.1 | grep -E '^(allowtcpforwarding|permitrootlogin|permittty) ')
echo "$ROOT_BEFORE_OK" | grep -q '^permittty yes' || { rm -f "$DROPIN"; echo "the drop-in changed root's settings; removed" >&2; exit 1; }
sshd -T -C user=omni-tunnel,host=x,addr=203.0.113.1 | grep -E '^(allowtcpforwarding|permitlisten|permitopen|permittty|forcecommand) '
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "omni-tunnel ready"
