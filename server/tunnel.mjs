/**
 * The way in from the internet without touching the router: this PC dials OUT to a VPS over SSH and
 * asks it to forward one loopback port back here (`ssh -R`). On the VPS a small relay (relay/omni-relay.mjs)
 * listens publicly and passes each connection, still TLS-encrypted end to end, into that port with a
 * PROXY header naming the visitor. The VPS never holds a key that can read the traffic.
 *
 * The SSH account on the VPS can do nothing but that one forward (relay/setup-vps.sh); the host key is
 * pinned in our own known_hosts, so a different server is refused rather than trusted.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const WINDOWS_SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";

export function sshArgs({ host, user, key, knownHosts, remotePort, localPort }) {
  return [
    "-N", "-T", "-v",
    "-i", key,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=none",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
    "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
    `${user}@${host}`,
  ];
}

export class SshTunnel {
  constructor({ host, user = "omni-tunnel", key, knownHosts, remotePort = 14443, localPort, bin, spawn: spawnFn = spawn, log = () => {}, minBackoffMs = 2000 }) {
    Object.assign(this, { host, user, key, knownHosts, remotePort, localPort, log });
    this.bin = bin || (process.platform === "win32" && existsSync(WINDOWS_SSH) ? WINDOWS_SSH : "ssh");
    this.spawnFn = spawnFn;
    this.state = "off";
    this.since = Date.now();
    this.lastError = "";
    this.proc = null;
    this.minBackoff = minBackoffMs;
    this.backoff = minBackoffMs;
    this.timer = null;
    this.stopped = true;
  }

  set(state, error) {
    if (this.state !== state) { this.state = state; this.since = Date.now(); this.log(`relay tunnel ${state}${error ? `: ${error}` : ""}`); }
    if (error) this.lastError = error;
  }

  start() {
    this.stopped = false;
    if (!existsSync(this.key)) { this.set("down", `no SSH key at ${this.key}`); return; }
    if (!existsSync(this.knownHosts)) { this.set("down", `no pinned host key at ${this.knownHosts}`); return; }
    this.set("connecting");
    // stdout ignored: a pipe nobody drains can stall a child; stderr carries ssh's -v progress lines.
    const p = this.spawnFn(this.bin, sshArgs(this), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.proc = p;
    let tail = "";
    p.stderr?.on("data", (d) => {
      tail = (tail + d).slice(-4000);
      if (/remote forward success/i.test(tail) && this.state !== "up") { this.backoff = this.minBackoff; this.set("up"); }
    });
    const ended = (why) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.set("down", why);
      if (this.stopped) return;
      this.timer = setTimeout(() => this.start(), this.backoff);
      // Short cap: the usual failure is the VPS still holding the port for a dead session, which it
      // frees within ~30 s; a long wait after that only extends the outage. A retry costs one handshake.
      this.backoff = Math.min(this.backoff * 2, 20_000);
    };
    // A spawn that fails (no pid) reports only 'error', never 'exit': without this the tunnel stayed down
    // until Omni restarted. An 'error' from a child that did start (a failed kill) is not an end.
    p.on("error", (e) => { if (p.pid === undefined) ended(e.message); else this.set(this.state, e.message); });
    p.on("exit", (code) => {
      const why = (tail.match(/(Permission denied[^\n]*|Host key verification failed[^\n]*|remote port forwarding failed[^\n]*|Connection (?:refused|timed out)[^\n]*|Could not resolve[^\n]*)/i) || [])[1];
      ended(why || `ssh exited (${code})`);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const p = this.proc;
    this.proc = null;
    try { p?.kill(); } catch { /* gone */ }
    this.set("off");
  }

  status() { return { state: this.state, since: this.since, lastError: this.lastError, host: this.host }; }
}
