"""Higher-level native binary editing tools.

These build on the low-level hex_patch_file / disassemble_patch_function tools
in hex_patching.py, but operate at a higher level: patch strings by content,
NOP functions by name, force functions to return specific values — without
needing to manually look up addresses first.

Common use cases:
  - Change a hardcoded URL or error string in a .so (patch_binary_string)
  - Disable a license/integrity check function (nop_function or patch_function_return)
  - Force a detection function to always return false (patch_function_return)
"""
import base64

from tool_registry import registry
from tools.common import normalize_path, detect_elf_arch
from docker_sandbox import run_cmd


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
        "breaking offsets. For longer replacements, use hex_patch_file at the string's offset."
    ),
    params_schema={
        "so_path": "string (path to the .so file, relative to /workspace)",
        "old_string": "string (the exact string to find in the binary)",
        "new_string": "string (the replacement string — must be same length or shorter than old_string)"
    },
    output="On success: 'Replaced <old> with <new> at offset 0xNNNN in <file>. <N> byte(s) patched.' If the string is not found, or the new string is longer than the old, an error is returned.",
    when_to_use="Use this to change hardcoded strings in a .so: URLs, server addresses, error messages, feature flags, log tags. If you need a LONGER string, you must find a code cave or use hex_patch_file manually."
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
        "old = base64.b64decode(sys.argv[0])\n"
        "new = base64.b64decode(sys.argv[1])\n"
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
    cmd = f"echo '{b64_script}' | base64 -d | python3 '{b64_old}' '{b64_new}'"
    # Fix: python3 args don't use single quotes for b64, pass directly
    cmd = f"echo '{b64_script}' | base64 -d | python3 - {b64_old} {b64_new}"
    return run_cmd(cmd, timeout=30)


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

    # Patch using dd (same as disassemble_patch_function but we built the bytes ourselves)
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
