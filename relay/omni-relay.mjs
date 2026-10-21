/**
 * Omni relay: runs on the VPS. Listens on a public port and passes each TCP connection, untouched, into the
 * SSH tunnel that the Omni PC keeps open (the VPS's 127.0.0.1:TUNNEL_PORT), prefixed with one PROXY v1 line
 * naming the visitor so the PC can rate-limit sign-ins per real address.
 *
 * It never terminates TLS: it holds no certificate and cannot read or change the traffic. What it does refuse:
 * anything that does not open with a TLS handshake (scanners, plain HTTP), more than PER_IP connections at once
 * from one address, more than RATE new connections a minute from one address, more than MAX in all, and
 * connections idle for IDLE_MS. Node built-ins only.
 *
 *   PUBLIC_PORT=4443 TUNNEL_PORT=14443 node omni-relay.mjs
 */
import { connect, createServer } from "node:net";

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 4443);
const TUNNEL_PORT = Number(process.env.TUNNEL_PORT || 14443);
const PER_IP = Number(process.env.PER_IP || 32);
const RATE = Number(process.env.RATE || 120);
const MAX = Number(process.env.MAX || 512);
const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60_000);
const HELLO_MS = 10_000;

const open = new Map();     // ip -> live connections
const recent = new Map();   // ip -> timestamps of new connections in the last minute
let live = 0;
const counts = { ok: 0, notTls: 0, perIp: 0, rate: 0, full: 0, tunnelDown: 0 };

const norm = (a) => String(a || "").replace(/^::ffff:/, "");
const isV4 = (a) => /^\d+\.\d+\.\d+\.\d+$/.test(a);

function admit(ip) {
  const now = Date.now();
  const r = (recent.get(ip) || []).filter((t) => now - t < 60_000);
  r.push(now);
  recent.set(ip, r);
  if (live >= MAX) return "full";
  if ((open.get(ip) || 0) >= PER_IP) return "perIp";
  if (r.length > RATE) return "rate";
  return null;
}

const server = createServer({ pauseOnConnect: true }, (client) => {
  const ip = norm(client.remoteAddress);
  const refused = admit(ip);
  if (refused) { counts[refused]++; client.destroy(); return; }
  live++;
  open.set(ip, (open.get(ip) || 0) + 1);
  let upstream = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    live--;
    const n = (open.get(ip) || 1) - 1;
    if (n) open.set(ip, n); else open.delete(ip);
    client.destroy();
    upstream?.destroy();
  };
  client.on("error", close);
  client.on("close", close);
  client.setTimeout(HELLO_MS, close);
  client.once("data", (first) => {
    // A TLS record starts with 0x16 (handshake). Anything else is not for us.
    if (first[0] !== 0x16) { counts.notTls++; close(); return; }
    client.pause();
    const local = norm(client.localAddress);
    const v4 = isV4(ip) && isV4(local);
    const header = `PROXY ${v4 ? "TCP4" : "TCP6"} ${v4 ? ip : client.remoteAddress} ${v4 ? local : client.localAddress} ${client.remotePort} ${client.localPort}\r\n`;
    upstream = connect(TUNNEL_PORT, "127.0.0.1", () => {
      counts.ok++;
      upstream.write(header);
      upstream.write(first);
      client.setTimeout(IDLE_MS, close);
      upstream.setTimeout(IDLE_MS, close);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("error", () => { counts.tunnelDown++; close(); });
    upstream.on("close", close);
  });
  client.resume();
});

server.maxConnections = MAX + 16;
server.on("error", (e) => { console.error(`relay: ${e.message}`); process.exit(1); });
server.listen(PUBLIC_PORT, "::", () => console.log(`omni-relay: public :${PUBLIC_PORT} -> tunnel 127.0.0.1:${TUNNEL_PORT}`));

// One line a minute when anything happened: counts only, never addresses or content.
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of recent) if (!r.some((t) => now - t < 60_000)) recent.delete(ip);
  if (Object.values(counts).some(Boolean)) console.log(`omni-relay: live=${live} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  for (const k of Object.keys(counts)) counts[k] = 0;
}, 60_000).unref();
