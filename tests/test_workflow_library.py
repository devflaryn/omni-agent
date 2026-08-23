"""Every built-in workflow must compile, expose valid meta, and survive a full
dry-run. This is the guard that a library entry cannot rot silently."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import workflows
from workflows import library
from workflows import runtime as R

EXPECTED = {"review-changes", "understand-subsystem", "deep-research",
            "exhaustive-audit", "migrate", "design-panel",
            "reconstruct-native-source"}

# Args each library workflow needs to dry-run meaningfully.
ARGS = {
    "review-changes": {"target": "HEAD"},
    "understand-subsystem": {"paths": ["src/a", "src/b"]},
    "deep-research": {"question": "how does X work"},
    "exhaustive-audit": {"target": "src/"},
    "migrate": {"description": "rename foo to bar", "sites": ["src/a.py"]},
    "design-panel": {"problem": "how should we cache"},
    "reconstruct-native-source": {"so": "lib/arm64-v8a/libfoo.so"},
}


class FakeAgentDef:
    def __init__(self, name, is_write=False):
        self.name = name
        self.is_write = is_write
        self.mode = "write" if is_write else "read"


def _install(monkeypatch):
    monkeypatch.setattr(R, "get_agent", lambda n: FakeAgentDef(
        n, is_write=n in ("implementer", "engineer",
                          "native-triage", "source-reconstructor")))
    monkeypatch.setattr(R, "run_subagent",
               lambda *a, **k: (_ for _ in ()).throw(
                   AssertionError("dry-run must not reach the engine")))


def test_every_expected_workflow_is_listed():
    names = {w["name"] for w in library.list_workflows()}
    assert EXPECTED <= names, f"missing: {EXPECTED - names}"


def test_every_workflow_has_a_description_and_when_to_use():
    for w in library.list_workflows():
        assert w["description"], f"{w['name']} has no description"
        assert w["when_to_use"], f"{w['name']} has no when_to_use"


def test_every_workflow_dry_runs_clean(monkeypatch):
    _install(monkeypatch)
    for w in library.list_workflows():
        src = library.load_source(w["name"])
        out = workflows.validate(src, args=ARGS.get(w["name"], {}))
        assert out["ok"], f"{w['name']} failed dry-run: {out['error']}"


def test_migrate_declares_scope_on_its_writers(monkeypatch):
    # A write agent without scope would be rejected by the runtime; this asserts
    # the library entry does it right rather than relying on the error path.
    src = library.load_source("migrate")
    assert "scope=" in src


def test_unknown_name_is_a_clear_error():
    try:
        library.load_source("no-such-workflow")
        raise AssertionError("expected an error")
    except Exception as e:
        assert "no-such-workflow" in str(e)


def test_every_builtin_declares_a_valid_args_schema():
    from workflows import sandbox as SB
    for w in library.list_workflows():
        meta = SB.extract_meta(library.load_source(w["name"]))
        schema = meta.get("args_schema")
        assert isinstance(schema, dict) and schema, \
            f"{w['name']} has no args_schema — the launch form cannot build a form for it"
        assert SB.validate_args_schema(schema) == []


def test_list_workflows_surfaces_args_schema():
    # Declared in the source but dropped by discovery would leave the launch
    # form and the tool description with nothing to read.
    for w in library.list_workflows():
        assert "args_schema" in w, f"{w['name']}: discovery dropped args_schema"
        assert w["args_schema"], f"{w['name']}: args_schema came through empty"


def test_declared_args_match_the_args_each_workflow_actually_reads():
    # A schema advertising an arg the script ignores sends the user to fill in a
    # field that does nothing; the reverse hides a required input.
    import re
    for w in library.list_workflows():
        src = library.load_source(w["name"])
        from workflows import sandbox as SB
        declared = set(SB.extract_meta(src).get("args_schema") or {})
        used = set(re.findall(r"""\(args or \{\}\)\.get\(\s*["'](\w+)["']""", src))
        used |= set(re.findall(r"""args\[\s*["'](\w+)["']\s*\]""", src))
        assert declared == used, (
            f"{w['name']}: declared {sorted(declared)} but script reads {sorted(used)}")


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig_run, _orig_get = R.run_subagent, R.get_agent
    failed = 0
    for t, needs_mp in [(test_every_expected_workflow_is_listed, False),
                        (test_every_workflow_has_a_description_and_when_to_use, False),
                        (test_every_workflow_dry_runs_clean, True),
                        (test_migrate_declares_scope_on_its_writers, True),
                        (test_unknown_name_is_a_clear_error, False),
                        (test_every_builtin_declares_a_valid_args_schema, False),
                        (test_list_workflows_surfaces_args_schema, False),
                        (test_declared_args_match_the_args_each_workflow_actually_reads, False)]:
        try:
            t(monkeypatch) if needs_mp else t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
        finally:
            R.run_subagent, R.get_agent = _orig_run, _orig_get
    print("OK" if not failed else f"{failed} FAILED")
    _sys.exit(1 if failed else 0)
