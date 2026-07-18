# Root-detection signals & search patterns

Sweep for these with `query_code_graph(name="…")` (bare name), `search_smali`,
`grep_file`, and `extract_strings` on `.so`. Presence of any is a check to neutralize.

## su-binary / file paths (the classic check)
```
/system/xbin/su
/system/bin/su
/sbin/su
/system/app/Superuser.apk
/system/xbin/busybox
/system/bin/.ext/.su
/system/usr/we-need-root/
/data/local/bin/su   /data/local/xbin/su   /data/local/su
/su/bin/su
/system/xbin/daemonsu
```
Also `which su`, `Runtime.getRuntime().exec("su")`, `ProcessBuilder(... "su")`,
`new File("/system/xbin/su").exists()`.

## Build tags / properties (emulator + test-keys)
```
test-keys                 (Build.TAGS contains "test-keys")
ro.build.tags
ro.debuggable = 1
ro.secure = 0
Build.FINGERPRINT / Build.MODEL / Build.MANUFACTURER (generic/emulator/goldfish/ranchu)
```

## Root-management app packages (checked via PackageManager)
```
com.topjohnwu.magisk           (Magisk)
eu.chainfire.supersu
com.noshufou.android.su
com.koushikdutta.superuser
com.thirdparty.superuser
com.zachspong.temprootremovejb
com.ramdroid.appquarantine
com.saurik.substrate           (Cydia Substrate)
de.robv.android.xposed.installer (Xposed)
```

## RootBeer library (very common)
Classes/methods: `com.scottyab.rootbeer.RootBeer`, `isRooted()`, `isRootedWithoutBusyBoxCheck()`,
`checkForBinary("su")`, `checkForDangerousProps()`, `checkForRWPaths()`,
`detectTestKeys()`, `checkSuExists()`, `checkForRootNative()`, `checkForMagiskBinary()`.
Native side: `librootbeer.so` / `libtool-checker.so`.

## Magisk-specific
```
/sbin/.magisk    /cache/.disable_magisk    magisk    MagiskSU    zygisk
com.topjohnwu.magisk in PackageManager / running services
unix socket named with a magisk marker
```

## SafetyNet / Play Integrity (server-validated — usually NOT client-patchable)
```
com.google.android.gms.safetynet.SafetyNetApi / attest
com.google.android.play.core.integrity / IntegrityManager / requestIntegrityToken
"ctsProfileMatch"   "basicIntegrity"   "MEETS_DEVICE_INTEGRITY"
```
The verdict is checked on the app's server. Client-side patching of the *request* doesn't
change the *server's* decision — report this limitation rather than claiming a bypass.

## Native indicators (in .so via extract_strings / nm_symbols)
The same su paths and prop names above, plus symbol names like `checkRoot`, `is_rooted`,
`detect_su`, `check_mounts`, `/proc/mounts` reads looking for `su`/`magisk`.

## Typical patch targets
- Java: any method returning `Z` named `isRooted` / `isDeviceRooted` / `checkRoot*` /
  `detect*` → force `false`. RootBeer: `isRooted()` and each `checkFor*`.
- Native: the function that aggregates the above → `patch_function_return` to the clean
  value or `nop_function`.
- The `Runtime.exec("su")` probe → make the surrounding check treat "not found" as the
  result.
