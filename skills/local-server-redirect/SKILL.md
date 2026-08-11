---
name: local-server-redirect
description: Route a RUNNING app's network calls (on omnidroid) to a local mock/fake server so you can capture its real protocol and replace its backend — serve fake responses, edit them live, and test the app fully offline. Covers the traps that make the naive approaches (hosts file, getaddrinfo hook) silently fail, and the two methods that actually work (iptables DNAT by IP, Frida connect-rewrite).
when_to_use: Use when the user wants an app to talk to a LOCAL server instead of its real backend — "make it use my fake server", "serve the UI/script from my machine", "mock the server", "capture the exact requests/URLs it makes", "test it offline / with the real server blocked", or when a redirect you tried (edited /etc/hosts, hooked getaddrinfo) had no effect. Pairs with ssl-pinning-bypass (if TLS is verified) and frida-dynamic-instrumentation (to find which host/IP it hits). Requires a running omnidroid instance (root; --debug for the Frida method).
allowed-tools: run_root_command, adb_shell, frida_run_script, frida_trace, write_file, read_file_chunk, get_logcat, monitor_logcat, take_emulator_screenshot, ensure_emulator_running, ensure_frida_server
---

# Redirect an app to a local server (omnidroid)

Goal: make a running app's HTTPS calls hit **your** server on this host, so you
can log the real protocol and swap in fake responses (mock a UI, a license
check, a downloaded script) — and edit them live. The host is reachable from the
guest at **`10.0.2.2`** (the QEMU slirp gateway = this machine). Bind your server
to `0.0.0.0`.

## Three traps that waste an hour each (all learned the hard way)

1. **curl / c-ares apps ignore `/etc/hosts` AND libc `getaddrinfo`.** Anything
   using libcurl's async resolver (game executors, many native SDKs) does its own
   DNS via **c-ares** and connects straight to the IP. A hosts entry, a DNS
   change, or a Frida `getaddrinfo` hook **does nothing** — the app still hits the
   real IP. Symptom: your redirect "fires" but the fake server logs **zero**
   requests. → use DNAT or a `connect()` hook (below), not name resolution.
2. **`mount --bind /system/etc/hosts` does not reach the app.** Android apps run
   in their **own mount namespace**; a runtime bind-mount (even as root) is
   invisible to app processes. Same zero-effect symptom.
3. **`iptables -m string` breaks adb.** A string-match on a hostname/SNI rejects
   ANY packet containing that string — including adb's own output when it echoes
   the hostname — and **wedges the adb connection**. Never use `-m string`. Match
   by **IP**.

## What actually works — pick one

### A) iptables DNAT by destination IP  (default: no Frida, transparent, adb-safe)
Netfilter is global (namespace-independent) and adb goes to different IPs, so this
is clean. First **find the IPs** (they're usually a CDN) by tracing the app's
`connect()`/`getaddrinfo` (see frida-recipes) or resolving the host; then:

```bash
# via run_root_command (guest). CIDR examples: GitHub raw/gist = Fastly 185.199.108.0/22;
# Cloudflare = 162.159.0.0/16.
iptables -t nat -A OUTPUT -p tcp -d 185.199.108.0/22 --dport 443 -j DNAT --to-destination 10.0.2.2:8443
```
Runtime state — **clears on power-off** (ephemeral /data). Re-apply each boot, or
bake it into the offset (a `service.d`/init script in the overlay) for a permanent
"app only ever talks to my server" setup.

### B) Frida `connect()`-by-IP rewrite  (per-session; when IPs are unknown/dynamic)
Hook libc `connect`; for the target destination IP, overwrite `sin_addr`→`10.0.2.2`
and `sin_port`→your port. Namespace-safe, adb-safe. Full recipe:
`frida-dynamic-instrumentation/reference/frida-recipes.md` → "Redirect a
curl/c-ares app to a local server". Deliver it with `frida_run_script` (needs a
`--debug` boot + `ensure_frida_server`).

## TLS — usually easier than expected
The app connects on 443 expecting a valid cert. Two cases:
- **Many loader/executor apps do NOT verify the cert** (`CURLOPT_SSL_VERIFYPEER=0`).
  A **self-signed cert with the right SANs** is accepted and the request decrypts.
  **Try this first** — it's free: serve HTTPS self-signed and see if requests land.
- **If it verifies** → combine with `ssl-pinning-bypass` (static) / a Frida cert
  bypass, or install a CA in the guest trust store.
- **Can't bind 443 on the host?** Rewrite the port too — DNAT `--to 10.0.2.2:8443`
  (or the connect hook sets the port). The app still dials 443; you land on 8443.

## The local server (what you `write_file`)
A tiny Node/Python server that:
- **routes by `Host` header** (one server stands in for every backend host),
- **logs every request** (method, path, headers, body) — *this is your capture of
  the real protocol; the exact URLs/paths appear here*,
- serves **fake responses** you can edit live to change app behavior.
If the backend uses an app-level encoding (e.g. base64+XOR, or a Lua
`encryptDecrypt`), remember **you now control the content** — serve it in whatever
form the client expects (match the encoding once, from a captured sample) and you
never have to break the encryption, because you produce the plaintext.

## Verify (don't assume)
Your **server's request log is the proof**. If it's empty after a redirect, you
hit trap #1/#2 — switch to DNAT/connect-rewrite. A screenshot showing your fake
content in the app (`take_emulator_screenshot`) confirms end-to-end.

## Gotcha recap
- Redirect by **IP**, never by name (c-ares) and never `-m string` (kills adb).
- Host from guest = **`10.0.2.2`**; server binds `0.0.0.0`.
- DNAT is **runtime** — re-apply per boot or bake into the offset for permanence.
- Try a **self-signed cert first**; only reach for ssl-pinning-bypass if it's
  actually verifying.
