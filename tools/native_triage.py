"""Native library triage — the "inspect the .so FIRST" step of source reconstruction.

A stripped, obfuscated 10 MB `.so` is almost never 10 MB of the author's own
code: it is a small custom core statically linked against megabytes of
open-source libraries (a Luau/Lua VM, OpenSSL/BoringSSL, Crypto++, zlib, the C++
STL, protobuf, ...). Feeding all of that to a decompiler + a sourcing model is
pure waste — the library code already has authoritative upstream source.

`identify_native_components` fingerprints those libraries from the binary's
rodata strings and symbol table, and `partition_native_functions` splits the
function inventory into `library` (attributable to a detected component, skip)
and `custom` (unknown — the part actually worth reconstructing). Together they
turn "reconstruct 10 MB" into "point at N upstreams + reconstruct the K custom
functions", which is what makes the whole pipeline tractable and cheap.

These are READ-ONLY inspection tools in the `native` toolset; they shell out to
the same `strings`/`nm`/`rabin2` the rest of binary_analysis.py uses.
"""
import json
import os
import re

from tool_registry import registry
from tools.common import normalize_path, wpath
from host_exec import run_cmd

_HERE = os.path.dirname(os.path.abspath(__file__))
_SIGNATURE_DB = os.path.join(_HERE, "data", "native_signatures.json")


