"""Higher-level native binary editing tools.

These build on the low-level patch_bytes_at_offset tool in hex_patching.py (and
binary_patch below), but operate at a higher level: patch strings by content,
NOP functions by name, force functions to return specific values — without
needing to manually look up addresses first.

Common use cases:
  - Change a hardcoded URL or error string in a .so (patch_binary_string)
  - Disable a license/integrity check function (nop_function or patch_function_return)
  - Force a detection function to always return false (patch_function_return)
"""
import base64
import shlex

from tool_registry import registry
from tools.common import normalize_path, detect_elf_arch
from docker_sandbox import run_cmd


def _clean_hex(hex_str):
    """Normalize a hex byte string ('1f 20', '\\x1f\\x20', '1F2003D5') to lowercase
    contiguous hex and its byte count. Raises ValueError on odd length / bad hex."""
    cleaned = (hex_str or "").replace("\\x", "").replace(" ", "").lower()
    if len(cleaned) % 2 != 0:
        raise ValueError("hex must have an even number of characters")
    try:
        bytes.fromhex(cleaned)
    except ValueError:
        raise ValueError("not a valid hex byte string")
    return cleaned, len(cleaned) // 2


# Architecture-specific patch bytes
_RET_patches = {
    # ARM64 (aarch64)
    "aarch64": {
        "true":  "52800020d65f03c0",   # MOV W0, #1; RET
        "false": "2a1f03e0d65f03c0",   # MOV W0, #0; RET
        "zero":  "2a1f03e0d65f03c0",   # MOV W0, #0; RET  (same as false for int)
        "null":  "2a1f03e0d65f03c0",   # MOV W0, #0; RET  (same as false for object)
        "nop":   "d503201f",           # NOP (one instruction)
    },
    # ARM (32-bit, thumb)
    "arm": {
        "true":  "200120704718",       # MOV R0, #1; BX LR  (thumb)
        "false": "20004718",           # MOV R0, #0; BX LR  (thumb)
        "zero":  "20004718",
        "null":  "20004718",
        "nop":   "46c0",               # NOP (thumb)
    },
    # x86-64
    "x86_64": {
        "true":  "b801000000c3",       # MOV EAX, 1; RET
        "false": "31c0c3",             # XOR EAX, EAX; RET
        "zero":  "31c0c3",
        "null":  "31c0c3",
        "nop":   "90",                 # NOP
    },
    # x86 (32-bit)
    "x86": {
        "true":  "b801000000c3",       # MOV EAX, 1; RET
        "false": "31c0c3",             # XOR EAX, EAX; RET
        "zero":  "31c0c3",
        "null":  "31c0c3",
        "nop":   "90",
    },
}


def _find_symbol_offset(so_path, symbol_name):
    """Find the FILE OFFSET (not virtual address) of a symbol using rabin2 and readelf."""
    # Get the symbol's virtual address via rabin2
    res = run_cmd(f"rabin2 -s /workspace/{so_path} | grep -w '{symbol_name}' | head -1", timeout=30)
    stdout = res.get("stdout", "").strip()
    if not stdout:
        return None, f"Symbol '{symbol_name}' not found in {so_path}. Use rabin2_info with '-s' to list symbols first."

    # rabin2 -s output format: idx addr type name
    # Try to extract the address (second column, usually hex)
    parts = stdout.split()
    if len(parts) < 2:
        return None, f"Could not parse rabin2 output: {stdout}"

    vaddr = parts[1]
    # rabin2 may give it as a hex string like 0x1234
    if not vaddr.startswith("0x"):
        vaddr = "0x" + vaddr

    # Convert virtual address to file offset using readelf -l (program headers)
    # We need the LOAD segment that contains this vaddr
    res2 = run_cmd(f"readelf -l /workspace/{so_path}", timeout=10)
    segments = res2.get("stdout", "")
    for line in segments.splitlines():
        if "LOAD" not in line:
            continue
        cols = line.split()
        # Format: Type Offset VirtAddr PhysAddr FileSiz MemSiz Flg Align
        # But readelf output is column-aligned, so we parse by position
        try:
            # Find the offset and vaddr values in the LOAD line
            # readelf -l columns: Type Off VirtAddr PhysAddr FileSiz MemSiz Flags Align
            offset_val = None
            vaddr_val = None
            filesz_val = None
            for i, col in enumerate(cols):
                if col == "LOAD":
                    # Next columns are: Off VirtAddr PhysAddr FileSiz MemSiz Flags Align
                    if i + 1 < len(cols):
                        offset_val = cols[i + 1]
                    if i + 2 < len(cols):
                        vaddr_val = cols[i + 2]
                    if i + 4 < len(cols):
                        filesz_val = cols[i + 4]
                    break
            if offset_val is None or vaddr_val is None:
                continue
            seg_vaddr = int(vaddr_val, 16)
            seg_offset = int(offset_val, 16)
            seg_filesz = int(filesz_val, 16) if filesz_val else 0
            target_vaddr = int(vaddr, 16)
            if seg_vaddr <= target_vaddr < seg_vaddr + seg_filesz:
                file_offset = seg_offset + (target_vaddr - seg_vaddr)
                return hex(file_offset), None
        except (ValueError, IndexError):
            continue

    return None, f"Found symbol at vaddr {vaddr} but could not map to file offset. Use readelf_info with '-l' to check program headers."


