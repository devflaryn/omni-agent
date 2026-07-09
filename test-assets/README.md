# Test fixtures

Canonical location for binary test fixtures the agent's tests reference.

## `test_arm64.apk` (NOT committed — gitignored)

A **fat APK** (contains both `arm64-v8a` and `x86_64` native libraries — it is a
Roblox build). It is the fixture for the ABI-contract test
(`../test_abi_contract.py`) that guards **Finding B** (omnidroid-api.md §5):

- On an **x86** account it must install its **arm64-v8a** library and run
  through **libndk ARM translation** (`native_bridge_used=true`) — the real
  production path — instead of silently running native `x86_64` and bypassing
  the bridge.
- Forcing `abi=x86_64` on an x86 account must **fail** the test
  (`ABI CONTRACT VIOLATION`), never pass silently.

The binary is ~214 MB, so it is **gitignored** (`test-assets/*.apk`) rather than
committed. To run the ABI test, place a fat APK here named `test_arm64.apk`
(any app that ships both `arm64-v8a` and `x86_64` libs works). Relocated here
2026-07-09 from `Desktop/test/omnidroid/test_arm64.apk` so that folder is no
longer a test dependency.
