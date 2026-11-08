"""native_triage: OSS fingerprinting + library/custom partition of a .so.

Everything is driven through a fake run_cmd so the tests are hermetic — no real
ELF, no strings/nm/rabin2 on the box. The fake keys off the command text to
return canned strings / symbol tables, which is exactly the surface the tools
match against.
"""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import tools.native_triage as NT


def _fake_run(strings_out="", nm_out="", rabin_out="", exists=True):
    """Build a run_cmd stand-in that answers by inspecting the command string."""
    def run(cmd, timeout=120):
        if "echo OK" in cmd or "echo MISSING" in cmd:
            return {"stdout": "OK" if exists else "MISSING", "stderr": "", "returncode": 0}
        if cmd.strip().startswith("strings"):
            return {"stdout": strings_out, "stderr": "", "returncode": 0}
        if cmd.strip().startswith("nm"):
            return {"stdout": nm_out, "stderr": "", "returncode": 0}
        if "rabin2 -s" in cmd:
            return {"stdout": rabin_out, "stderr": "", "returncode": 0}
        if "readelf" in cmd:
            return {"stdout": rabin_out, "stderr": "", "returncode": 0}
        return {"stdout": "", "stderr": "", "returncode": 0}
    return run


def _patch(monkeypatch, **kw):
    monkeypatch.setattr(NT, "run_cmd", _fake_run(**kw))
    # normalize_path/wpath touch the workspace; stub them to identity so the
    # tools run without an active project folder.
    monkeypatch.setattr(NT, "normalize_path", lambda p: p)
    monkeypatch.setattr(NT, "wpath", lambda p: p)


def test_detects_luau_and_openssl(monkeypatch):
    _patch(monkeypatch,
           strings_out="Luau\nattempt to compare\nOpenSSL 1.1.1\nno start line\n",
           nm_out="0000 T luau_load\n0000 T luaD_call\n0000 T EVP_EncryptInit\n0000 T SHA256_Init\n")
    out = NT.identify_native_components("libfoo.so")
    names = {d["name"] for d in out["detected"]}
    assert "Luau" in names
    assert any("OpenSSL" in n for n in names)
    # every detection carries an upstream URL to point reconstruction at
    assert all(d["source_url"] for d in out["detected"])


def test_missing_file_is_a_clear_error(monkeypatch):
    _patch(monkeypatch, exists=False)
    out = NT.identify_native_components("gone.so")
    assert "error" in out and "No such file" in out["error"]


def test_no_false_positive_on_a_single_generic_symbol(monkeypatch):
    # `inflate` alone (one generic symbol, no zlib banner) must NOT claim zlib.
    _patch(monkeypatch,
           strings_out="some random app string\n",
           nm_out="0000 T inflate\n0000 T my_custom_thing\n")
    out = NT.identify_native_components("libfoo.so")
    assert "zlib" not in {d["name"] for d in out["detected"]}


def test_partition_splits_library_from_custom(monkeypatch):
    _patch(monkeypatch,
           strings_out="Luau\nattempt to compare\n",
           nm_out=("0000 T luau_load\n"          # library (Luau)
                   "0000 T luaD_call\n"          # library (Luau)
                   "0000 T _ZNSt6vectorIiE\n"    # library (STL mangling)
                   "0000 T GameSecurityCheck\n"  # custom
                   "0000 T decrypt_asset\n"))    # custom
    part = NT.partition_native_functions("libfoo.so", batch_size=1)
    assert part["custom_function_count"] == 2
    assert part["library_function_count"] >= 2
    flat = [n for b in part["batches"] for n in b]
    assert "GameSecurityCheck" in flat and "decrypt_asset" in flat
    assert "luau_load" not in flat  # library code is not handed to the sourcer


def test_partition_truncation_is_reported(monkeypatch):
    syms = "".join(f"0000 T custom_fn_{i}\n" for i in range(10))
    _patch(monkeypatch, strings_out="app\n", nm_out=syms)
    part = NT.partition_native_functions("libfoo.so", batch_size=3, max_functions=4)
    assert part["truncated"] is True
    assert part["dropped_custom_functions"] == 6
    assert sum(len(b) for b in part["batches"]) == 4


if __name__ == "__main__":
    import types
    mp = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(mp)
            print("PASS", name)
