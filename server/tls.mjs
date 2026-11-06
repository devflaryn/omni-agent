/**
 * The remote listener's certificate. A password typed over plain HTTP crosses the internet readable,
 * so the remote listener serves HTTPS whenever it can: `tlsCert`/`tlsKey` from the config if given,
 * else a self-signed certificate made with openssl and kept in ~/.omni-agent/tls/. The browser
 * warns about a self-signed certificate the first time; the host can compare the SHA-256 fingerprint
 * the server prints (and shows in Settings → Remote) with the one the browser shows.
 *
 * iOS and macOS refuse outright (no "visit anyway") a TLS server certificate without the serverAuth
 * extended key usage, or valid for more than 825 days, or whose address is not in its SAN: Safari and
 * every iPhone browser then fail with "cannot establish a secure connection". The certificate made here
 * meets all three, and one made by an older Omni that does not (or that no longer names an address the
 * listener answers on, or is near its end) is made again.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OPENSSL_CANDIDATES = [
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  "/opt/homebrew/bin/openssl",
  "/usr/bin/openssl",
];

const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
/** Apple's limit is 825 days from notBefore; a little under it. */
export const CERT_DAYS = 820;
const DAY = 86400_000;

function findOpenssl() {
  for (const bin of OPENSSL_CANDIDATES) {
    if (bin !== "openssl" && !existsSync(bin)) continue;
    const r = spawnSync(bin, ["version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true });
    if (r.status === 0) return bin;
  }
  return null;
}

const sanFor = (altNames) => [...new Set(["DNS:localhost", "IP:127.0.0.1", ...altNames.filter(Boolean).map((a) => (/^[\d.]+$/.test(a) ? `IP:${a}` : `DNS:${a}`))])];

/** A certificate's SAN as names ("1.2.3.4", "host") that sanFor() takes back. */
const namesOf = (x) => String(x.subjectAltName || "").split(/,\s*/).map((s) => s.trim().replace(/^(IP Address|DNS):/, "")).filter(Boolean);
const sanOf = (x) => sanFor(namesOf(x));

/** Why a certificate Omni made must be made again, or "" when it is fine. */
export function renewReason(certPem, altNames = [], now = Date.now()) {
  let x;
  try { x = new X509Certificate(certPem); } catch { return "unreadable"; }
  if (!(x.keyUsage || []).includes(SERVER_AUTH)) return "no serverAuth usage (iOS refuses it)";
  const from = Date.parse(x.validFrom), to = Date.parse(x.validTo);
  if (to - from > 825 * DAY) return "valid for more than 825 days (iOS refuses it)";
  if (to - now < 30 * DAY) return "expires soon";
  const have = new Set(sanOf(x));
  const missing = sanFor(altNames).filter((s) => !have.has(s));
  if (missing.length) return `does not name ${missing.join(", ").replace(/(DNS|IP):/g, "")}`;
  return "";
}

/** The openssl config for a self-signed server certificate: a root iOS can be told to trust (CA), usable for TLS servers. */
export function opensslConfig(altNames) {
  return [
    "[req]", "distinguished_name = dn", "x509_extensions = v3", "prompt = no", "",
    "[dn]", "CN = Omni Agent", "O = Omni Agent", "",
    "[v3]",
    "basicConstraints = critical, CA:TRUE, pathlen:0",
    "keyUsage = critical, digitalSignature, keyCertSign",
    "extendedKeyUsage = serverAuth",
    "subjectKeyIdentifier = hash",
    `subjectAltName = ${sanFor(altNames).join(", ")}`,
    "",
  ].join("\n");
}

/** { key, cert, fingerprint, selfSigned, file, renewed? } or { error } when no certificate can be had. */
export function loadOrCreateCert({ dir, certFile, keyFile, altNames = [], now = Date.now(), log = () => {} }) {
  try {
    if (certFile && keyFile) return finish(readFileSync(keyFile), readFileSync(certFile), false, certFile);
    const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
    let renewed = "";
    if (existsSync(key) && existsSync(cert)) {
      renewed = renewReason(readFileSync(cert), altNames, now);
      // Addresses the old certificate named stay in the new one: a laptop moving between networks is not renewed at each move.
      if (renewed) { try { altNames = [...namesOf(new X509Certificate(readFileSync(cert))), ...altNames]; } catch { /* unreadable */ } }
    }
    if (!existsSync(key) || !existsSync(cert) || renewed) {
      const bin = findOpenssl();
      if (!bin) return existsSync(cert) && existsSync(key) ? finish(readFileSync(key), readFileSync(cert), true, cert) : { error: "openssl was not found, so no certificate could be made (set tlsCert/tlsKey in omni.config.json)" };
      mkdirSync(dir, { recursive: true });
      if (renewed) log(`making a new certificate: the old one ${renewed}`);
      const cnf = join(dir, "openssl.cnf"), newKey = join(dir, "key.new.pem"), newCert = join(dir, "cert.new.pem");
      writeFileSync(cnf, opensslConfig(altNames));
      const r = spawnSync(bin, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", newKey, "-out", newCert, "-days", String(CERT_DAYS), "-config", cnf], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
      rmSync(cnf, { force: true });
      if (r.status !== 0) {
        rmSync(newKey, { force: true }); rmSync(newCert, { force: true });
        const why = `openssl could not make a certificate: ${String(r.stderr || "").trim().split("\n").pop()}`;
        // An old certificate still serves desktop browsers; only a missing one is an error.
        if (existsSync(cert) && existsSync(key)) { log(why); return finish(readFileSync(key), readFileSync(cert), true, cert); }
        return { error: why };
      }
      // Swapped in only once both halves exist, so a failure never leaves a key without its certificate.
      writeFileSync(key, readFileSync(newKey)); writeFileSync(cert, readFileSync(newCert));
      rmSync(newKey, { force: true }); rmSync(newCert, { force: true });
    }
    return { ...finish(readFileSync(key), readFileSync(cert), true, cert), ...(renewed ? { renewed } : {}) };
  } catch (e) {
    return { error: e.message };
  }
}

function finish(key, cert, selfSigned, file) {
  return { key, cert, selfSigned, file, fingerprint: new X509Certificate(cert).fingerprint256 };
}

/** The reply to a plain-HTTP request's first bytes on an HTTPS port (the address typed without https://):
 *  a redirect to the same host and path over https, or null when they are not an HTTP request.
 *  `fallbackHost` ("addr:port") stands in for a missing or odd Host header. relay/omni-relay.mjs has a copy. */
export function httpsRedirect(head, fallbackHost) {
  const lines = head.toString("latin1").split("\r\n");
  const req = /^[A-Z]{3,7} (\S+) HTTP\/1\.[01]$/.exec(lines[0]);
  if (!req) return null;
  const path = req[1].startsWith("/") ? req[1] : "/";
  const host = (lines.find((l) => /^host:/i.test(l)) || "").slice(5).trim();
  const where = /^([\w-]+(\.[\w-]+)*|\[[0-9a-fA-F:.]+\]):\d{1,5}$/.test(host) ? host : fallbackHost;
  return `HTTP/1.1 301 Moved Permanently\r\nLocation: https://${where}${path}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}
