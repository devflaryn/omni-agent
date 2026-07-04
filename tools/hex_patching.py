"""Binary patching tools.

Low-level byte-patching of native .so libraries: hex writes at a file offset,
plus a higher-level "replace a function's bytes" helper. These come into play
after the binary_analysis tools have located a target symbol/address.

Reorganized out of the original ``reverse_engineering.py`` so patching
tooling lives in one focused, readable module.
"""

from tool_registry import registry
from tools.common import normalize_path
from docker_sandbox import run_cmd


def _format_hex_bytes(new_hex_bytes):
    """Validate and format a raw hex string (e.g. 'd503201f') into a shell
    escape sequence string (e.g. '\\xd5\\x03\\x20\\x1f').

    Returns (formatted_bytes, byte_count) or raises ValueError on bad input.
    """
    cleaned_bytes = new_hex_bytes.replace("\\x", "").replace(" ", "")
    if len(cleaned_bytes) % 2 != 0:
        raise ValueError("new_hex_bytes must have an even number of characters.")
    formatted_bytes = "\\x" + "\\x".join(cleaned_bytes[i:i+2] for i in range(0, len(cleaned_bytes), 2))
    byte_count = len(cleaned_bytes) // 2
    return formatted_bytes, byte_count


@registry.register(
    name="hex_patch_file",
    description="Patches a binary file by replacing bytes at a specific hex file offset using dd. Use this for small, precise patches in .so libraries after you know the exact offset.",
    params_schema={
        "filepath": "string (path to the binary)",
        "hex_offset": "string (file offset, e.g., '0x10a40' or '00010a40')",
        "new_hex_bytes": "string (even-length hex, e.g., '9090' for x86 NOPs or 'd503201f' for ARM64 NOP)"
    },
    output="The dd command output showing bytes written. On success the file is patched in-place at the given offset. Returns an error if the hex string has an odd length.",
    when_to_use="Use this for small byte-level patches at a known FILE offset (not virtual address). To patch a whole function, use disassemble_patch_function which also verifies the write."
)
def hex_patch_file(filepath, hex_offset, new_hex_bytes):
    filepath = normalize_path(filepath)
    try:
        formatted_bytes, _ = _format_hex_bytes(new_hex_bytes)
    except ValueError as e:
        return {"error": str(e)}

    clean_offset = hex_offset.replace("0x", "")
    cmd = f'echo -n -e "{formatted_bytes}" | dd of=/workspace/{filepath} bs=1 seek=$((16#{clean_offset})) conv=notrunc'
    return run_cmd(cmd)


@registry.register(
    name="disassemble_patch_function",
    description=(
        "Replaces a function in a native .so library with new assembly/machine code. "
        "Workflow: 1) find function address with rabin2_info or nm_symbols, 2) disassemble it with disassemble_range, "
        "3) craft replacement bytes, 4) call this tool with the file offset and new hex bytes. "
        "The tool writes the new bytes at the given offset and verifies the write."
    ),
    params_schema={
        "so_path": "string (path to .so inside /workspace, e.g. 'lib/arm64-v8a/libfoo.so')",
        "file_offset": "string (hex file offset where patch starts, e.g. '0x1234')",
        "new_hex_bytes": "string (even-length hex string of replacement bytes, e.g. 'd503201f' for ARM64 NOP)"
    },
    output="Writes the patch bytes, then reads them back as hex (xxd -p) so you can VERIFY the write succeeded. The echoed hex should match your new_hex_bytes.",
    when_to_use="Use this to replace a function's bytes (e.g. NOP out a check). Workflow: find the function's file offset via rabin2_info/nm_symbols, disassemble with disassemble_range to understand it, then call this with the replacement bytes."
)
def disassemble_patch_function(so_path, file_offset, new_hex_bytes):
    so_path = normalize_path(so_path)
    clean_offset = file_offset.replace("0x", "")

    try:
        formatted_bytes, byte_count = _format_hex_bytes(new_hex_bytes)
    except ValueError as e:
        return {"error": str(e)}

    cmd = (
        f'echo -n -e "{formatted_bytes}" | '
        f'dd of=/workspace/{so_path} bs=1 seek=$((16#{clean_offset})) conv=notrunc && '
        # Read back the patched bytes to verify the write succeeded
        f'dd if=/workspace/{so_path} bs=1 skip=$((16#{clean_offset})) count={byte_count} 2>/dev/null | xxd -p'
    )
    return run_cmd(cmd, timeout=60)