@registry.register(
    name="patch_binary_string",
    description=(
        "Finds and replaces a string literal inside a native .so binary. "
        "This is useful for changing hardcoded URLs, error messages, API endpoints, "
        "feature flags, or any readable text embedded in the binary. "
        "The replacement string MUST be the same length or SHORTER than the original "
        "(shorter replacements are null-padded automatically). If the new string is longer, "
        "the tool returns an error — you cannot grow a string inside a binary without "
        "breaking offsets. For longer replacements, use patch_bytes_at_offset at the string's offset."
    ),
    params_schema={
        "so_path": "string (path to the .so file, relative to /workspace)",
        "old_string": "string (the exact string to find in the binary)",
        "new_string": "string (the replacement string — must be same length or shorter than old_string)"
    },
    output="On success: 'Replaced <old> with <new> at offset 0xNNNN in <file>. <N> byte(s) patched.' If the string is not found, or the new string is longer than the old, an error is returned.",
    when_to_use="Use this to change hardcoded strings in a .so: URLs, server addresses, error messages, feature flags, log tags. If you need a LONGER string, you must find a code cave or use patch_bytes_at_offset manually."
)
def patch_binary_string(so_path, old_string, new_string):
    so_path = normalize_path(so_path)
    if len(new_string) > len(old_string):
        return {"error": f"new_string ({len(new_string)} chars) is longer than old_string ({len(old_string)} chars). Replacement would break binary offsets. Use a string of equal or shorter length."}
    # Pad the new string with null bytes to match the old length
    padded = new_string + "\x00" * (len(old_string) - len(new_string))
    # Use a Python script to find and replace the string in the binary
    b64_old = base64.b64encode(old_string.encode("utf-8")).decode("ascii")
    b64_new = base64.b64encode(padded.encode("latin-1")).decode("ascii")
    script = (
        "import sys, base64\n"
        f"filepath = '/workspace/{so_path}'\n"
        # argv[0] is '-' (the stdin-script placeholder); the real args start at [1].
        "old = base64.b64decode(sys.argv[1])\n"
        "new = base64.b64decode(sys.argv[2])\n"
        "with open(filepath, 'rb') as f:\n"
        "    data = f.read()\n"
        "idx = data.find(old)\n"
        "if idx == -1:\n"
        "    print('ERROR: String not found in binary.')\n"
        "    sys.exit(1)\n"
        "count = data.count(old)\n"
        "data = data.replace(old, new)\n"
        "with open(filepath, 'wb') as f:\n"
        "    f.write(data)\n"
        f"print('Replaced ' + str(count) + ' occurrence(s) at offset 0x' + format(idx, 'x') + ' in {so_path}. ' + str(len(new)) + ' byte(s) patched per occurrence.')\n"
    )
    b64_script = base64.b64encode(script.encode("utf-8")).decode("ascii")
    # base64 args are passed positionally after '-'; the script reads them from argv[1:].
    cmd = f"echo '{b64_script}' | base64 -d | python3 - {b64_old} {b64_new}"
    return run_cmd(cmd, timeout=30)


