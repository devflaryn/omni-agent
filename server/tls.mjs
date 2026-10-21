/**
 * The remote listener's certificate. A password typed over plain HTTP crosses the internet readable,
 * so the remote listener serves HTTPS whenever it can: `tlsCert`/`tlsKey` from the config if given,
 * else a self-signed certificate made once with openssl and kept in ~/.omni-agent/tls/. The browser
 * warns about a self-signed certificate the first time; the host can compare the SHA-256 fingerprint
 * the server prints (and shows in Settings → Remote) with the one the browser shows.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OPENSSL_CANDIDATES = [
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  "/opt/homebrew/bin/openssl",
  "/usr/bin/openssl",
];

function findOpenssl() {
  for (const bin of OPENSSL_CANDIDATES) {
    if (bin !== "openssl" && !existsSync(bin)) continue;
    const r = spawnSync(bin, ["version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true });
    if (r.status === 0) return bin;
  }
  return null;
}

/** { key, cert, fingerprint, selfSigned, file } or { error } when no certificate can be had. */
export function loadOrCreateCert({ dir, certFile, keyFile, altNames = [] }) {
  try {
    if (certFile && keyFile) return finish(readFileSync(keyFile), readFileSync(certFile), false, certFile);
    const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
    if (!existsSync(key) || !existsSync(cert)) {
      const bin = findOpenssl();
      if (!bin) return { error: "openssl was not found, so no certificate could be made (set tlsCert/tlsKey in omni.config.json)" };
      mkdirSync(dir, { recursive: true });
      const san = ["DNS:localhost", "IP:127.0.0.1", ...altNames.map((a) => (/^[\d.]+$/.test(a) ? `IP:${a}` : `DNS:${a}`))].join(",");
      const r = spawnSync(bin, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "825", "-subj", "/CN=Omni Agent", "-addext", `subjectAltName=${san}`], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
      if (r.status !== 0) return { error: `openssl could not make a certificate: ${String(r.stderr || "").trim().split("\n").pop()}` };
    }
    return finish(readFileSync(key), readFileSync(cert), true, cert);
  } catch (e) {
    return { error: e.message };
  }
}

function finish(key, cert, selfSigned, file) {
  return { key, cert, selfSigned, file, fingerprint: new X509Certificate(cert).fingerprint256 };
}
