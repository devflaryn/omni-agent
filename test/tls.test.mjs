import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CERT_DAYS, loadOrCreateCert, opensslConfig, renewReason } from "../server/tls.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-tls-"));
const hasOpenssl = !!loadOrCreateCert({ dir: join(base, "probe") }).cert;

test("the openssl config asks for what iOS requires of a server certificate", () => {
  const c = opensslConfig(["192.168.0.15", "relay.example"]);
  assert.match(c, /extendedKeyUsage = serverAuth/);
  assert.match(c, /subjectAltName = DNS:localhost, IP:127\.0\.0\.1, IP:192\.168\.0\.15, DNS:relay\.example/);
  assert.match(c, /basicConstraints = critical, CA:TRUE/);
  assert.ok(CERT_DAYS <= 825);
});

test("a made certificate has serverAuth, at most 825 days, and every address; it is kept on the next load", { skip: !hasOpenssl && "no openssl" }, () => {
  const dir = join(base, "fresh");
  const a = loadOrCreateCert({ dir, altNames: ["10.0.0.5", "72.62.59.232"] });
  const x = new X509Certificate(a.cert);
  assert.ok(x.keyUsage.includes("1.3.6.1.5.5.7.3.1"));
  assert.ok(Date.parse(x.validTo) - Date.parse(x.validFrom) <= 825 * 86400_000);
  assert.match(x.subjectAltName, /IP Address:10\.0\.0\.5/);
  assert.match(x.subjectAltName, /IP Address:72\.62\.59\.232/);
  assert.equal(renewReason(a.cert, ["10.0.0.5", "72.62.59.232"]), "");
  const b = loadOrCreateCert({ dir, altNames: ["10.0.0.5", "72.62.59.232"] });
  assert.equal(b.fingerprint, a.fingerprint);
  assert.equal(b.renewed, undefined);
});

test("an old certificate (no serverAuth, as Omni used to make) is made again, keeping the addresses it named", { skip: !hasOpenssl && "no openssl" }, () => {
  const dir = join(base, "old"); mkdirSync(dir, { recursive: true });
  const probe = loadOrCreateCert({ dir: join(base, "probe") });
  // The old recipe: `req -x509 ... -addext subjectAltName=...`, no extendedKeyUsage.
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  const bin = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"].find((b) => spawnSync(b, ["version"]).status === 0);
  spawnSync(bin, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "825", "-subj", "/CN=Omni Agent", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.1.9"], { stdio: "ignore" });
  assert.match(renewReason(readFileSync(cert), []), /serverAuth/);
  const logs = [];
  const r = loadOrCreateCert({ dir, altNames: ["10.0.0.5"], log: (t) => logs.push(t) });
  assert.match(r.renewed, /serverAuth/);
  assert.match(logs.join("\n"), /new certificate/);
  const x = new X509Certificate(r.cert);
  assert.ok(x.keyUsage.includes("1.3.6.1.5.5.7.3.1"));
  assert.match(x.subjectAltName, /192\.168\.1\.9/, "an address the old one named stays");
  assert.match(x.subjectAltName, /10\.0\.0\.5/);
  assert.equal(r.key.toString(), readFileSync(key, "utf8"));
  assert.ok(probe.cert);
});

test("renewReason: a certificate that misses an address, is near its end, or runs too long is renewed", { skip: !hasOpenssl && "no openssl" }, () => {
  const a = loadOrCreateCert({ dir: join(base, "reasons"), altNames: ["10.0.0.5"] });
  assert.match(renewReason(a.cert, ["10.0.0.6"]), /does not name 10\.0\.0\.6/);
  assert.match(renewReason(a.cert, [], Date.now() + (CERT_DAYS - 10) * 86400_000), /expires soon/);
  assert.equal(renewReason("not a certificate"), "unreadable");
  // A user-provided pair is used as given, never renewed.
  const dir = join(base, "given");
  const k = join(dir, "k.pem"), c = join(dir, "c.pem");
  loadOrCreateCert({ dir });
  writeFileSync(k, readFileSync(join(dir, "key.pem"))); writeFileSync(c, readFileSync(join(dir, "cert.pem")));
  const g = loadOrCreateCert({ dir, certFile: c, keyFile: k, altNames: ["10.9.9.9"] });
  assert.equal(g.selfSigned, false);
  assert.equal(g.renewed, undefined);
});
