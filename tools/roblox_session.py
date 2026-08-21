"""Drive a live omnidroid instance the way the PRODUCT does: pick an account
(a Roblox token) and a place, and land in the game.

These wrap the engine's `omni play` / `omni session` (contracts/omni-session.md)
rather than reimplementing them, so the agent exercises the exact path a customer
gets. That is the point: a test that logs in by tapping through Roblox's UI would
not be testing the product.

What these deliberately do NOT include: any control over auto-screenshots. On a
debug boot the recorder starts with QEMU and runs for the instance's lifetime —
it is not a tool, not a toggle, and not something the agent can turn off. Read
the frames with read_auto_screenshots.
"""
import os
import tempfile

import devices
from tool_registry import registry
from tools.android_emulator import (
    _default_device_name, _parse_json_object, _run_qemu, _truthy,
    _validate_session_id,
)
from tools.common import resolve_workspace_path

ROBLOX_PACKAGE = "com.roblox.client"


def _place_error(place_id):
    """A pasted game URL is the likeliest mistake; catch it here with a message
    that says what to do, instead of letting the engine's typed error surface as
    a bare 'bad_place'."""
    s = str(place_id).strip()
    if s.isdigit() and int(s) > 0:
        return None
    if "roblox.com" in s:
        return ("place_id must be the numeric placeId, not a URL. In "
                "https://www.roblox.com/games/606849621/Jailbreak the placeId "
                "is 606849621.")
    return f"place_id must be a positive integer, got {place_id!r}."


