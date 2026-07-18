# Frida recipes (Android)

Ready hooks to pass to `frida_run_script`. Adapt class/method names to the target
(find them with `query_code_graph` / `jadx_decompile` first). All run against the dev
base (emulator + frida-server). Keep scripts small and log what they see.

## Spawn + resume (needed for startup checks)
Early checks (root/anti-debug/integrity) run before you can attach. Spawn so the hook
is installed first, then resume:
```js
Java.perform(function () {
  // ... install your hooks here ...
});
// The framework spawns/resumes the target package for a spawn-mode run; hooks in
// Java.perform are in place before app code runs.
```

## Override a Java boolean check (root / emulator / debug / license)
```js
Java.perform(function () {
  var C = Java.use('com.app.security.RootCheck');
  C.isDeviceRooted.overload().implementation = function () {
    console.log('[hook] isDeviceRooted -> forced false');
    return false;
  };
});
```
Overloaded method? Name the exact signature in `.overload('java.lang.String', 'int')`.
Enumerate overloads: `C.methodName.overloads.forEach(o => console.log(o));`

## Watch arguments and return values (observe before changing)
```js
Java.perform(function () {
  var M = Java.use('com.app.net.ApiSigner');
  M.sign.implementation = function (payload) {
    var r = this.sign(payload);
    console.log('[trace] sign("' + payload + '") = ' + r);
    return r;                       // read-only: return the real value
  };
});
```

## Dump a runtime-decrypted string / key
```js
Java.perform(function () {
  var Cipher = Java.use('javax.crypto.Cipher');
  Cipher.doFinal.overload('[B').implementation = function (b) {
    var out = this.doFinal(b);
    try { console.log('[cipher] ' + Java.use('java.lang.String').$new(out)); } catch (e) {}
    return out;
  };
});
```

## Enumerate loaded classes / find the check by name
```js
Java.perform(function () {
  Java.enumerateLoadedClasses({
    onMatch: function (n) { if (n.toLowerCase().indexOf('root') >= 0 ||
                                 n.toLowerCase().indexOf('integrity') >= 0) console.log(n); },
    onComplete: function () {}
  });
});
```

## Native function hook (Interceptor) — trace a JNI/native check
```js
var base = Module.findBaseAddress('libnative.so');
var addr = base.add(0x1234);         // offset from ghidra/nm
Interceptor.attach(addr, {
  onEnter: function (args) { this.a0 = args[0]; },
  onLeave: function (ret) {
    console.log('[native] ret was ' + ret + ' -> forcing 1');
    ret.replace(0x1);                // force success (adapt to the ABI/return meaning)
  }
});
```
Replace a whole function by symbol:
```js
var f = Module.getExportByName('libnative.so', 'check_signature');
Interceptor.replace(f, new NativeCallback(function () { return 1; }, 'int', []));
```

## Anti-debug / ptrace bypass
```js
var ptrace = Module.getExportByName(null, 'ptrace');
Interceptor.replace(ptrace, new NativeCallback(function () { return 0; }, 'long',
  ['int','int','pointer','pointer']));
```
Also common: hook `fork`, `kill`, `/proc/self/status` reads (`fopen`/`read` of `TracerPid`).

## SSL unpinning
Prefer the built-in one-shot: `frida_bypass_ssl_pinning`. If a custom pinner resists it,
hook the specific `checkServerTrusted` / `CertificatePinner.check` per the
`ssl-pinning-bypass` skill's patterns.

## Notes
- `frida_trace` is the fastest way to WATCH a set of methods without writing a script —
  reach for it first; write a `frida_run_script` hook when you need to CHANGE behavior.
- Log generously (`console.log`) — the hook's output is your evidence for the static patch.
- After a hook proves the fix, record the exact class/method or `lib.so`+offset; that is
  what you patch statically (Frida won't ship with the APK).
