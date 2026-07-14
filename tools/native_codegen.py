"""Native code generation tools — go beyond canned NOP/return-value patches
by assembling real hand-written assembly, or compiling freestanding C, into
raw machine code and patching it directly into a .so at a chosen file offset.

These exist because patch_bytes_at_offset / nop_function / patch_function_return
only let you write bytes you already know, or force a function to return one
canned constant. When the task needs genuinely NEW
logic (a custom comparison, a small algorithm, a bespoke check) these tools
let you express that logic as source code and get correctly encoded machine
code for the target's actual CPU architecture, instead of hand-encoding
opcodes by hand.

HARD CONSTRAINT: there is no linker step here. The assembled/compiled code
must be fully self-contained:
  - no calls to external functions (including libc — no printf, no malloc)
  - no references to global or static variables
  - no string literals, no PLT/GOT usage
Only registers, immediate values, and the function's own parameters/locals
are safe to use. Both tools refuse to extract code containing unresolved
relocations, since patching those in would silently turn into a jump/load to
address 0.
"""
import base64

from tool_registry import registry
from tools.common import normalize_path, detect_elf_arch, TOOLCHAINS
from docker_sandbox import run_cmd


def _extract_and_check(objdump_bin, objcopy_bin, timeout):
    """Check /tmp/patch.o for unresolved relocations, then extract its .text
    section as a raw hex string. Returns (hex_bytes, error)."""
    reloc_cmd = f"{objdump_bin} -r /tmp/patch.o 2>/dev/null | grep -E '^[0-9a-f]+ '"
    reloc_res = run_cmd(reloc_cmd, timeout=timeout)
    if reloc_res.get("stdout", "").strip():
        return None, (
            "Refusing to extract code: it has unresolved relocations (a call to an "
            "external function, a reference to a global/static variable, or a jump "
            "target outside this snippet). There is no linker step here, so these "
            "would silently become jumps/loads to address 0 if patched in. Rewrite "
            "the code to be fully self-contained: only parameters, locals, and "
            "immediate values.\n\nRelocations found:\n" + reloc_res["stdout"]
        )
    extract_cmd = (
        f"{objcopy_bin} -O binary --only-section=.text /tmp/patch.o /tmp/patch.bin && "
        "xxd -p /tmp/patch.bin | tr -d '\\n'"
    )
    extract_res = run_cmd(extract_cmd, timeout=timeout)
    hex_bytes = extract_res.get("stdout", "").strip()
    if not hex_bytes:
        return None, f"Could not extract .text section bytes. Toolchain output: {extract_res}"
    return hex_bytes, None


def _maybe_patch(so_path, file_offset, hex_bytes, max_bytes):
    byte_count = len(hex_bytes) // 2
    warning = ""
    if max_bytes not in (None, ""):
        try:
            max_bytes_int = int(max_bytes)
            if byte_count > max_bytes_int:
                warning = (
                    f"\nWARNING: assembled/compiled code is {byte_count} byte(s) but "
                    f"max_bytes={max_bytes_int}. Writing this at file_offset would overrun "
                    "into whatever follows it. Shrink the code, or use find_code_cave to "
                    "locate room elsewhere and branch into it instead."
                )
        except (TypeError, ValueError):
            pass

    if not file_offset:
        return {"stdout": f"Dry run — no file_offset given. Assembled {byte_count} byte(s):\n{hex_bytes}{warning}"}

    so_path = normalize_path(so_path)
    clean_offset = str(file_offset).replace("0x", "")
    formatted = "\\x" + "\\x".join(hex_bytes[i:i + 2] for i in range(0, len(hex_bytes), 2))
    cmd = (
        f'echo -n -e "{formatted}" | '
        f'dd of=/workspace/{so_path} bs=1 seek=$((16#{clean_offset})) conv=notrunc && '
        f'dd if=/workspace/{so_path} bs=1 skip=$((16#{clean_offset})) count={byte_count} 2>/dev/null | xxd -p | tr -d "\\n"'
    )
    res = run_cmd(cmd, timeout=60)
    readback = res.get("stdout", "").strip()
    match_note = "MATCH" if readback == hex_bytes else "MISMATCH — the write may have failed, re-check!"
    return {"stdout": (
        f"Wrote {byte_count} byte(s) at offset {file_offset} in {so_path}.\n"
        f"Expected: {hex_bytes}\nRead back: {readback}\n{match_note}{warning}"
    )}