def _with_token_file(token, argv):
    """Pass a token to the engine via a 0600 temp file rather than argv.

    A .ROBLOSECURITY cookie is full account access, and argv is readable by every
    process on the host. Returns (argv, cleanup)."""
    if not token:
        return argv, lambda: None
    fd, path = tempfile.mkstemp(prefix="omni-token-", suffix=".txt")
    try:
        os.write(fd, token.strip().encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass

    def _cleanup():
        try:
            os.unlink(path)
        except OSError:
            pass

    return argv + ["--token-file", path], _cleanup


def _summarize(parsed, res, action):
    if isinstance(parsed, dict) and parsed.get("ok"):
        return parsed
    detail = ""
    if isinstance(parsed, dict):
        detail = parsed.get("message") or parsed.get("error") or ""
        if parsed.get("reason"):
            detail = f"{detail} ({parsed['reason']})".strip()
    if not detail:
        detail = (res.get("stderr") or res.get("stdout") or "").strip()[:600]
    return {"error": f"{action} failed: {detail}"}


@registry.register(
    name="play_roblox",
    description=(
        "Boot (or reuse) an omnidroid instance and land INSIDE a Roblox place, logged in as a saved "
        "account, with no menu and no simulated taps. This is the product's real launch path: the "
        "engine cold-starts Roblox and the in-guest kiosk fires roblox://experiences/start?placeId=... "
        "at the app's exported ActivityProtocolLaunch. Login is by .ROBLOSECURITY cookie (the Roblox "
        "Android client has NO auth parameter in its deep-link scheme), which the injected bootstrap "
        "installs into Roblox's own WebView cookie jar — see contracts/omni-session.md. "
        "MODERN ACCOUNT MODEL: pass `account` (a saved Roblox USERNAME from `omni login`, listed by "
        "list_roblox_accounts) and the engine looks up its cookie automatically — no token to handle. "
        "The instance is named for the account and is a thin (~0.4 MB) auto-created overlay, so two "
        "different accounts can run at once. Works identically on dev and production bases."
    ),
    params_schema={
        "place_id": "integer or string (REQUIRED — the numeric Roblox placeId to join, e.g. 606849621. NOT a URL: in https://www.roblox.com/games/606849621/Jailbreak the placeId is 606849621)",
        "account": "string (the saved Roblox USERNAME to play as — from list_roblox_accounts / `omni login`. Its cookie is resolved automatically; this also names the instance. PREFER this over token)",
        "token": "string (optional OVERRIDE — a raw .ROBLOSECURITY cookie for an account not saved via omni login. Written to a 0600 temp file, never to argv. Usually omit and use `account` instead)",
        "session_name": "string (optional — override the instance name; defaults to `account`, else 'omniagent'. Give distinct names to run several instances)",
        "job_id": "string (optional — gameInstanceId/JobId to join a SPECIFIC running server instead of matchmaking)",
        "launch_data": "string (optional — <=200 bytes, readable in-game via Player:GetJoinData())",
        "user_id": "integer (optional — informational: which Roblox user the token belongs to)",
        "debug": "boolean (optional — DEBUG boot: attach the devkit (frida + omni-* tools) to the same dual-use image, for runtime-hooking a Roblox build under test. For the standard 'does this build work' check, leave false. Note: apk_path installs on ANY base and does NOT require this.)",
        "timeout": "integer (optional — seconds to wait for boot; the engine picks a first-boot-aware default)",
    },
    output=("JSON: {ok, place_id, deeplink, booted, launched, session:{...token redacted...}, "
            "kiosk:{...}}. On failure, {error} naming the stage that failed (boot_timeout, "
            "kiosk_missing, roblox_not_installed, no_deeplink_handler, no_token)."),
    when_to_use=(
        "Use this to put an instance in a real gameplay state — before capturing frames, reproducing "
        "a bug, or checking that a Roblox build you just installed actually loads a place. Prefer it "
        "over launch_app_on_emulator for Roblox: that only opens the app's home screen and leaves you "
        "at a login/menu, which is not what customers get. Call list_roblox_accounts first to see "
        "which usernames are available to play as."
    ),
)
def play_roblox(place_id, account=None, token=None, session_name=None,
                job_id=None, launch_data=None, user_id=None, debug=False,
                timeout=None, apk_path=None):
    _err = devices.require_local("play_roblox")
    if _err:
        return _err
    # Modern model: the account username IS the instance name, so the engine
    # resolves its saved cookie automatically. `account` therefore takes
    # precedence over session_name for NAMING — otherwise a mismatched
    # session_name would make the engine look up the wrong username's cookie.
    # session_name is only the instance name in the legacy/token path (no
    # account given).
    session_name = account or session_name or _default_device_name()
    err = _validate_session_id(session_name)
    if err:
        return err
    err = _place_error(place_id)
    if err:
        return {"error": err}

    # `start` absorbed `play` in omnidroid's diskless rework: there is no
    # separate create/play step any more, and no --ephemeral knob — every
    # instance boots the shared base snapshot=on with no per-account disk, so
    # concurrency and a clean device each boot are the ONLY model. Re-delivery
    # to an ALREADY-RUNNING instance is a different command (`session --play`,
    # see set_roblox_account); `start` refuses if the instance is up.
    argv = ["start", session_name, "--place", str(place_id), "--json"]
    if apk_path:
        # One-shot: omnidroid installs this APK after boot and BEFORE delivering
        # the session, then checks the guest actually logged in. `--apk` works on
        # EVERY base now (no dev gate) and does NOT force a debug boot — frida is
        # a separate, explicit opt-in.
        argv += ["--apk", str(apk_path)]
    if _truthy(debug):
        # DEBUG boot: attach the devkit (frida + omni-* tools) to the same
        # dual-use image, for runtime-hooking the build under test. Per-boot, so
        # it applies to THIS boot only.
        argv += ["--debug"]
    if job_id:
        argv += ["--job", str(job_id)]
    if launch_data:
        argv += ["--launch-data", str(launch_data)]
    if user_id:
        argv += ["--user-id", str(user_id)]
    if timeout:
        argv += ["--timeout", str(int(timeout))]
    argv, cleanup = _with_token_file(token, argv)
    try:
        # A cold first boot runs dexopt; the engine's own timeout governs, this
        # is only the outer guard.
        parsed, res, _pd = _run_qemu(argv, timeout=int(timeout or 1800) + 120)
    except RuntimeError as e:
        return {"error": str(e)}
    finally:
        cleanup()
    return _summarize(parsed, res, "play_roblox")


@registry.register(
    name="set_roblox_account",
    description=(
        "Switch which Roblox account the instance is logged in as, or read back the current session. "
        "Setting a token on a RUNNING instance cold-starts Roblox before re-joining: the client caches "
        "the authenticated user in-process, so a token swap on a live process would silently keep "
        "playing as the previous account. With no token and no place, this just reports the stored "
        "session (token always redacted)."
    ),
    params_schema={
        "token": "string (optional — the new account's .ROBLOSECURITY cookie)",
        "place_id": "integer or string (optional — also change the place to join)",
        "session_name": "string (optional — the omnidroid account name; default 'omniagent')",
        "play": "boolean (optional, default true when a token or place is given — re-join immediately with the new session)",
        "clear": "boolean (optional — forget the token+place and log the live instance out)",
    },
    output="JSON: {ok, session:{place_id, user_id, has_token, token:'<redacted>'}, applied:{...}}",
    when_to_use=(
        "Use to test multi-account behaviour, to move an instance to a different account between test "
        "runs, or to check which account/place an instance is currently configured for."
    ),
)
def set_roblox_account(token=None, place_id=None, session_name=None, play=None,
                       clear=False):
    _err = devices.require_local("set_roblox_account")
    if _err:
        return _err
    session_name = session_name or _default_device_name()
    err = _validate_session_id(session_name)
    if err:
        return err

    argv = ["session", session_name, "--json"]
    if clear:
        argv += ["--clear"]
    else:
        if place_id is not None:
            err = _place_error(place_id)
            if err:
                return {"error": err}
            argv += ["--place", str(place_id)]
        if token is None and place_id is None:
            # Read-only: a bare `session <name> --json` already reports the
            # current session (place_id + redacted token). `--show` was deleted.
            pass
        elif play is None or play:
            argv += ["--play"]
    argv, cleanup = _with_token_file(token, argv)
    try:
        parsed, res, _pd = _run_qemu(argv, timeout=300)
    except RuntimeError as e:
        return {"error": str(e)}
    finally:
        cleanup()
    return _summarize(parsed, res, "set_roblox_account")


@registry.register(
    name="login_roblox_account",
    description=(
        "Register (or refresh) a Roblox account from a .ROBLOSECURITY cookie you already have — e.g. a "
        "cookie.txt you were handed for testing. Wraps the engine's `omni login --token-file` (headless: "
        "no browser window, nothing to click, nothing for you to sign into). The cookie is held to the "
        "SAME bar as an interactive sign-in — it must actually resolve to a real authenticated Roblox "
        "user, not just be non-empty — and is then saved under that account's real USERNAME (auto-detected "
        "from Roblox, NOT a name you pick) in the shared accounts.json, the same store `omni login`'s "
        "browser flow writes to. This is idempotent by construction: the same cookie always resolves to "
        "the same username, so logging in again just refreshes that ONE account's cookie in place — it "
        "never creates a second account or a second instance for the same underlying Roblox account. This "
        "is the ONLY way the agent can add a new playable account; there is no other route."
    ),
    params_schema={
        "token": "string (optional — the raw .ROBLOSECURITY cookie. Prefer token_file: this puts the "
                 "cookie directly in your tool call, which is logged in the transcript)",
        "token_file": "string (optional — path to a file containing the cookie, e.g. 'cookie.txt' in "
                     "the project root. Preferred over token)",
    },
    output=("JSON: {ok, username, user_id}. `username` is what to pass to play_roblox(account=...) next "
            "— it also names the instance. On failure {error} — almost always 'bad_token' (the cookie is "
            "empty, expired, or Roblox never resolved it to a real signed-in user)."),
    when_to_use=(
        "Call this FIRST whenever you are handed a cookie (file or string) and asked to test/play as that "
        "account — before play_roblox, and before installing any APK build for it. Then call "
        "play_roblox(account=<returned username>, place_id=...). Do not pass a raw cookie straight to "
        "play_roblox's/set_roblox_account's token= unless you deliberately want an ephemeral, UNSAVED "
        "session — login_roblox_account is what makes it a saved, reusable, de-duplicated account with a "
        "real username instead of a generic instance name. For the common 'cookie + apk + place id' case "
        "end to end in one call, use launch_roblox_build instead. Never reach for run_apk_test_session for "
        "a Roblox cookie/login flow — it has no concept of accounts or cookies at all."
    ),
)
def login_roblox_account(token=None, token_file=None):
    _err = devices.require_local("login_roblox_account")
    if _err:
        return _err
    if not token and not token_file:
        return {"error": "give either token or token_file (a .ROBLOSECURITY cookie)"}
    argv = ["login", "--json"]
    cleanup = lambda: None
    if token_file:
        try:
            resolved = resolve_workspace_path(token_file)
        except RuntimeError as e:
            return {"error": str(e)}
        if not os.path.isfile(resolved):
            return {"error": f"token_file not found: {token_file}"}
        argv += ["--token-file", resolved]
    else:
        argv, cleanup = _with_token_file(token, argv)
    try:
        parsed, res, _pd = _run_qemu(argv, timeout=60)
    except RuntimeError as e:
        return {"error": str(e)}
    finally:
        cleanup()
    if isinstance(parsed, dict) and parsed.get("ok"):
        return {"ok": True, "username": parsed.get("username"), "user_id": parsed.get("user_id")}
    return _summarize(parsed, res, "login_roblox_account")


def _apk_step_failed(res):
    """decode_apk/recompile_apk/sign_apk return a raw run_cmd() result:
    {"error": ...} if the harness itself couldn't run the command, else
    {"returncode", "stdout", "stderr"} where a non-zero code is
    apktool/zipalign/apksigner itself failing. Either shape is a failure."""
    if not isinstance(res, dict):
        return True
    if res.get("error"):
        return True
    rc = res.get("returncode")
    return rc is not None and rc != 0


def _apk_stage_error(res, stage):
    detail = (res.get("error") or res.get("stderr") or res.get("stdout") or "").strip()[:600]
    return {"error": f"{stage} failed: {detail}", "stage": stage}


def _rm_workspace_artifact(rel_path):
    """Best-effort delete of a workspace-relative build artifact (file or dir).

    launch_roblox_build's decode->recompile pipeline drops a large decompiled
    tree and a rebuilt APK under omni_build/ in the workspace. Those are pure
    intermediates once the build is installed, so they're cleaned up rather than
    left to pile up (a single Roblox decompile is ~400 MB). NEVER raises —
    cleanup failing must not turn a successful launch into an error."""
    try:
        p = resolve_workspace_path(rel_path)
    except Exception:
        return
    try:
        if os.path.isdir(p):
            import shutil
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p):
            os.remove(p)
    except OSError:
        pass


