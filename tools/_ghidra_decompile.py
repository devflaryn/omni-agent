# -*- coding: utf-8 -*-
# Ghidra headless post-script (Jython) — decompile function(s) to C pseudocode.
#
# NOTE: this runs under Ghidra's bundled Jython (Python 2 semantics), which
# raises SyntaxError on any non-ASCII byte (the em-dashes below) UNLESS this
# PEP-263 coding line is present on line 1/2. Without it the whole script fails
# to parse, no markers are emitted, and ghidra_decompile always reports "no
# decompiler output" even when Ghidra ran fine. Keep this line first.
#
# Run by tools/binary_analysis.py::ghidra_decompile via analyzeHeadless with
#   -postScript _ghidra_decompile.py <target_substring> <max_functions>
# Everything between the GHIDRA_DECOMPILE_BEGIN/END markers is the payload the
# Python tool extracts; Ghidra's own verbose logging surrounds it and is
# stripped out by the caller.
#
# Args:
#   target_substring : case-insensitive substring of the function name to
#                      decompile. Empty -> just list function names so the
#                      agent can pick one (avoids dumping a whole binary).
#   max_functions    : cap on how many matching functions to decompile.
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor


def _run():
    args = getScriptArgs()  # noqa: F821 (Ghidra-injected global)
    target = args[0].strip().lower() if len(args) >= 1 and args[0] else ""
    try:
        max_funcs = int(args[1]) if len(args) >= 2 and args[1] else 5
    except Exception:
        max_funcs = 5

    program = getCurrentProgram()  # noqa: F821
    decomp = DecompInterface()
    decomp.openProgram(program)
    monitor = ConsoleTaskMonitor()
    fm = program.getFunctionManager()

    names = []
    matched = []
    it = fm.getFunctions(True)
    while it.hasNext():
        f = it.next()
        nm = f.getName()
        names.append(nm)
        if target and target in nm.lower():
            matched.append(f)

    print("GHIDRA_DECOMPILE_BEGIN")
    if not target:
        print("No function_name given. %d functions in this binary. First 200 names:" % len(names))
        for nm in names[:200]:
            print("  " + nm)
        print("Call ghidra_decompile again with function_name (substring match) to get its C pseudocode.")
    elif not matched:
        print("No function name contains '%s'. %d functions total." % (target, len(names)))
        print("Try rabin2_info '-s' to list symbols, or call ghidra_decompile with an empty function_name to list all names.")
    else:
        count = 0
        for f in matched:
            if count >= max_funcs:
                print("... %d more match(es) not shown; refine function_name." % (len(matched) - count))
                break
            print("// ==== %s @ %s ====" % (f.getName(), str(f.getEntryPoint())))
            res = decomp.decompileFunction(f, 60, monitor)
            if res is not None and res.getDecompiledFunction() is not None:
                print(res.getDecompiledFunction().getC())
            else:
                print("// (decompilation failed for this function)")
            count += 1
    print("GHIDRA_DECOMPILE_END")


_run()
