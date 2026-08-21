"""The workflow runtime: the primitives a script actually calls.

CONCURRENCY, and why it is not a thread pool
--------------------------------------------
The obvious design — submit every agent() to one shared ThreadPoolExecutor —
DEADLOCKS. parallel() branches occupy every worker slot, then each branch calls
agent() and blocks waiting for a slot that only those same blocked branches
could free. Nothing ever completes.

So the relationship is inverted:
  * threads are unbounded and cheap — parallel() spawns one per branch,
    pipeline() one per item;
  * a SEMAPHORE, acquired inside agent(), caps real LLM concurrency.
A branch parked on the semaphore costs a few KB of committed stack, so hundreds
are fine. tests/test_workflow_runtime.py pins this with a deadlock regression
test that runs nested parallel/pipeline with the semaphore set to 1.
"""
import os
import threading
import time

from plugins import get_agent
from subagents import run_subagent

from . import journal as _journal
from . import schema as _schema
from .sandbox import WorkflowScriptError

MAX_ITEMS = 256          # per parallel()/pipeline() call
LABEL_CHARS = 48


class WorkflowAborted(Exception):
    """Raised inside a workflow once abort() has been requested."""


def default_concurrency():
    try:
        cpus = os.cpu_count() or 4
    except NotImplementedError:
        cpus = 4
    return max(1, min(16, cpus - 2))


def _label_from(prompt):
    text = " ".join((prompt or "").split())
    if len(text) <= LABEL_CHARS:
        return text
    cut = text[:LABEL_CHARS]
    space = cut.rfind(" ")
    return (cut[:space] if space > 12 else cut).rstrip()