@registry.register(
    name="launch_roblox_build",
    description=(
        "The single correct call for 'here is a cookie and a place id (and maybe a new Roblox build to "
        "test) — get me logged in and into that game', end to end. This exists because that exact "
        "scenario previously failed silently: a STOCK Roblox APK has NO code path that ever reads a "
        "session cookie (see contracts/omni-session.md §1.2) — installing it as-is and delivering a "
        "cookie to it just lands on Roblox's own login screen, with no error raised anywhere. Composes: "
        "(1) login_roblox_account — registers/refreshes the cookie's account by its real Roblox username, "
        "never creating a duplicate; (2) IF apk_path is given: decode_apk -> inject_session_bootstrap -> "
        "recompile_apk -> sign_apk, so the build under test can actually plant the cookie, then installs "
        "it on the instance named for the resolved username; (3) play_roblox(account=username, "
        "place_id=...). Every stage is idempotent, so re-running with the same inputs is always safe."
    ),
    params_schema={
        "place_id": "integer or string (REQUIRED — the numeric Roblox placeId to land in)",
        "account": "string (optional — a saved Roblox USERNAME from `omni login` / list_roblox_accounts. Its cookie is resolved automatically and it names the instance. PREFER this over token/token_file when the account is already saved; give ONE of account / token / token_file)",
        "token": "string (optional — raw .ROBLOSECURITY cookie; give this OR token_file OR account)",
        "token_file": "string (optional — path to a file with the cookie, e.g. 'cookie.txt')",
        "apk_path": "string (optional — a Roblox APK to test, relative to the project root. Omit this to just "
                    "log in and play whatever Roblox build is ALREADY installed on the instance; pass it "
                    "when you have a NEW build to test)",
        "debug": "boolean (optional, default false — DEBUG boot: attach the devkit (frida + omni-* tools) "
              "for runtime-hooking the build under test. Installing a custom apk_path does NOT require this "
              "(APK swap works on every base); pass debug=true only when you need frida/root hooking.)",
        "timeout": "integer (optional — boot timeout in seconds; the engine picks a first-boot-aware "
                  "default)",
    },
    output=(
        "JSON: {ok, username, place_id, deeplink, booted, launched, session:{...}}. On failure {error, "
        "stage} naming exactly which stage failed (login, decode, inject, recompile, sign, install, play) "
        "— fix that stage and re-call; every earlier stage is idempotent, so you do not need to restart "
        "the whole pipeline."
    ),
    when_to_use=(
        "Use this instead of run_apk_test_session / install_apk_on_emulator / launch_app_on_emulator "
        "whenever the ask involves a Roblox cookie and a place id — that generic pipeline has no concept "
        "of accounts, cookies, or bootstrap injection, and WILL silently land you on Roblox's own login "
        "screen while reporting the install/launch itself as successful. Drop to the individual tools "
        "(login_roblox_account, inject_session_bootstrap, play_roblox, ...) only when you need to stop "
        "and inspect one specific stage."
    ),
)
def launch_roblox_build(place_id, account=None, token=None, token_file=None, apk_path=None,
                        debug=None, timeout=None):
    _err = devices.require_local("launch_roblox_build")
    if _err:
        return _err
    err = _place_error(place_id)
    if err:
        return {"error": err, "stage": "validate"}
    if not account and not token and not token_file:
        return {"error": "give one of account (a saved username), token, or token_file "
                         "(a .ROBLOSECURITY cookie)", "stage": "login"}

    if account:
        # Already-saved account: the engine resolves its cookie by username at play
        # time, so there is nothing to log in here — just use the name.
        err = _validate_session_id(account)
        if err:
            return {**err, "stage": "login"} if isinstance(err, dict) else {"error": err, "stage": "login"}
        username = account
    else:
        login_res = login_roblox_account(token=token, token_file=token_file)
        if login_res.get("error"):
            login_res = dict(login_res)
            login_res["stage"] = "login"
            return login_res
        username = login_res.get("username")
        if not username:
            return {"error": "login succeeded but returned no username", "stage": "login"}

    # Debug (frida) is an explicit opt-in, NOT implied by apk_path — the APK
    # swap works on every base without it.
    use_debug = _truthy(debug) if debug is not None else False

    if apk_path:
        # NO throwaway boot here any more. omnidroid's `start --apk` does
        # boot -> install -> deliver session -> verify login in ONE call, so the
        # old "boot, install, boot again" dance is not just wasteful — the second
        # boot would now hard-fail, because `start` refuses an instance that is
        # already running. Build the APK first, then hand it to a single start.
        from tools.apk_tools import decode_apk, recompile_apk, sign_apk
        from tools.session_bootstrap import inject_session_bootstrap

        decompiled_dir = f"omni_build/{username}_decoded"
        decode_res = decode_apk(apk_path, decompiled_dir)
        if _apk_step_failed(decode_res):
            return _apk_stage_error(decode_res, "decode")

        inject_res = inject_session_bootstrap(decompiled_dir)
        if inject_res.get("error"):
            return {"error": inject_res["error"], "stage": "inject"}

        built_apk = f"omni_build/{username}_build.apk"
        recompile_res = recompile_apk(decompiled_dir, built_apk, original_apk=apk_path)
        if _apk_step_failed(recompile_res):
            return _apk_stage_error(recompile_res, "recompile")
        # The decompiled tree (~400 MB) has done its job now that the APK is
        # rebuilt — remove it so it doesn't accumulate in the workspace. It's
        # kept only when an EARLIER stage (decode/inject/recompile) failed, where
        # it is the thing you'd inspect.
        _rm_workspace_artifact(decompiled_dir)

        sign_res = sign_apk(built_apk)
        if _apk_step_failed(sign_res):
            return _apk_stage_error(sign_res, "sign")

        # `start` refuses a running instance, and this flow owns the whole
        # lifecycle — clear any stale instance so the one-shot below can boot.
        _run_qemu(["stop", username, "--json"], timeout=300)

    play_res = play_roblox(place_id=place_id, account=username, debug=use_debug,
                           timeout=timeout,
                           apk_path=(built_apk if apk_path else None))
    if play_res.get("error"):
        play_res = dict(play_res)
        # Map the engine's one-shot failures onto the stage the caller must fix,
        # instead of burying them under a generic "play".
        play_res["stage"] = {
            "apk_install_failed": "install",
            # The APK installed and the cookie was delivered, but the guest never
            # reported a login — almost always a build with no OmniBootstrap in
            # it (re-run inject_session_bootstrap), or a dead cookie.
            "not_logged_in": "login_check",
        }.get(play_res.get("error"), "play")
        return play_res
    if apk_path:
        # Success: the built APK is now installed on the instance, so drop the
        # workspace copy (+ its .idsig) and the now-empty omni_build dir. A launch
        # then leaves NO build litter behind. On any failure above we returned
        # early, keeping the artifact for inspection.
        _rm_workspace_artifact(f"omni_build/{username}_build.apk")
        _rm_workspace_artifact(f"omni_build/{username}_build.apk.idsig")
        try:
            os.rmdir(resolve_workspace_path("omni_build"))
        except (OSError, RuntimeError):
            pass   # non-empty (another account's build) or gone — leave it
    play_res["username"] = username
    return play_res


