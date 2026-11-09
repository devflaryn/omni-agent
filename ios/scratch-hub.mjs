#!/usr/bin/env node
// A throwaway hub and desktop, for trying the iPhone app without the real account. Run on the Mac, from a checkout:
//
//   node ios/scratch-hub.mjs --dir <a new empty folder> --host <this Mac's address> [--port 4790] [--approve]
//
// It makes a throwaway CA and a certificate for --host, starts a hub at https://<host>:<port> with that origin, and a scratch
// desktop (HOME is inside --dir, so nothing of the real ~/.omni-agent is read or written) that creates an account on it and holds
// two made-up chats. No model is ever called: the desktop has no credentials and no agent is started.
//
// With --approve, each new iPhone sign-in is approved as `full`, with its code, as one tap on the desktop's card would.
// A debug build of the app is pointed at it with two launch arguments, printed at the start (see docs/accounts.md):
//   -OmniHub https://<host>:<port> -OmniHubCA <the CA, base64 DER>
// Stop it with Ctrl+C, then delete --dir.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const DIR = resolve(arg("--dir", "") || (console.error("--dir is needed"), process.exit(2)));
const HOST = arg("--host", "127.0.0.1");
const PORT = Number(arg("--port", "4790"));
const ORIGIN = `https://${HOST}:${PORT}`;
const EMAIL = "scratch@example.test";
const PASSWORD = "scratch-password-p7";
const BOOTSTRAP = "scratch-bootstrap-token-0123456789";
const tls = join(DIR, "tls");

function certificates() {
  mkdirSync(tls, { recursive: true });
  const ip = /^[\d.]+$/.test(HOST);
  writeFileSync(join(tls, "ca.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
  writeFileSync(join(tls, "leaf.cnf"), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${ip ? "IP" : "DNS"}:${HOST}\n`);
  const run = (...args) => { const r = spawnSync("openssl", args, { cwd: tls, encoding: "utf8" }); if (r.status !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr}`); return r.stdout; };
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3", "-subj", "/CN=Omni scratch CA (throwaway)", "-keyout", "ca.key", "-out", "ca.pem", "-config", "ca.cnf");
  run("req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", `/CN=${HOST}`, "-keyout", "key.pem", "-out", "leaf.csr");
  run("x509", "-req", "-sha256", "-days", "3", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-extfile", "leaf.cnf", "-out", "cert.pem");
  const der = spawnSync("openssl", ["x509", "-in", "ca.pem", "-outform", "der"], { cwd: tls });
  writeFileSync(join(tls, "ca.b64"), der.stdout.toString("base64"));
}

async function serve() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { startHub } = await import(join(root, "hub", "server.mjs"));
  const { createApp } = await import(join(root, "server", "index.mjs"));
  const { plainProtector } = await import(join(root, "server", "account-keys.mjs"));

  const hub = await startHub({ port: PORT, host: "0.0.0.0", dataDir: join(DIR, "hub"), tls: { cert: readFileSync(join(tls, "cert.pem")), key: readFileSync(join(tls, "key.pem")) }, origin: ORIGIN, bootstrapToken: BOOTSTRAP, log: (l) => console.log(`hub: ${l}`) });

  // Two made-up chats, in the transcript format the desktop reads.
  const pi = join(DIR, "pi");
  mkdirSync(pi, { recursive: true });
  const chat = (id, at, title, reply) => writeFileSync(join(pi, `sess_${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp: at, cwd: join(DIR, "work") },
    { type: "message", id: "u1", timestamp: at, message: { role: "user", content: title } },
    { type: "message", id: "a1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: reply }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  chat("01a086a6-c763-777d-8188-9a868c6a2266", "2026-11-09T10:00:00.000Z", "Plan the iPhone release", "Three steps: build on the Mac, install with devicectl, reinstall every 7 days.");
  chat("01a086a6-c763-777d-8188-9a868c6a2267", "2026-11-09T11:30:00.000Z", "Why does the phone need no relay?", "Because every frame goes through the hub, encrypted between your own devices.");
  mkdirSync(join(DIR, "work"), { recursive: true });

  const accountDir = join(DIR, "account");
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(join(accountDir, "bootstrap-token"), `${BOOTSTRAP}\n`);
  const app = await createApp({
    port: PORT + 1, host: "127.0.0.1", lan: false, relay: { host: "" }, autoStartPi: false, hook: { enabled: false }, persistHook: false, persistPiModel: false,
    cwd: join(DIR, "work"), vaultDir: join(DIR, "vault"), piSessionsDir: pi, claudeProjectsDir: join(DIR, "claude"),
    opencodeBin: join(DIR, "no-opencode"), claudeBin: join(DIR, "no-claude"),
    accountDir, accountHub: ORIGIN, accountOptions: { hubOrigin: ORIGIN, protector: plainProtector() },
  });
  await app.listen();
  await app.account.register({ email: EMAIL, password: PASSWORD, name: "Scratch Mac" });
  await app.account.recoveryCodeSaved();
  console.log(`ready: hub ${ORIGIN}, desktop "Scratch Mac" registered as ${EMAIL} / ${PASSWORD}`);
  console.log(`launch arguments: -OmniHub ${ORIGIN} -OmniHubCA ${readFileSync(join(tls, "ca.b64"), "utf8")}`);

  const seen = new Set();
  setInterval(async () => {
    for (const row of app.account.pendingSignIns()) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      console.log(`card: "${row.name}" says it is a ${row.kind}`);
      if (!process.argv.includes("--approve") || row.kind !== "iphone") continue;
      try {
        const { code } = await app.account.review(row.id);
        console.log(`card code: ${code}`);
        await new Promise((r) => setTimeout(r, 8000)); // time to see the code on both
        await app.account.approve(row.id, { code, role: "full" });
        console.log(`approved "${row.name}" as full`);
      } catch (error) { console.log(`approval failed: ${error.message}`); }
    }
  }, 500).unref?.();

  const stop = async () => { try { app.close(); await app.account?.stop(); await hub.close(); } finally { process.exit(0); } };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv.includes("--serve")) {
  await serve();
} else {
  if (existsSync(DIR) && readdirSync(DIR).length) { console.error(`${DIR} is not empty`); process.exit(2); }
  mkdirSync(join(DIR, "home"), { recursive: true });
  certificates();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--serve"], {
    stdio: "inherit",
    env: { ...process.env, HOME: join(DIR, "home"), OMNI_DATA_DIR: join(DIR, "data"), NODE_EXTRA_CA_CERTS: join(tls, "ca.pem"), OMNI_UI_AUTOBUILD: "0" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 0));
}