def _resolve_toolchain(so_path, arch):
    if not arch:
        arch = detect_elf_arch(normalize_path(so_path))
    if not arch or arch not in TOOLCHAINS:
        return None, {"error": f"Could not determine a supported architecture (got: {arch}). Pass arch explicitly: 'aarch64', 'arm', 'x86_64', or 'x86'."}
    return TOOLCHAINS[arch], None


@registry.register(
    name="assemble_and_patch",
    description=(
        "Assembles raw assembly source for a specific CPU architecture into machine code, and "
        "(if file_offset is given) patches those exact bytes into a .so at that file offset — "
        "verifying the write by reading the bytes back. Use this when a canned patch "
        "(nop_function/patch_function_return) isn't enough and you need to write custom logic "
        "yourself, in real assembly, correctly encoded for the target's actual architecture "
        "instead of hand-encoding opcodes by hand. "
        "If file_offset is omitted, this only assembles and returns the hex bytes + size (a dry "
        "run) so you can check how much space the code needs before deciding where to patch it. "
        "HARD CONSTRAINT: no linker step exists. The assembly must be fully self-contained — no "
        "calls to external symbols, no references to global data, no undefined labels. This tool "
        "refuses to patch code that has unresolved relocations and explains exactly which symbol "
        "is unresolved instead."
    ),
    params_schema={
        "so_path": "string (path to the .so file, relative to /workspace)",
        "assembly_code": "string (raw assembly, GNU 'as' syntax, for the target arch — e.g. 'mov w0, #1\\nret' for ARM64)",
        "arch": "string (optional: 'aarch64', 'arm', 'x86_64', or 'x86'; auto-detected from so_path via readelf if omitted)",
        "file_offset": "string (optional hex file offset to patch at, e.g. '0x1234'; if omitted, this is a dry run that only returns the assembled bytes)",
        "max_bytes": "integer (optional; if given, warns when the assembled code is larger than the space you have available, e.g. the original function's size)"
    },
    output="On a dry run (no file_offset): the assembled hex bytes and byte count. When file_offset is given: confirmation of the write plus a read-back verification (MATCH/MISMATCH). If the code has unresolved relocations, returns an error explaining exactly which symbols are unresolved instead of writing anything.",
    when_to_use="Use this instead of hand-encoding opcodes whenever the new logic is more than a NOP or a canned return-true/return-false — e.g. a custom comparison, a small loop, or arithmetic that doesn't fit the pre-baked patterns in nop_function/patch_function_return."
)
def assemble_and_patch(so_path, assembly_code, arch=None, file_offset=None, max_bytes=None):
    tc, err = _resolve_toolchain(so_path, arch)
    if err:
        return err

    b64_src = base64.b64encode(assembly_code.encode("utf-8")).decode("ascii")
    run_cmd(f"echo '{b64_src}' | base64 -d > /tmp/patch.s", timeout=10)

    asm_res = run_cmd(f"{tc['as']} -o /tmp/patch.o /tmp/patch.s", timeout=30)
    if asm_res.get("returncode") != 0:
        return {"error": f"Assembly failed:\n{asm_res.get('stderr', '') or asm_res.get('stdout', '')}"}

    hex_bytes, err = _extract_and_check(tc["objdump"], tc["objcopy"], timeout=30)
    if err:
        return {"error": err}

    return _maybe_patch(so_path, file_offset, hex_bytes, max_bytes)