@registry.register(
    name="binary_patch",
    summary="find a byte SEQUENCE and overwrite it (search-and-replace by content; disambiguates multiple matches)",
    description=(
        "Locates a specific BYTE SEQUENCE inside a binary and overwrites it with new bytes — the precise, "
        "disassembly-free way to flip a compiled control-flow instruction (e.g. turn a conditional branch into "
        "an unconditional one, or a check into a NOP) when you already know the exact bytes from a disassembler. "
        "Give find_hex (the bytes to locate) and replace_hex (the bytes to write). By default the replacement MUST "
        "be the SAME length as find_hex — growing/shrinking a .so shifts every later offset and breaks mmap/loading, "
        "so equal-length in-place patches are the safe default. "
        "Disambiguation: if find_hex occurs more than once, pass offset= to anchor the exact location (the tool "
        "verifies find_hex actually sits there before writing) or occurrence= to pick the Nth match. "
        "The tool reports the offset patched and reads the bytes back so you can confirm the write."
    ),
    params_schema={
        "filepath": "string (path to the binary, relative to /workspace)",
        "find_hex": "string (hex byte sequence to locate, e.g. '1f2003d5' or '1f 20 03 d5'; whitespace/\\x ignored)",
        "replace_hex": "string (hex bytes to write; same length as find_hex unless allow_length_change=true)",
        "offset": "string (optional, anchor the patch at this file offset — '0x1a2b' hex or a decimal number; find_hex is verified to sit there before writing)",
        "occurrence": "integer (optional, 1-based; when find_hex matches multiple places and no offset is given, patch the Nth match. Default 0 = require a unique match)",
        "allow_length_change": "boolean (optional, default false; only set true if you understand it can break the binary's layout)"
    },
    output="On success: 'Patched N byte(s) at offset 0xNNNN in <file>.' with the original bytes, the new bytes, and a verification read-back. On failure: 'not found', an ambiguity report listing every matching offset (so you can pass offset=/occurrence=), a length-mismatch error, or an offset-verification mismatch showing the actual bytes there.",
    when_to_use="Use this when you have the EXACT bytes to change (from disassemble_range/radare2_cmd/ghidra_decompile) and want a surgical in-place patch by content rather than by symbol — e.g. flipping a branch condition. If you only know a symbol name, patch_function_return/nop_function are higher-level; if you already know the file offset and just want to write bytes there, patch_bytes_at_offset is the minimal primitive."
)
def binary_patch(filepath, find_hex, replace_hex, offset=None, occurrence=0, allow_length_change=False):
    filepath = normalize_path(filepath)
    try:
        find_clean, find_count = _clean_hex(find_hex or "")
    except ValueError as e:
        return {"error": f"find_hex invalid: {e}"}
    try:
        repl_clean, repl_count = _clean_hex(replace_hex or "")
    except ValueError as e:
        return {"error": f"replace_hex invalid: {e}"}
    if find_count == 0:
        return {"error": "find_hex must be a non-empty byte sequence to locate."}
    if repl_count == 0:
        return {"error": "replace_hex must be a non-empty byte sequence."}

    allow_len = allow_length_change in (True, "true", "True", 1, "1")
    if not allow_len and repl_count != find_count:
        return {"error": (
            f"replace_hex is {repl_count} byte(s) but find_hex is {find_count} byte(s). "
            "Equal-length in-place patches are required by default — a different size shifts every later "
            "offset and breaks the binary. Match the length, or pass allow_length_change=true only if you "
            "understand the consequences."
        )}

    try:
        occurrence = int(occurrence)
    except (TypeError, ValueError):
        occurrence = 0

    # Normalize offset: '' -> none; '0x..' -> hex; else decimal.
    off_arg = ""
    if offset not in (None, "", False):
        off_arg = str(offset).strip()

    # Hex strings and the small integer/offset args are all shell-safe, so pass
    # them straight through to a base64-shipped python patcher (same trick the
    # other binary tools use to dodge shell-escaping). find_clean/repl_clean were
    # normalized above.
    script = (
        "import sys\n"
        f"fp = '/workspace/{filepath}'\n"
        "find = bytes.fromhex(sys.argv[1])\n"
        "repl = bytes.fromhex(sys.argv[2])\n"
        "off_arg = sys.argv[3]\n"
        "occ = int(sys.argv[4])\n"
        "with open(fp, 'rb') as f:\n"
        "    data = bytearray(f.read())\n"
        "def find_all(buf, sub):\n"
        "    idxs, start = [], 0\n"
        "    while True:\n"
        "        i = buf.find(sub, start)\n"
        "        if i == -1: break\n"
        "        idxs.append(i); start = i + 1\n"
        "    return idxs\n"
        "hits = find_all(data, find)\n"
        "if off_arg:\n"
        "    target = int(off_arg, 16) if off_arg.lower().startswith('0x') else int(off_arg)\n"
        "    actual = bytes(data[target:target+len(find)])\n"
        "    if actual != find:\n"
        "        print('ERROR: bytes at offset ' + hex(target) + ' are ' + actual.hex() + ', not ' + find.hex() + '. Not patching.')\n"
        "        sys.exit(1)\n"
        "elif not hits:\n"
        "    print('ERROR: byte sequence ' + find.hex() + ' not found in file.')\n"
        "    sys.exit(1)\n"
        "elif len(hits) == 1:\n"
        "    target = hits[0]\n"
        "elif occ >= 1 and occ <= len(hits):\n"
        "    target = hits[occ-1]\n"
        "else:\n"
        "    offs = ', '.join(hex(h) for h in hits[:50])\n"
        "    print('ERROR: byte sequence found at ' + str(len(hits)) + ' offsets: ' + offs)\n"
        "    print('Pass offset=<one of these> or occurrence=<1..' + str(len(hits)) + '> to choose which to patch.')\n"
        "    sys.exit(1)\n"
        "orig = bytes(data[target:target+len(repl)])\n"
        "data[target:target+len(find)] = repl\n"
        "with open(fp, 'wb') as f:\n"
        "    f.write(data)\n"
        "with open(fp, 'rb') as f:\n"
        "    f.seek(target); verify = f.read(len(repl))\n"
        "print('Patched ' + str(len(repl)) + ' byte(s) at offset ' + hex(target) + ' in ' + fp.split('/workspace/')[-1] + '.')\n"
        "print('Original bytes: ' + orig.hex())\n"
        "print('New bytes:      ' + repl.hex())\n"
        "print('Verification (read back): ' + verify.hex() + ('  OK' if verify == repl else '  MISMATCH!'))\n"
    )
    b64_script = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = f"echo '{b64_script}' | base64 -d | python3 - {find_clean} {repl_clean} '{off_arg}' {occurrence}"
    return run_cmd(cmd, timeout=60)