@registry.register(
    name="list_roblox_accounts",
    description=(
        "List the Roblox accounts saved on this host (via `omni login`), so you can pick a username to "
        "pass to play_roblox(account=...). Accounts live in ONE accounts.json keyed by username; the "
        "cookies themselves are NEVER returned. Use --verify to also check each cookie still "
        "authenticates (Roblox invalidates a cookie on sign-out / password change)."
    ),
    params_schema={
        "verify": "boolean (optional — also check each saved cookie still authenticates with Roblox)",
    },
    output=("JSON: {ok, accounts: [{username, user_id, has_cookie, valid?}]}. Play one with "
            "play_roblox(account='<username>', place_id=...)."),
    when_to_use=(
        "Call before play_roblox to see which accounts are available, or to confirm an account's cookie "
        "is still valid before a test run. A fresh login is a human step (`omni login` opens a browser) "
        "— you cannot add accounts, only use the ones already saved."
    ),
)
def list_roblox_accounts(verify=False):
    _err = devices.require_local("list_roblox_accounts")
    if _err:
        return _err
    argv = ["accounts", "--json"]
    if _truthy(verify):
        argv += ["--verify"]
    try:
        parsed, res, _pd = _run_qemu(argv, timeout=120)
    except RuntimeError as e:
        return {"error": str(e)}
    if isinstance(parsed, dict) and "accounts" in parsed:
        # Defensive: strip any cookie field that might ever appear; the agent's
        # transcript must never carry a live credential.
        accts = [{k: v for k, v in a.items() if k != "cookie"}
                 for a in parsed.get("accounts", [])]
        return {"ok": True, "accounts": accts}
    detail = (res.get("stderr") or res.get("stdout") or "").strip()[:400]
    return {"error": f"list_roblox_accounts failed: {detail}"}
