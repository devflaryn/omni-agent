"""ABI-contract integration test for the qemu (omnidroid) backend — the client
side of Finding B (omnidroid-api.md §5).

Fixture: test-assets/test_arm64.apk (a FAT APK: arm64-v8a + x86_64). On an x86
account the agent MUST install the arm64 lib and exercise libndk TRANSLATION
(native_bridge_used=true); forcing x86_64 MUST FAIL, never pass silently.

This is an INTEGRATION test (needs the emulator), run manually:
  - Point at the engine:  set QEMU_MANAGER_PATH to omnidroid's manager/omni.py
    (or its built exe), or have the bundled tools/omnidroid exe present.
  - Provisioned x86 account: OMNI_TEST_ACCOUNT (default 'dave').
  - adb on PATH.
  Run:  python test_abi_contract.py
"""
import os
import sys
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(HERE, "test-assets")
FIXTURE = os.path.join(FIXTURE_DIR, "test_arm64.apk")
ACCOUNT = os.environ.get("OMNI_TEST_ACCOUNT", "dave")


def main():
    assert os.path.isfile(FIXTURE), (
        f"fixture missing: {FIXTURE}\nPlace a fat APK there (see test-assets/README.md).")
    sys.path.insert(0, HERE)
    import docker_sandbox
    # Resolve the fixture workspace-relative WITHOUT Docker: the fixtures dir is
    # the workspace for this test, so install_apk_on_emulator("test_arm64.apk")
    # maps to FIXTURE on the host.
    docker_sandbox._workspace_host_path = FIXTURE_DIR
    import tools.android_emulator as ae

    boot = ae.ensure_emulator_running(device_name=ACCOUNT, reset=False, boot_timeout=300)
    assert "BOOT_OK" in (boot.get("stdout") or ""), "emulator boot failed:\n" + str(boot)

    # Wrong path FIRST (leaves x86_64), restored to arm64 by the good path below.
    bad = ae.install_apk_on_emulator("test_arm64.apk", device_name=ACCOUNT, abi="x86_64")
    assert bad.get("error") and "ABI CONTRACT VIOLATION" in bad["error"], \
        "wrong ABI did NOT fail the test:\n" + str(bad)
    print("PASS  wrong-ABI guard:", bad["error"][:130])

    # Good path: default install on an x86 account pins arm64-v8a -> translation.
    good = ae.install_apk_on_emulator("test_arm64.apk", device_name=ACCOUNT)
    assert not good.get("error"), "ABI-safe install errored: " + str(good.get("error"))
    assert "native_bridge_used=True" in good.get("stdout", ""), \
        "translation path not confirmed:\n" + str(good)
    print("PASS  good path:", good["stdout"])

    # Leave the account stopped, on the correct arm64 install.
    exe = os.environ.get("QEMU_MANAGER_PATH")
    if exe and exe.endswith(".py"):
        subprocess.run([sys.executable, exe, "stop", ACCOUNT, "--json"],
                       capture_output=True, text=True, timeout=180)

    print("\nABI CONTRACT TEST PASSED against fixture:", FIXTURE)


if __name__ == "__main__":
    main()