@registry.register(
    name="nop_function",
    description=(
        "Finds a function by name in a .so and NOPs out its first N instructions, "
        "effectively disabling it. The function will still be called but do nothing "
        "and return whatever was in the return register (usually 0/null). "
        "Automatically detects the architecture (ARM64, ARM, x86, x86-64) and uses "
        "the correct NOP instruction. You don't need to look up the address yourself."
    ),
    params_schema={
        "so_path": "string (path to the .so file, relative to /workspace)",
        "function_name": "string (exact symbol name, e.g. 'Java_com_example_NativeLib_checkLicense')",
        "num_instructions": "integer (optional, number of instructions to NOP, default 4)"
    },
    output="On success: 'NOPed N instructions at offset 0xNNNN (arch: aarch64) in <file>.' If the symbol or architecture is not found, an error explains what went wrong.",
    when_to_use="Use this to disable a function whose existence causes problems but whose return value doesn't matter (e.g. a logging function, a telemetry call, an anti-debug check that just sets a flag). If you need the function to return a specific value (true/false), use patch_function_return instead."
)
def nop_function(so_path, function_name, num_instructions=4):
    so_path = normalize_path(so_path)
    try:
        num_instructions = int(num_instructions)
    except (ValueError, TypeError):
        num_instructions = 4

    arch = detect_elf_arch(so_path)
    if not arch:
        return {"error": f"Could not detect architecture of {so_path}. Use readelf_info with '-h' to check the machine type."}

    patches = _RET_patches.get(arch)
    if not patches:
        return {"error": f"Unsupported architecture: {arch}"}

    nop_hex = patches.get("nop", "90")
    nop_bytes = int(len(nop_hex) / 2)  # bytes per instruction

    # Find the function's file offset
    offset, err = _find_symbol_offset(so_path, function_name)
    if err:
        return {"error": err}

    # Build N NOP instructions
    full_nop = nop_hex * num_instructions

    # Patch using dd (same as patch_bytes_at_offset but we built the bytes ourselves)
    clean_offset = offset.replace("0x", "")
    byte_count = len(full_nop) // 2
    formatted = "\\x" + "\\x".join(full_nop[i:i+2] for i in range(0, len(full_nop), 2))
    cmd = (
        f'echo -n -e "{formatted}" | '
        f'dd of=/workspace/{so_path} bs=1 seek=$((16#{clean_offset})) conv=notrunc && '
        f'dd if=/workspace/{so_path} bs=1 skip=$((16#{clean_offset})) count={byte_count} 2>/dev/null | xxd -p'
    )
    res = run_cmd(cmd, timeout=30)
    stdout = res.get("stdout", "")
    return {"stdout": f"NOPed {num_instructions} instruction(s) at offset {offset} (arch: {arch}) in {so_path}.\nVerification (should be all {nop_hex} repeated): {stdout}"}