def _load_signatures():
    """Load the fingerprint DB. Returns [] (never raises) so a missing/edited DB
    degrades to "detected nothing", not a crashed tool."""
    try:
        with open(_SIGNATURE_DB, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data.get("components", []) or []
    except (OSError, ValueError):
        return []


def _grab(cmd, timeout=120):
    """Run a shell command and return its stdout as text, or "" on any error.

    Triage tolerates a missing tool (e.g. no rabin2) by falling back to the other
    signals rather than failing the whole inspection."""
    res = run_cmd(cmd, timeout=timeout)
    if not isinstance(res, dict) or res.get("error"):
        return ""
    return res.get("stdout", "") or ""


def _collect_signals(so_path, cap=200000):
    """Cheap corpus for matching: rodata strings + the symbol table.

    Capped so a pathological binary can't blow out memory. Strings are the strong
    signal (version banners, error messages); symbols catch stripped-but-exported
    library entry points and C++ mangled namespaces."""
    p = wpath(so_path)
    strings_out = _grab(f"strings -n 5 {p}")
    # nm for internal symbols (may be empty on a fully stripped .so); rabin2 -s
    # and readelf --dyn-syms catch the dynamic symbol table that survives strip.
    nm_out = _grab(f"nm {p} 2>/dev/null || nm -D {p} 2>/dev/null")
    dyn_out = _grab(f"rabin2 -s {p} 2>/dev/null")
    if not dyn_out:
        dyn_out = _grab(f"readelf -W --dyn-syms {p} 2>/dev/null")
    corpus = (strings_out + "\n" + nm_out + "\n" + dyn_out)
    if len(corpus) > cap:
        corpus = corpus[:cap]
    return {
        "strings": strings_out,
        "symbols": nm_out + "\n" + dyn_out,
        "corpus_lower": corpus.lower(),
        "corpus": corpus,
    }


def _match_component(comp, signals):
    """Score one component against the collected signals.

    A `strings` hit and a `symbols` hit are counted separately so we can require
    corroboration: a single generic symbol like `inflate` shouldn't on its own
    claim zlib, but `inflate` + the "incorrect header check" banner should.
    Returns (detected, evidence_list, hit_count)."""
    corpus_lower = signals["corpus_lower"]
    sym_lower = signals["symbols"].lower()
    str_lower = signals["strings"].lower()

    string_hits = [s for s in comp.get("strings", []) if s.lower() in str_lower]
    symbol_hits = [s for s in comp.get("symbols", []) if s.lower() in sym_lower or s.lower() in corpus_lower]

    evidence = []
    for s in string_hits[:4]:
        evidence.append(f"string:{s!r}")
    for s in symbol_hits[:4]:
        evidence.append(f"symbol:{s!r}")

    hit_count = len(string_hits) + len(symbol_hits)
    # Decisive-single-hit list: a few fingerprints are specific enough on their
    # own (a mangled namespace prefix, a unique banner). Everything else needs
    # two independent hits to avoid false positives on generic names.
    decisive = any(
        h.lower() in corpus_lower
        for h in comp.get("strings", []) + comp.get("symbols", [])
        if len(h) >= 8 and (h.startswith("_ZN") or "::" in h or h.lower().startswith(comp["name"].split()[0].lower()))
    )
    detected = hit_count >= 2 or (decisive and hit_count >= 1)
    return detected, evidence, hit_count


@registry.register(
    name="identify_native_components",
    description=(
        "INSPECT A .so FIRST, before any decompilation or source reconstruction. Fingerprints the "
        "statically-linked OPEN-SOURCE components inside a stripped/obfuscated shared library — a Luau/Lua VM, "
        "OpenSSL/BoringSSL, Crypto++, zlib/zstd, the C++ STL, protobuf, RapidJSON, and more — by matching its "
        "rodata strings and symbol table against a signature database. Each detected component comes back with a "
        "category and an UPSTREAM SOURCE URL, so reconstruction points those parts at real public source instead "
        "of wasting a decompiler and an LLM re-deriving library code. Also reports how much of the symbol surface "
        "is UNATTRIBUTED (the custom code actually worth reconstructing). Read-only; safe on 100MB+ binaries."
    ),
    params_schema={
        "so_path": "string (path to the .so, relative to the project root)",
    },
    output=(
        "JSON: {detected: [{name, category, source_url, evidence, confidence}], "
        "custom_surface: {unattributed_symbol_estimate, note}, summary}. `detected` names the OSS libraries "
        "(reconstruct by pointing at source_url); the custom_surface is what the reconstruct-native-source "
        "workflow should actually decompile and source."
    ),
    when_to_use=(
        "Call this as the very first step when handed a .so to reverse or 'turn back into source'. Knowing which "
        "megabytes are just Luau/OpenSSL/STL is what makes reconstructing a 10MB obfuscated library tractable — "
        "you only source the unattributed custom core. Feeds partition_native_functions and the "
        "reconstruct-native-source workflow."
    ),
)
def identify_native_components(so_path):
    so_path = normalize_path(so_path)
    p = wpath(so_path)
    # Fail loudly only if the file is genuinely unreadable — an empty strings
    # output on a real file is a valid "nothing detected" answer.
    probe = run_cmd(f"test -f {p} && echo OK || echo MISSING", timeout=30)
    if isinstance(probe, dict) and "MISSING" in (probe.get("stdout", "") or ""):
        return {"error": f"No such file: {so_path}. Extract the .so from the APK first "
                         f"(unzip_apk / inspect_apk), then pass its path here."}

    signatures = _load_signatures()
    if not signatures:
        return {"error": "signature database missing or unreadable at tools/data/native_signatures.json"}

    signals = _collect_signals(so_path)
    if not signals["corpus"].strip():
        return {"error": "could not read any strings or symbols from this file — is it a valid ELF .so? "
                         "Try readelf_info / rabin2_info to confirm the format."}

    detected = []
    attributed_prefixes = []
    for comp in signatures:
        ok, evidence, hits = _match_component(comp, signals)
        if ok:
            detected.append({
                "name": comp["name"],
                "category": comp.get("category", ""),
                "source_url": comp.get("source_url", ""),
                "evidence": evidence,
                "confidence": "high" if hits >= 3 else "medium",
                "notes": comp.get("notes", ""),
            })
            attributed_prefixes.extend(comp.get("symbols", []))

    # Rough custom-surface estimate: how many symbol lines are NOT explained by
    # any detected component's symbol prefixes. This is a heuristic signpost, not
    # a precise count — partition_native_functions does the real per-function split.
    sym_lines = [ln.strip() for ln in signals["symbols"].splitlines() if ln.strip()]
    total = len(sym_lines)
    attributed = 0
    low_prefixes = [x.lower() for x in attributed_prefixes]
    for ln in sym_lines:
        low = ln.lower()
        if any(pref in low for pref in low_prefixes):
            attributed += 1
    unattributed = max(0, total - attributed)
    pct = round(100.0 * unattributed / total, 1) if total else 0.0

    cats = ", ".join(sorted({d["name"] for d in detected})) or "none"
    summary = (
        f"Detected {len(detected)} open-source component(s): {cats}. "
        f"~{unattributed} of {total} symbol lines ({pct}%) are unattributed — that custom core is what "
        f"reconstruct-native-source should decompile and source; the detected libraries should be pulled "
        f"from their upstream source_url instead."
    )
    return {
        "detected": detected,
        "custom_surface": {
            "unattributed_symbol_estimate": unattributed,
            "total_symbol_lines": total,
            "unattributed_pct": pct,
            "note": "Heuristic from the symbol table; use partition_native_functions for the exact per-function split.",
        },
        "summary": summary,
    }


def _list_function_names(so_path):
    """Function inventory from the symbol table. Prefers nm (has internal
    functions), falls back to rabin2/readelf on a stripped binary."""
    p = wpath(so_path)
    names = []
    # nm 't'/'T' = text (code) symbols. Keep the name only.
    out = _grab(f"nm {p} 2>/dev/null")
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 3 and parts[1] in ("t", "T", "w", "W"):
            names.append(parts[2])
    if not names:
        out = _grab(f"rabin2 -s {p} 2>/dev/null")
        for ln in out.splitlines():
            m = re.search(r"\bFUNC\b.*\s(\S+)\s*$", ln)
            if m:
                names.append(m.group(1))
    # De-dup, preserve order.
    seen = set()
    uniq = []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


@registry.register(
    name="partition_native_functions",
    description=(
        "Splits a .so's function inventory into LIBRARY functions (attributable to a detected open-source "
        "component — skip, they have upstream source) and CUSTOM functions (unattributed — the code worth "
        "reconstructing). Builds on identify_native_components' fingerprints. Returns the custom function names "
        "in batches sized for a decompile-and-source subagent, so the reconstruct-native-source workflow can "
        "pipeline them without ever holding the whole 10MB binary in one context. Read-only."
    ),
    params_schema={
        "so_path": "string (path to the .so)",
        "batch_size": "integer (optional, custom functions per batch, default 12)",
        "max_functions": "integer (optional, cap on custom functions returned, default 400)",
    },
    output=(
        "JSON: {library_function_count, custom_function_count, batches: [[name,...],...], truncated, "
        "detected_components}. Each batch is a list of custom function names to hand to one source-reconstructor "
        "subagent. `truncated` is true (with a count) when custom functions exceeded max_functions."
    ),
    when_to_use=(
        "Call right after identify_native_components when you intend to reconstruct source. It turns 'thousands of "
        "functions' into a small set of custom-function batches, each cheap enough for one deepseek-class subagent "
        "to decompile and rewrite. The reconstruct-native-source workflow calls this for you."
    ),
)
def partition_native_functions(so_path, batch_size=12, max_functions=400):
    so_path = normalize_path(so_path)
    try:
        batch_size = max(1, int(batch_size))
    except (TypeError, ValueError):
        batch_size = 12
    try:
        max_functions = max(1, int(max_functions))
    except (TypeError, ValueError):
        max_functions = 400

    ident = identify_native_components(so_path)
    if isinstance(ident, dict) and ident.get("error"):
        return ident

    lib_prefixes = []
    # Map detected names back to their symbol patterns from the DB so we
    # partition on the SAME substrings that identified each component.
    by_name = {c["name"]: c for c in _load_signatures()}
    for d in ident.get("detected", []):
        comp = by_name.get(d["name"])
        if comp:
            lib_prefixes.extend(x.lower() for x in comp.get("symbols", []))
    # STL / C++ runtime mangling is library by definition even if that component
    # wasn't explicitly flagged — never ask the model to reconstruct std internals.
    lib_prefixes.extend(["_znst", "_znkst", "__cxa_", "_zn9__gnu_cxx", "std::__1", "_znwm", "_zdlpv"])

    names = _list_function_names(so_path)
    library, custom = [], []
    for n in names:
        low = n.lower()
        if any(pref and pref in low for pref in lib_prefixes):
            library.append(n)
        else:
            custom.append(n)

    truncated = len(custom) > max_functions
    dropped = len(custom) - max_functions if truncated else 0
    custom_kept = custom[:max_functions]
    batches = [custom_kept[i:i + batch_size] for i in range(0, len(custom_kept), batch_size)]

    return {
        "library_function_count": len(library),
        "custom_function_count": len(custom),
        "custom_returned": len(custom_kept),
        "truncated": truncated,
        "dropped_custom_functions": dropped,
        "batches": batches,
        "detected_components": [
            {"name": d["name"], "source_url": d["source_url"], "category": d["category"]}
            for d in ident.get("detected", [])
        ],
        "note": (
            f"{len(custom)} custom function(s) to source across {len(batches)} batch(es); "
            f"{len(library)} function(s) belong to detected libraries and are skipped."
            + (f" TRUNCATED: {dropped} custom function(s) beyond max_functions were dropped — "
               f"raise max_functions to cover them." if truncated else "")
        ),
    }
