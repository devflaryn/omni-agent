"""Every built-in workflow must compile, expose valid meta, and survive a full
dry-run. This is the guard that a library entry cannot rot silently."""
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import workflows
from workflows import library
from workflows import runtime as R

EXPECTED = {"review-changes", "understand-subsystem", "deep-research",
            "exhaustive-audit", "migrate", "design-panel"}

# Args each library workflow needs to dry-run meaningfully.
ARGS = {
    "review-changes": {"target": "HEAD"},
    "understand-subsystem": {"paths": ["src/a", "src/b"]},
    "deep-research": {"question": "how does X work"},
    "exhaustive-audit": {"target": "src/"},
    "migrate": {"description": "rename foo to bar", "sites": ["src/a.py"]},
    "design-panel": {"problem": "how should we cache"},
}


class FakeAgentDef:
    def __init__(self, name, is_write=False):
        self.name = name
        self.is_write = is_write
        self.mode = "write" if is_write else "read"


def _install(monkeypatch):
    monkeypatch.setattr(R, "get_agent", lambda n: FakeAgentDef(
        n, is_write=n in ("implementer", "engineer")))
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


if __name__ == "__main__":
    import types
    monkeypatch = types.SimpleNamespace(setattr=lambda o, n, v: setattr(o, n, v))
    _orig_run, _orig_get = R.run_subagent, R.get_agent
    failed = 0
    for t, needs_mp in [(test_every_expected_workflow_is_listed, False),
                        (test_every_workflow_has_a_description_and_when_to_use, False),
                        (test_every_workflow_dry_runs_clean, True),
                        (test_migrate_declares_scope_on_its_writers, True),
                        (test_unknown_name_is_a_clear_error, False)]:
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