@registry.register(
    name="patch_function_return",
    description=(
        "Finds a function by name in a .so and patches it to immediately return a specific value. "
        "This is the most common native patch: make a check/verification function always return true or false. "
        "Automatically detects architecture (ARM64, ARM, x86, x86-64) and writes the correct "
        "MOV + RET instructions at the function's entry point. You don't need to look up the address."
    ),
    params_schema={
        "so_path": "string (path to the .so file, relative to /workspace)",
        "function_name": "string (exact symbol name, e.g. 'Java_com_example_NativeLib_isValid')",
        "return_value": "string (one of: 'true', 'false', 'zero', 'null' — 'false'/'zero'/'null' all write 0; 'true' writes 1)"
    },
    output="On success: 'Patched <function> to return <value> at offset 0xNNNN (arch: aarch64) in <file>.' with verification hex. If the symbol or architecture is not found, an error is returned.",
    when_to_use="Use this to bypass a native check: make a license verification function return true, make a root/debug detection function return false, make a tamper check always pass. The function will still be called but will immediately return the value you chose without executing any of its original code."
)
def patch_function_return(so_path, function_name, return_value="true"):
    so_path = normalize_path(so_path)
    return_value = return_value.lower().strip()
    if return_value not in ("true", "false", "zero", "null"):
        return {"error": f"return_value must be one of: true, false, zero, null. Got: {return_value}"}

    arch = detect_elf_arch(so_path)
    if not arch:
        return {"error": f"Could not detect architecture of {so_path}. Use readelf_info with '-h' to check the machine type."}

    patches = _RET_patches.get(arch)
    if not patches:
        return {"error": f"Unsupported architecture: {arch}"}

    patch_hex = patches.get(return_value)
    if not patch_hex:
        return {"error": f"No patch bytes for return_value '{return_value}' on arch '{arch}'."}

    # Find the function's file offset
    offset, err = _find_symbol_offset(so_path, function_name)
    if err:
        return {"error": err}

    # Patch
    clean_offset = offset.replace("0x", "")
    byte_count = len(patch_hex) // 2
    formatted = "\\x" + "\\x".join(patch_hex[i:i+2] for i in range(0, len(patch_hex), 2))
    cmd = (
        f'echo -n -e "{formatted}" | '
        f'dd of=/workspace/{so_path} bs=1 seek=$((16#{clean_offset})) conv=notrunc && '
        f'dd if=/workspace/{so_path} bs=1 skip=$((16#{clean_offset})) count={byte_count} 2>/dev/null | xxd -p'
    )
    res = run_cmd(cmd, timeout=30)
    stdout = res.get("stdout", "")
    return {"stdout": f"Patched {function_name} to return {return_value} at offset {offset} (arch: {arch}) in {so_path}.\nVerification (written bytes): {stdout}\nExpected: {patch_hex}"}


