"""Binary patching tools.

Low-level byte-patching of native .so libraries: write known hex bytes at a
known file offset, verified by reading them back (patch_bytes_at_offset). This
comes into play after the binary_analysis tools have located a target
symbol/address. For patching by locating a byte SEQUENCE (content) rather than
an offset, see binary_patch in binary_editing.py.

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
    name="patch_bytes_at_offset",
    summary="write hex bytes at a KNOWN file offset + verify (minimal offset-patch primitive)",
    description=(
        "Writes raw hex bytes at a specific FILE OFFSET in a binary (.so or any file) and verifies the write "
        "by reading the bytes back. This is the low-level offset-based patch primitive: you already know the "
        "exact file offset and the exact bytes to write there. "
        "Typical workflow: 1) find a function's address with rabin2_info or nm_symbols, 2) map it to a file "
        "offset (readelf_info '-l'/'-S') and disassemble around it with disassemble_range, 3) craft the "
        "replacement bytes (e.g. a NOP or a full function replacement), 4) call this with that offset and hex. "
        "If instead you know the exact byte SEQUENCE to find-and-replace (rather than an offset), use "
        "binary_patch, which locates the bytes by content and disambiguates multiple matches."
    ),
    params_schema={
        "so_path": "string (path to the binary inside /workspace, e.g. 'lib/arm64-v8a/libfoo.so')",
        "file_offset": "string (hex file offset where the patch starts, e.g. '0x1234')",
        "new_hex_bytes": "string (even-length hex string of replacement bytes, e.g. 'd503201f' for an ARM64 NOP)"
    },
    output="Writes the patch bytes, then reads them back as hex (xxd -p) so you can VERIFY the write succeeded. The echoed hex should match your new_hex_bytes.",
    when_to_use="Use this to write known bytes at a known FILE offset (not a virtual address) and confirm the write — e.g. NOP out a check or drop in a full function replacement. To patch by locating a byte sequence instead of an offset, use binary_patch; for a symbol-name-driven return/NOP, use patch_function_return/nop_function."
)
def patch_bytes_at_offset(so_path, file_offset, new_hex_bytes):
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