@registry.register(
    name="compile_c_and_patch",
    description=(
        "Compiles a small, self-contained freestanding C function into raw machine code for a "
        "specific CPU architecture, and (if file_offset is given) patches those exact bytes into "
        "a .so at that file offset — verifying the write by reading the bytes back. Use this for "
        "genuinely complex new native logic (custom algorithms, multi-branch checks, arithmetic) "
        "that would be tedious or error-prone to hand-write in assembly. "
        "If file_offset is omitted, this only compiles and returns the hex bytes + size (a dry "
        "run) so you can check how much space the code needs first. "
        "HARD CONSTRAINT: no linker step exists. c_code must define exactly ONE self-contained "
        "function: no calls to any other function (including libc — no printf, no malloc, "
        "nothing), no global or static variables, no string literals. Only parameters, locals, "
        "and computation. This tool refuses to patch code that has unresolved relocations and "
        "explains exactly which symbol is unresolved instead."
    ),
    params_schema={
        "so_path": "string (path to the .so file, relative to /workspace)",
        "c_code": "string (C source defining exactly one self-contained function, e.g. 'int check(int x) { return (x * 7 + 3) % 5 == 0; }')",
        "arch": "string (optional: 'aarch64', 'arm', 'x86_64', or 'x86'; auto-detected from so_path via readelf if omitted)",
        "file_offset": "string (optional hex file offset to patch at, e.g. '0x1234'; if omitted, this is a dry run that only returns the compiled bytes)",
        "max_bytes": "integer (optional; if given, warns when the compiled code is larger than the space you have available, e.g. the original function's size)"
    },
    output="On a dry run (no file_offset): the compiled hex bytes and byte count. When file_offset is given: confirmation of the write plus a read-back verification (MATCH/MISMATCH). If the function calls anything external or touches global state, returns an error explaining exactly which symbols are unresolved instead of writing anything.",
    when_to_use="Use this over assemble_and_patch when the logic is easier to express correctly in C than in hand-written assembly (custom comparisons, small algorithms) — but only when it can be written as one pure, self-contained function with no external calls or globals."
)
def compile_c_and_patch(so_path, c_code, arch=None, file_offset=None, max_bytes=None):
    tc, err = _resolve_toolchain(so_path, arch)
    if err:
        return err

    b64_src = base64.b64encode(c_code.encode("utf-8")).decode("ascii")
    run_cmd(f"echo '{b64_src}' | base64 -d > /tmp/patch.c", timeout=10)

    compile_cmd = (
        f"{tc['gcc']} -c -O2 -ffreestanding -fno-pic -fno-plt -fno-stack-protector "
        "-fomit-frame-pointer -nostdlib -o /tmp/patch.o /tmp/patch.c"
    )
    compile_res = run_cmd(compile_cmd, timeout=30)
    if compile_res.get("returncode") != 0:
        return {"error": f"Compilation failed:\n{compile_res.get('stderr', '') or compile_res.get('stdout', '')}"}

    hex_bytes, err = _extract_and_check(tc["objdump"], tc["objcopy"], timeout=30)
    if err:
        return {"error": err}

    return _maybe_patch(so_path, file_offset, hex_bytes, max_bytes)


@registry.register(
    name="find_code_cave",
    description=(
        "Scans a binary for a run of consecutive repeated filler bytes (default 0x00) at least "
        "min_size bytes long — a 'code cave' with enough room to hold new patched-in code that's "
        "bigger than the function you're replacing. Reports candidate file offsets and the length "
        "of each run found."
    ),
    params_schema={
        "binary_path": "string (path to the file to scan, relative to /workspace)",
        "min_size": "integer (minimum consecutive filler bytes required, e.g. 32)",
        "fill_byte": "string (optional, 2-hex-char byte to look for runs of, default '00')",
        "max_results": "integer (optional, max candidate offsets to return, default 10)"
    },
    output="A list of candidate file offsets with the length of the filler run found there. Says so explicitly if no run of at least min_size was found.",
    when_to_use="Use this when new assembled/compiled code (from assemble_and_patch or compile_c_and_patch) is larger than the function you're replacing, so you need somewhere else in the file to put it — then patch a jump/branch from the original function into the cave instead of squeezing the new logic into the original space. Cross-check candidates with readelf_info ('-S') to confirm the offset falls in a section that's safe to overwrite."
)
def find_code_cave(binary_path, min_size, fill_byte="00", max_results=10):
    binary_path = normalize_path(binary_path)
    try:
        min_size = int(min_size)
        max_results = int(max_results)
    except (TypeError, ValueError):
        return {"error": "min_size and max_results must be integers."}
    fill_byte = fill_byte.replace("0x", "").strip().lower()
    if len(fill_byte) != 2:
        return {"error": "fill_byte must be a single hex byte, e.g. '00' or 'ff'."}

    script = f"""
path = '/workspace/{binary_path}'
fill = bytes.fromhex('{fill_byte}')[0]
min_size = {min_size}
max_results = {max_results}
with open(path, 'rb') as f:
    data = f.read()
results = []
i = 0
n = len(data)
while i < n and len(results) < max_results:
    if data[i] == fill:
        start = i
        while i < n and data[i] == fill:
            i += 1
        run_len = i - start
        if run_len >= min_size:
            results.append((start, run_len))
    else:
        i += 1
if not results:
    print('No run of at least ' + str(min_size) + ' bytes of 0x{fill_byte} found.')
else:
    for start, run_len in results:
        print('offset=0x' + format(start, 'x') + ' length=' + str(run_len) + ' bytes')
"""
    b64_script = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = f"echo '{b64_script}' | base64 -d | python3 -"
    res = run_cmd(cmd, timeout=60)
    if res.get("stdout"):
        res["stdout"] += "\nUse readelf_info with '-S' to map these offsets to section names before using one."
    return res
