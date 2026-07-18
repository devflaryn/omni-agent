---
name: dynamic-unpacking
description: Recover the REAL code from a packed/protected Android app (DexGuard, Bangcle, Jiagu/360, SecShell, Tencent Legu, etc.) whose static DEX is just a stub that decrypts and loads the true dex at runtime. Detect the packer, dump the decrypted dex from memory/disk on the dev base, then analyze the dumped code.
when_to_use: When jadx/decode shows almost no app logic, a tiny Application class plus an encrypted blob in assets/lib, `InMemoryDexClassLoader`/`DexClassLoader` on decrypted bytes, or class names that don't match the app's behavior — i.e. static analysis finds nothing because the code isn't there yet.
allowed-tools: decode_apk, extract_strings, query_code_graph, search_smali, list_dex_classes, disassemble_dex, jadx_decompile, ensure_emulator_running, ensure_frida_server, install_apk_on_emulator, launch_app_on_emulator, frida_run_script, frida_trace, adb_shell, read_file_chunk
---

# Dynamic unpacking (packed / protected APKs)

A packer replaces the app's real DEX with a loader stub plus an encrypted payload; the
true code is decrypted into memory only when the app runs. Static tools then show
nothing useful. You can't patch what you can't see — so you dump the decrypted dex from
the running process, THEN analyze/patch that.

## Step 1 — Confirm it's packed and identify the packer
`decode_apk`, then look for the fingerprints (`extract_strings`, `search_smali`,
`list_dex_classes`):
- A tiny `Application`/stub with a native `.so` doing the loading; almost no business
  logic in the DEX.
- Packer markers: `libjiagu*.so`/`libjgdtc*.so` (360 Jiagu), `libDexHelper.so`/`libsecexe.so`
  (Bangcle/SecShell), `libshella*.so`/`libtup.so`/`libnsecure.so` (Tencent Legu),
  `libexec.so` + `assets/*.jar` blobs, DexGuard's heavily-renamed classes + string pools.
- `InMemoryDexClassLoader`, `DexClassLoader`, `openDexFile`, `defineClass` on
  runtime-decrypted `byte[]` — the load site.
- Encrypted blobs in `assets/` or `lib/` that aren't valid dex/zip.

## Step 2 — Bring up the dev base and run it
`ensure_emulator_running` → `ensure_frida_server` → `install_apk_on_emulator` →
`launch_app_on_emulator`. The app must actually RUN for the payload to decrypt.

## Step 3 — Dump the decrypted dex
Two paths, easiest first:
- **From disk after decrypt.** Many packers write the decrypted dex/odex to the app's
  private dir. `adb_shell` (as the app/root on the dev base) to look under
  `/data/data/<pkg>/` (e.g. `app_dex`, `code_cache`, `files`) and `/data/app/.../oat/` for
  fresh `.dex`/`.odex`/`.vdex`, then pull them.
- **From memory with Frida.** Hook the load site and write the buffer out. `frida_trace`
  `InMemoryDexClassLoader.$init` / `DexClassLoader.$init` / `dalvik.system.DexFile` to see
  when it fires; then `frida_run_script` to grab the `byte[]`/base+size and dump it:
  ```js
  Java.perform(function () {
    var L = Java.use('dalvik.system.InMemoryDexClassLoader');
    L.$init.overload('[Ljava.nio.ByteBuffer;', 'java.lang.ClassLoader')
      .implementation = function (buffers, parent) {
        buffers.forEach(function (b, i) {
          var n = b.remaining();
          var bytes = Java.array('byte', b.array());  // adapt if not array-backed
          console.log('[dex] buffer ' + i + ' size=' + n + ' magic=' +
                      bytes.slice(0,4));               // expect 64 65 78 0a "dex\n"
          // write bytes to /data/local/tmp/dumped_<i>.dex via a File stream, then adb pull
        });
        return this.$init(buffers, parent);
      };
  });
  ```
  Scan memory for the `dex\n035`/`dex\n039` magic if the load site is native. Validate a
  dump by its magic before trusting it.

## Step 4 — Analyze / patch the DUMPED dex
Pull the dumped `.dex` into the workspace and treat it as the real code:
`list_dex_classes` / `disassemble_dex` to read smali, `jadx_decompile` for Java,
`query_code_graph(name="…")` to locate the logic. From here it's ordinary RE — apply
`smali-code-injection` / `native-patching` / the relevant bypass skill.

## Step 5 — Repackaging reality
Statically re-inserting a patched, unpacked dex back into a packer stub is often
impractical (the loader expects its encrypted blob). Prefer one of:
- Patch the payload the packer decrypts, if you can locate and re-encrypt it (rare).
- Deliver the fix as a **runtime Frida hook** on the unpacked code (say so — it needs the
  dev base), when a clean static repack isn't feasible.
Be explicit with the user about which is realistic for this packer rather than promising a
clean modded APK you can't produce.

## Critical Rules
- **Run first, dump second.** The real code doesn't exist statically; don't waste effort
  decompiling the stub — get it running and dump.
- **Validate every dump** by its `dex\n0xx` magic and class count before analyzing; a
  partial/pre-decrypt buffer wastes hours.
- **Expect multiple dex + native decryptors.** Big apps split across several payloads and
  may re-check integrity after load — dump all, and watch for a second guard.
- **Be honest about repackaging.** If a clean static repack isn't feasible for this
  packer, say so and offer the runtime-hook path — don't claim a modded APK you can't
  build.