# Robust offset-based patcher. Everything is done with plain Python file I/O
# (open r+b, splice, write) rather than shell `dd ... seek=$((16#..))` arithmetic
# — so it doesn't depend on the vaddr->file-offset segment mapping that
# patch_function_return derives (that mapping breaks when a segment's file and
# memory layout aren't 1:1) and it can't misfire on large/odd offsets. If the
# file is an ELF and make_writable is on, it also flips PF_W on the PT_LOAD
# segment that contains the offset (the on-disk equivalent of an mprotect
# PROT_WRITE), reporting the previous flags so the change is reversible. Args
# arrive via argv (shlex-quoted): path, decimal offset, hex bytes, '1'/'0'.
_PATCH_AT_OFFSET_SCRIPT = r'''
import sys, struct

fp = sys.argv[1]
offset = int(sys.argv[2])
new = bytes.fromhex(sys.argv[3])
make_writable = sys.argv[4] == "1"


def make_seg_writable(data, off):
    """Set PF_W on the PT_LOAD segment containing file offset `off`. Returns a
    human-readable note. Parses program headers directly so it works for both
    ELF32/ELF64 and either endianness, regardless of segment alignment."""
    ei_class = data[4]
    endian = "<" if data[5] == 1 else ">"
    try:
        if ei_class == 2:  # ELF64
            e_phoff = struct.unpack_from(endian + "Q", data, 0x20)[0]
            e_phentsize = struct.unpack_from(endian + "H", data, 0x36)[0]
            e_phnum = struct.unpack_from(endian + "H", data, 0x38)[0]
            for i in range(e_phnum):
                ph = e_phoff + i * e_phentsize
                if ph + 56 > len(data):
                    break
                p_type = struct.unpack_from(endian + "I", data, ph)[0]
                p_flags = struct.unpack_from(endian + "I", data, ph + 4)[0]
                p_offset = struct.unpack_from(endian + "Q", data, ph + 8)[0]
                p_filesz = struct.unpack_from(endian + "Q", data, ph + 32)[0]
                if p_type == 1 and p_offset <= off < p_offset + p_filesz:
                    if p_flags & 0x2:
                        return "PT_LOAD segment %d already writable (p_flags=0x%x); no protection change." % (i, p_flags)
                    struct.pack_into(endian + "I", data, ph + 4, p_flags | 0x2)
                    return "Made PT_LOAD segment %d writable: p_flags 0x%x -> 0x%x (PF_W added). To revert, restore p_flags to 0x%x." % (i, p_flags, p_flags | 0x2, p_flags)
            return "Offset 0x%x is not inside any PT_LOAD segment; wrote bytes without changing segment protection." % off
        else:  # ELF32
            e_phoff = struct.unpack_from(endian + "I", data, 0x1C)[0]
            e_phentsize = struct.unpack_from(endian + "H", data, 0x2A)[0]
            e_phnum = struct.unpack_from(endian + "H", data, 0x2C)[0]
            for i in range(e_phnum):
                ph = e_phoff + i * e_phentsize
                if ph + 32 > len(data):
                    break
                p_type = struct.unpack_from(endian + "I", data, ph)[0]
                p_offset = struct.unpack_from(endian + "I", data, ph + 4)[0]
                p_filesz = struct.unpack_from(endian + "I", data, ph + 16)[0]
                p_flags = struct.unpack_from(endian + "I", data, ph + 24)[0]
                if p_type == 1 and p_offset <= off < p_offset + p_filesz:
                    if p_flags & 0x2:
                        return "PT_LOAD segment %d already writable (p_flags=0x%x); no change." % (i, p_flags)
                    struct.pack_into(endian + "I", data, ph + 24, p_flags | 0x2)
                    return "Made PT_LOAD segment %d writable: p_flags 0x%x -> 0x%x (PF_W). Revert p_flags to 0x%x." % (i, p_flags, p_flags | 0x2, p_flags)
            return "Offset 0x%x is not inside any PT_LOAD segment; segment protection unchanged." % off
    except Exception as ex:
        return "Note: could not adjust segment protection (%s); bytes still patched." % ex


try:
    with open(fp, "r+b") as f:
        data = bytearray(f.read())
        size = len(data)
        if offset < 0 or offset + len(new) > size:
            print("ERROR: offset 0x%x + %d byte(s) is out of range for file size %d (0x%x)." % (offset, len(new), size, size))
            sys.exit(1)
        prev = bytes(data[offset:offset + len(new)])
        seg_note = ""
        if bytes(data[:4]) == b"\x7fELF" and make_writable:
            seg_note = make_seg_writable(data, offset)
        data[offset:offset + len(new)] = new
        f.seek(0)
        f.write(data)
        f.truncate()
except OSError as e:
    print("ERROR: cannot patch " + fp + ": " + str(e))
    sys.exit(1)

with open(fp, "rb") as f:
    f.seek(offset)
    verify = f.read(len(new))

name = fp.split("/workspace/")[-1]
print("Patched %d byte(s) at offset 0x%x (%d) in %s" % (len(new), offset, offset, name))
print("Previous bytes (for rollback): " + prev.hex())
print("New bytes:                     " + new.hex())
print("Verify (read back):            " + verify.hex() + ("  OK" if verify == new else "  MISMATCH"))
if seg_note:
    print(seg_note)
'''


