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

## Redirect a curl/c-ares app to a local server (by IP — hosts file won't work)
Native apps using libcurl+**c-ares** ignore `/etc/hosts` AND `getaddrinfo`, so redirect at
`connect()` **by destination IP**. Rewrite the dest to the host gateway (`10.0.2.2`) + your port.
```js
function exp(n,m){ try{ return m?Process.getModuleByName(m).getExportByName(n):Module.getGlobalExportByName(n);}catch(e){} return null; }
var HOST=[10,0,2,2], PORT=8443;                 // 10.0.2.2 = the QEMU host; your server
Interceptor.attach(exp('connect','libc.so'), { onEnter:function(a){
  var sa=a[1]; if (sa.readU16()!==2) return;    // AF_INET only
  var ip=[sa.add(4).readU8(),sa.add(5).readU8(),sa.add(6).readU8(),sa.add(7).readU8()].join('.');
  var port=(sa.add(2).readU8()<<8)|sa.add(3).readU8();
  if (/^185\.199\.(10[89]|11[01])\./.test(ip) && port===443){   // e.g. GitHub Fastly range
    for (var i=0;i<4;i++) sa.add(4+i).writeU8(HOST[i]);          // dest addr -> 10.0.2.2
    sa.add(2).writeU8((PORT>>8)&0xff); sa.add(3).writeU8(PORT&0xff);  // dest port -> 8443
  }
}});
```
Find the target IP first by tracing `getaddrinfo` + `connect` (log the host and the dest IP).
Full workflow (TLS, the iptables-DNAT alternative, the fake server) is in the
**`local-server-redirect`** skill.

## API note — Frida 17 removed `Module.getExportByName(null, name)`
The `null`-module lookups in the recipes above fail on the dev base's Frida (17.x). Use:
- `Module.getGlobalExportByName('name')` (global), or
- `Process.getModuleByName('libc.so').getExportByName('name')` (specific module).
Also: `Java` is **not** a default global — the agent runner injects it; if you drive Frida
yourself, load the java bridge before `Java.perform`. And native exports resolve to nothing
if the `.so` is fully stripped — hook by **offset** (`Module.findBaseAddress` + add) then.

## Notes
- `frida_trace` is the fastest way to WATCH a set of methods without writing a script —
  reach for it first; write a `frida_run_script` hook when you need to CHANGE behavior.
- Log generously (`console.log`) — the hook's output is your evidence for the static patch.
- After a hook proves the fix, record the exact class/method or `lib.so`+offset; that is
  what you patch statically (Frida won't ship with the APK).