class WorkflowRuntime:
    def __init__(self, journal, on_event=None, run_dir=None, dry_run=False,
                 concurrency=None, run_id="", emit_prefix=""):
        self.journal = journal
        self.on_event = on_event
        self.run_dir = run_dir
        self.dry_run = bool(dry_run)
        self.run_id = run_id
        self.emit_prefix = emit_prefix        # set for a nested workflow
        self._sem = threading.Semaphore(concurrency or default_concurrency())
        self._abort = threading.Event()
        self._phase = None
        self._main_thread = threading.get_ident()
        self._count_lock = threading.Lock()
        self.agent_count = 0
        # Every completed agent() result, in completion order. An aborted run
        # returns these as its partial result (the script's own return value is
        # gone once the abort unwinds it). Guarded by _count_lock — branch
        # threads append concurrently.
        self._partial = []
        self.depth = 0          # bumped for a child runtime
        self._source_loader = None   # set by workflows.run
        self._key_prefix = ""   # set on a child so its journal keys can't collide with the parent's

    # --- lifecycle --------------------------------------------------------
    @property
    def aborted(self):
        return self._abort.is_set()

    def abort(self):
        self._abort.set()

    def partial_results(self):
        """Everything that completed before the abort, oldest first."""
        with self._count_lock:
            return list(self._partial)

    def _note_partial(self, phase, label, agent_type, value, cached):
        with self._count_lock:
            self._partial.append({"phase": phase, "label": label,
                                  "agent_type": agent_type, "cached": cached,
                                  "result": value})

    def _check_abort(self):
        if self._abort.is_set():
            raise WorkflowAborted("workflow aborted")

    def _emit(self, ev):
        if not self.on_event:
            return
        ev = dict(ev)
        ev["run_id"] = self.run_id
        if self.emit_prefix:
            ev["group"] = self.emit_prefix
        try:
            self.on_event(ev)
        except Exception:
            pass      # telemetry must never take down a run

    # --- primitives -------------------------------------------------------
    def phase(self, title):
        """Start a progress group.

        Only legal on the script's main thread: it mutates runtime-global state,
        so two parallel branches calling it would scramble each other's grouping.
        Inside a branch, pass phase= on the agent() call instead."""
        if threading.get_ident() != self._main_thread:
            raise WorkflowScriptError(
                "phase() may only be called from the workflow's main body — "
                "two parallel branches calling it would race and scramble the "
                "progress tree. Inside a parallel()/pipeline() stage, pass "
                "phase=\"<title>\" on the agent() call instead."
            )
        self._phase = str(title)
        self._emit({"type": "wf_phase", "title": self._phase})

    def log(self, message):
        self._emit({"type": "wf_log", "message": str(message)})

    def agent(self, prompt, agent_type=None, label=None, phase=None, schema=None,
              model=None, tier=None, scope=None, context=""):
        self._check_abort()
        agent_type = agent_type or "researcher"
        label = label or _label_from(prompt)
        phase = phase or self._phase

        agent_def = get_agent(agent_type)
        if agent_def is None:
            raise WorkflowScriptError(
                f"unknown agent_type '{agent_type}'. Name one of the personas "
                f"listed in the run_workflow tool description."
            )
        # Scope is MANDATORY for a writer inside a workflow: ScopedWorkspaceLock
        # serializes overlapping owners, but an UNSCOPED writer takes the whole
        # workspace and would silently serialize an entire fan-out.
        if getattr(agent_def, "is_write", False) and not scope:
            raise WorkflowScriptError(
                f"write agent '{agent_type}' must declare scope=[...] inside a "
                f"workflow — the paths it owns. Unscoped writers take the whole "
                f"workspace and would serialize the fan-out."
            )

        # Only non-default options go into the cache key. A call with no
        # schema/model/tier/scope/context must hash identically regardless of
        # how those defaults happen to be spelled internally — call_key({}) is
        # what a replayed journal entry for a plain call was written against.
        opts = {}
        if schema:
            opts["schema"] = schema
        if model:
            opts["model"] = model
        if tier:
            opts["tier"] = tier
        if scope:
            opts["scope"] = list(scope)
        if context:
            opts["context"] = context
        key = _journal.call_key(agent_type, prompt, opts)
        if self._key_prefix:
            # Namespace a child's journal keys so an identical prompt in parent
            # and child cannot collide on replay.
            key = _journal.call_key(self._key_prefix, key, {})

        is_write = bool(getattr(agent_def, "is_write", False))

        hit, cached = self.journal.lookup(key)
        if hit:
            # The occurrence has to be taken on the WRITE side even for a replay:
            # it is both the sub_id disambiguator and the slot this row occupies
            # in THIS run's journal.
            occ = self.journal.next_occurrence(key)
            sub_id = f"{key}:{occ}"
            with self._count_lock:
                self.agent_count += 1
            self._emit({"type": "wf_agent_started", "phase": phase, "label": label,
                        "agent_type": agent_type, "model": model, "sub_id": sub_id})
            # A resume gets a NEW run dir with a FRESH journal. Recording the
            # replayed result here is what carries the full history forward —
            # without it, resume B's journal holds only the delta B executed and
            # resume C re-runs (and re-pays for) everything A did.
            self.journal.record(key, occ, {
                "ok": True, "result": cached, "phase": phase, "label": label,
                "agent_type": agent_type, "tokens": 0, "elapsed_s": 0.0,
                "model": model, "is_write": is_write, "cached": True,
            })
            self._note_partial(phase, label, agent_type, cached, True)
            self._emit({"type": "wf_agent_done", "sub_id": sub_id, "ok": True,
                        "cached": True, "tokens": 0, "elapsed_s": 0.0})
            return cached

        if self.dry_run:
            return _schema.stub(schema) if schema else f"[dry-run:{label}]"

        occ = self.journal.next_occurrence(key)
        # The journal key is content-addressed, so two concurrent branches with an
        # identical prompt share it. The occurrence is what makes the UI id unique
        # — without it the frontend overwrites one row with the other and
        # double-counts running/done.
        sub_id = f"{key}:{occ}"
        started = time.monotonic()
        with self._count_lock:
            self.agent_count += 1
        self._emit({"type": "wf_agent_started", "phase": phase, "label": label,
                    "agent_type": agent_type, "model": model, "sub_id": sub_id})

        with self._sem:
            self._check_abort()
            kwargs = {"context": context or "", "run_dir": self.run_dir,
                      "schema": schema}
            if model:
                kwargs["models"] = [model]
            if tier:
                kwargs["tier"] = tier
            if scope:
                kwargs["scope"] = list(scope)
            res = run_subagent(agent_def, prompt, **kwargs)

        ok = bool(res.get("ok"))
        value = res.get("raw_report") if schema else res.get("report")
        if not ok:
            value = None
        elapsed = round(time.monotonic() - started, 2)

        self.journal.record(key, occ, {
            "ok": ok, "result": value, "phase": phase, "label": label,
            "agent_type": agent_type, "tokens": res.get("tokens", 0),
            "elapsed_s": elapsed, "model": res.get("model"),
            "is_write": is_write, "cached": False,
        })
        if ok:
            self._note_partial(phase, label, agent_type, value, False)
        self._emit({"type": "wf_agent_done", "sub_id": sub_id, "ok": ok,
                    "cached": False, "tokens": res.get("tokens", 0),
                    "elapsed_s": elapsed})
        return value

    def _spawn(self, fns):
        """Run each zero-arg fn on its own thread; return results in input order.

        A raising fn resolves to None rather than propagating: one bad branch
        must not take down the wave. Threads are deliberately unbounded here —
        the semaphore inside agent() is what caps real work. See the module
        docstring for why a pool would deadlock."""
        if len(fns) > MAX_ITEMS:
            raise WorkflowScriptError(
                f"too many items: {len(fns)} exceeds the per-call cap of "
                f"{MAX_ITEMS}. Batch the work or narrow the input; the cap is an "
                f"explicit error rather than a silent truncation."
            )
        results = [None] * len(fns)
        threads = []

        def runner(i, fn):
            try:
                results[i] = fn()
            except WorkflowAborted:
                results[i] = None
            except Exception as e:      # noqa: BLE001 — isolated per branch
                results[i] = None
                self.log(f"branch {i} failed: {type(e).__name__}: {e}")

        for i, fn in enumerate(fns):
            t = threading.Thread(target=runner, args=(i, fn), daemon=True)
            threads.append(t)
            t.start()
        for t in threads:
            t.join()
        return results

    def parallel(self, thunks):
        """Run every thunk concurrently and WAIT for all of them — a barrier.

        Use only when a later stage genuinely needs all results together (dedup
        across the full set, an early exit on a zero count). Otherwise prefer
        pipeline(), which has no barrier."""
        self._check_abort()
        return self._spawn(list(thunks))

    def pipeline(self, items, *stages):
        """Run each item through every stage independently — NO barrier between
        stages. Item A can be in stage 3 while item B is still in stage 1, so
        wall-clock is the slowest single chain rather than the sum of the
        slowest-per-stage.

        Every stage is called as stage(prev_result, original_item, index); the
        first stage receives the item itself as prev_result. A stage that raises
        drops that item to None and skips its remaining stages."""
        self._check_abort()
        items = list(items)

        def chain(item, index):
            def run():
                value = item
                for stage in stages:
                    self._check_abort()
                    value = stage(value, item, index)
                return value
            return run

        return self._spawn([chain(item, i) for i, item in enumerate(items)])

    def workflow(self, name_or_path, args=None):
        """Run another workflow inline, sharing this run's semaphore, abort flag,
        journal and run directory.

        ONE level only. Unbounded nesting would let a single script open an
        arbitrary number of concurrent runs, and a depth counter to tune is worse
        than a flat rule."""
        self._check_abort()
        if self.depth >= 1:
            raise WorkflowScriptError(
                "workflow() cannot be called from inside a nested workflow — "
                "nesting is one level deep. Inline the work with agent()/"
                "pipeline() instead."
            )
        if self._source_loader is None:
            raise WorkflowScriptError("nested workflows are unavailable in this context.")

        from . import sandbox as _sb
        src = self._source_loader(name_or_path)
        meta = _sb.extract_meta(src)
        code = _sb.compile_workflow(src, filename=f"<workflow:{meta['name']}>")

        child = WorkflowRuntime(
            self.journal, on_event=self.on_event, run_dir=self.run_dir,
            dry_run=self.dry_run, run_id=self.run_id,
            emit_prefix=meta.get("name", ""))
        # Share the parent's real concurrency budget and abort signal rather than
        # opening a second one — a child must not double the fleet.
        child._sem = self._sem
        child._abort = self._abort
        child._count_lock = self._count_lock
        # One partial list under the shared lock, so an abort inside a nested
        # workflow still reports through the parent's result.
        child._partial = self._partial
        child.depth = self.depth + 1
        child._source_loader = self._source_loader
        # Namespace the child's journal keys so an identical prompt in parent and
        # child cannot collide on replay.
        child._key_prefix = meta.get("name", "")

        ns = _sb.make_namespace(child.primitives(), args)
        exec(code, ns)
        try:
            return ns["__workflow__"]()
        finally:
            with self._count_lock:
                self.agent_count += child.agent_count

    def primitives(self):
        """The names injected into a script's namespace."""
        return {"agent": self.agent, "phase": self.phase, "log": self.log,
                "parallel": self.parallel, "pipeline": self.pipeline,
                "workflow": self.workflow}