@registry.register(
    name="patch_at_offset_with_bytes",
    summary="write hex at a known offset, REVERSIBLE (returns old bytes) + marks segment writable — robust successor for odd ELF layouts",
    description=(
        "Writes a hex byte sequence at a specific FILE OFFSET and returns the PREVIOUS bytes so the change is "
        "reversible. This is the robust successor to patch_bytes_at_offset/patch_function_return for cases where "
        "those fail: it patches with direct file I/O (no vaddr->offset segment math, no shell `dd` arithmetic), "
        "so it works regardless of ELF segment alignment and doesn't misfire when a segment's file and memory "
        "layout aren't 1:1. If the target is an ELF and make_writable is on (default), it also adds PF_W (write "
        "permission) to the PT_LOAD segment containing the offset — the on-disk equivalent of mprotect "
        "PROT_WRITE — and reports the old segment flags so you can revert. The offset may be decimal or "
        "0x-prefixed hex; the tool verifies the offset is in range and reads the bytes back to confirm the write."
    ),
    params_schema={
        "file_path": "string (path to the binary/file, relative to /workspace)",
        "offset": "string or integer (file offset to patch at — decimal '4660' or 0x-hex '0x1234')",
        "new_hex_bytes": "string (even-length hex bytes to write, e.g. 'c0035fd6'; whitespace/\\x ignored)",
        "make_writable": "boolean (optional, default true; if the file is an ELF, add PF_W to the PT_LOAD segment containing the offset. Set false to leave segment permissions untouched)"
    },
    output="A confirmation line (bytes written, offset), the PREVIOUS bytes as hex (save these to roll back), the new bytes, a read-back verification (OK/MISMATCH), and — when make_writable applied to an ELF — a note of the segment whose p_flags changed and how to revert them. Errors if the offset is out of range.",
    when_to_use="Use this when you know the exact FILE offset and bytes to write and want a robust, reversible patch — especially if patch_function_return/patch_bytes_at_offset failed on a binary with unusual segment layout, or you need the patched region marked writable. To locate an offset by content first, use find_byte_sequence_in_so; to patch by symbol name use patch_function_return."
)
def patch_at_offset_with_bytes(file_path, offset, new_hex_bytes, make_writable=True):
    file_path = normalize_path(file_path)

    o = str(offset).strip()
    try:
        off_int = int(o, 16) if o.lower().startswith("0x") else int(o)
    except (ValueError, AttributeError):
        return {"error": "offset must be a decimal number or a 0x-prefixed hex value, e.g. 4660 or '0x1234'."}
    if off_int < 0:
        return {"error": "offset must be non-negative."}

    try:
        clean, count = _clean_hex(new_hex_bytes or "")
    except ValueError as e:
        return {"error": f"new_hex_bytes invalid: {e}"}
    if count == 0:
        return {"error": "new_hex_bytes must be a non-empty hex byte sequence."}

    mkw = make_writable in (True, "true", "True", 1, "1")
    args = [f"/workspace/{file_path}", str(off_int), clean, "1" if mkw else "0"]
    b64 = base64.b64encode(_PATCH_AT_OFFSET_SCRIPT.encode("utf-8")).decode("ascii")
    arg_str = " ".join(shlex.quote(a) for a in args)
    cmd = f"echo '{b64}' | base64 -d | python3 - {arg_str}"
    return run_cmd(cmd, timeout=60)
