"""DEX bytecode editing tools.

These let the agent work directly with .dex files (Dalvik bytecode) — the
compiled Java/Kotlin code inside an APK. While decode_apk/recompile_apk handle
the full APK lifecycle, these tools operate on individual .dex files for
targeted editing without a full decompile/rebuild cycle.

Workflow for editing a .dex:
  1. disassemble_dex  — .dex → smali files
  2. read_file_chunk   — read the smali you want to edit
  3. patch_smali_method or write_file — edit the smali
  4. assemble_dex      — smali files → new .dex
  5. Replace the old .dex in the APK and recompile/sign

Or for a full APK edit (easier, uses apktool):
  decode_apk → edit smali → recompile_apk → sign_apk
"""
import os
import base64

from tool_registry import registry
from tools.common import normalize_path
from docker_sandbox import run_cmd


@registry.register(
    name="disassemble_dex",
    description=(
        "Disassembles a standalone .dex file into individual .smali files using baksmali. "
        "Each class in the .dex becomes its own .smali file in the output directory. "
        "Use this when you need to edit a single .dex without decompiling the whole APK, "
        "or when you extracted a .dex via unzip_apk and want to read/edit its bytecode."
    ),
    params_schema={
        "dex_path": "string (path to the .dex file, relative to /workspace, e.g. 'classes.dex' or 'extracted/classes2.dex')",
        "output_dir": "string (directory to write .smali files to, relative to /workspace)"
    },
    output="baksmali's log showing how many classes were disassembled, plus the output_dir path. Each class becomes a .smali file organized by package structure.",
    when_to_use="Use this to convert a .dex file into editable smali source. After this, use read_file_chunk to read specific smali files, edit them with write_file or patch_smali_method, then call assemble_dex to rebuild the .dex."
)
def disassemble_dex(dex_path, output_dir):
    dex_path = normalize_path(dex_path)
    output_dir = normalize_path(output_dir)
    cmd = f"baksmali disassemble /workspace/{dex_path} -o /workspace/{output_dir}"
    return run_cmd(cmd, timeout=120)


@registry.register(
    name="assemble_dex",
    description=(
        "Assembles .smali files back into a single .dex file using the smali assembler. "
        "Use this AFTER editing smali files (from disassemble_dex or decode_apk) to produce "
        "a new .dex that can be put back into an APK. The input is a directory containing .smali files."
    ),
    params_schema={
        "smali_dir": "string (directory containing .smali files, relative to /workspace)",
        "output_dex": "string (output .dex filename, relative to /workspace, e.g. 'classes_patched.dex')"
    },
    output="smali assembler's log. On success, the output .dex file is created and ready to be placed back into an APK via replace_file_in_apk or recompile_apk.",
    when_to_use="Use this after editing smali files to rebuild the .dex. Then put the new .dex back into the APK (replace_file_in_apk for a single .dex swap, or recompile_apk to rebuild the whole directory) and sign the result."
)
def assemble_dex(smali_dir, output_dex):
    smali_dir = normalize_path(smali_dir)
    output_dex = normalize_path(output_dex)
    cmd = f"smali assemble /workspace/{smali_dir} -o /workspace/{output_dex}"
    return run_cmd(cmd, timeout=120)


@registry.register(
    name="list_dex_classes",
    description=(
        "Lists all class descriptors inside a .dex file WITHOUT disassembling it. "
        "Much faster than disassemble_dex when you just need to know what classes exist. "
        "Use this to find the right class before disassembling or to check which .dex "
        "contains a specific class (APKs can have classes.dex, classes2.dex, etc.)."
    ),
    params_schema={
        "dex_path": "string (path to the .dex file, relative to /workspace)"
    },
    output="A list of class descriptors (e.g. 'Lcom/example/MainActivity;') one per line. Each is a class contained in the .dex.",
    when_to_use="Use this to quickly check what classes are in a .dex file before disassembling it, or to find which .dex (classes.dex vs classes2.dex) contains the class you want to edit."
)
def list_dex_classes(dex_path):
    dex_path = normalize_path(dex_path)
    cmd = f"baksmali list /workspace/{dex_path}"
    return run_cmd(cmd, timeout=60)


@registry.register(
    name="patch_smali_method",
    description=(
        "Finds a method inside a .smali file by name and replaces its ENTIRE body with new smali code you provide. "
        "This is the primary tool for editing DEX logic: you don't need to read the whole file, just tell it which "
        "method to replace and give it the new smali. "
        "The new_body must be complete smali for the method, starting with '.method' and ending with '.end method'. "
        "Example new_body to make a method return true: "
        "'.method public checkLicense()Z\\n    const/4 v0, 0x1\\n    return v0\\n.end method'"
    ),
    params_schema={
        "smali_file": "string (path to the .smali file, relative to /workspace, e.g. 'smali/com/example/MainActivity.smali')",
        "method_name": "string (the method name to find and replace, e.g. 'checkLicense' or 'onCreate' — matched as a substring of the .method line)",
        "new_body": "string (complete smali code for the replacement method, including '.method ...' and '.end method' lines)"
    },
    output="On success: 'Method <method_name> replaced in <file>. <N> lines old -> <M> lines new.' If the method or file is not found, an error message explains what went wrong.",
    when_to_use="Use this to edit a specific method's logic in a smali file. This is the main DEX editing tool — common uses: bypass a check (make it return true/false), replace a verification method, stub out a function, or change a method's behavior. For whole-file edits, use write_file instead."
)
def patch_smali_method(smali_file, method_name, new_body):
    smali_file = normalize_path(smali_file)
    # We pass the new method body as base64 to avoid shell escaping issues with smali code
    b64_body = base64.b64encode(new_body.encode("utf-8")).decode("ascii")
    # The Python script runs inside the sandbox, reads the file, finds the method,
    # replaces its body, and writes it back.
    script = (
        "import sys, base64\n"
        f"filepath = '/workspace/{smali_file}'\n"
        f"method_name = {method_name!r}\n"
        "new_body = base64.b64decode(sys.argv[1]).decode('utf-8')\n"
        "try:\n"
        "    with open(filepath, 'r', encoding='utf-8') as f:\n"
        "        lines = f.read().split('\\n')\n"
        "except FileNotFoundError:\n"
        "    print('ERROR: File not found: ' + filepath)\n"
        "    sys.exit(1)\n"
        "start = None\n"
        "for i, line in enumerate(lines):\n"
        "    stripped = line.strip()\n"
        "    if stripped.startswith('.method') and method_name in stripped:\n"
        "        start = i\n"
        "        break\n"
        "if start is None:\n"
        "    print('ERROR: Method not found: ' + method_name)\n"
        "    sys.exit(1)\n"
        "end = None\n"
        "for i in range(start + 1, len(lines)):\n"
        "    if lines[i].strip() == '.end method':\n"
        "        end = i\n"
        "        break\n"
        "if end is None:\n"
        "    print('ERROR: No .end method found after method start')\n"
        "    sys.exit(1)\n"
        "old_count = end - start + 1\n"
        "new_lines = new_body.split('\\n')\n"
        "new_count = len(new_lines)\n"
        "result = lines[:start] + new_lines + lines[end + 1:]\n"
        "with open(filepath, 'w', encoding='utf-8') as f:\n"
        "    f.write('\\n'.join(result))\n"
        f"print('Method {method_name} replaced in {smali_file}. ' + str(old_count) + ' lines old -> ' + str(new_count) + ' lines new.')\n"
    )
    b64_script = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = f"echo '{b64_script}' | base64 -d | python3 - '{b64_body}'"
    return run_cmd(cmd, timeout=30)


@registry.register(
    name="insert_smali_code",
    description=(
        "Inserts new smali code (a new .method, a new .field, or any other smali block) into an "
        "existing .smali class file, WITHOUT touching any existing method — unlike "
        "patch_smali_method, which only replaces a method that already exists. Use this to ADD "
        "brand new logic to a class: a new helper method with custom behavior, a new field to "
        "hold state, or an extra block near an existing method. "
        "anchor controls where the code is inserted: 'end_of_class' (default, right before the "
        "final '.end class' line — safe for adding new methods/fields) or 'after_method:<name>' "
        "(right after the '.end method' that closes the named method — useful for keeping related "
        "methods grouped together)."
    ),
    params_schema={
        "smali_file": "string (path to the .smali file, relative to /workspace)",
        "code": "string (complete new smali code to insert, e.g. a full '.method ... .end method' block or a '.field ...' declaration)",
        "anchor": "string (optional, default 'end_of_class'; or 'after_method:<method_name>' to insert right after that method's '.end method')"
    },
    output="On success: 'Inserted N line(s) into <file> at <anchor>.' If the anchor method can't be found (for 'after_method:<name>'), or the file has no '.end class' line, an error explains what went wrong.",
    when_to_use="Use this to ADD a new method or field that doesn't exist yet. For editing/replacing the body of a method that already exists, use patch_smali_method instead — inserting a second '.method' with the same name/signature as an existing one produces invalid smali that will fail to assemble."
)
def insert_smali_code(smali_file, code, anchor="end_of_class"):
    smali_file = normalize_path(smali_file)
    b64_code = base64.b64encode(code.encode("utf-8")).decode("ascii")
    script = (
        "import sys, base64\n"
        f"filepath = '/workspace/{smali_file}'\n"
        f"anchor = {anchor!r}\n"
        "new_code = base64.b64decode(sys.argv[1]).decode('utf-8')\n"
        "try:\n"
        "    with open(filepath, 'r', encoding='utf-8') as f:\n"
        "        lines = f.read().split('\\n')\n"
        "except FileNotFoundError:\n"
        "    print('ERROR: File not found: ' + filepath)\n"
        "    sys.exit(1)\n"
        "new_lines = new_code.split('\\n')\n"
        "if anchor.startswith('after_method:'):\n"
        "    method_name = anchor.split(':', 1)[1]\n"
        "    insert_at = None\n"
        "    in_target = False\n"
        "    for i, line in enumerate(lines):\n"
        "        stripped = line.strip()\n"
        "        if stripped.startswith('.method') and method_name in stripped:\n"
        "            in_target = True\n"
        "        elif in_target and stripped == '.end method':\n"
        "            insert_at = i + 1\n"
        "            break\n"
        "    if insert_at is None:\n"
        "        print('ERROR: Method not found: ' + method_name)\n"
        "        sys.exit(1)\n"
        "else:\n"
        "    insert_at = None\n"
        "    for i in range(len(lines) - 1, -1, -1):\n"
        "        if lines[i].strip() == '.end class':\n"
        "            insert_at = i\n"
        "            break\n"
        "    if insert_at is None:\n"
        "        print('ERROR: No .end class line found in ' + filepath)\n"
        "        sys.exit(1)\n"
        "result = lines[:insert_at] + new_lines + lines[insert_at:]\n"
        "with open(filepath, 'w', encoding='utf-8') as f:\n"
        "    f.write('\\n'.join(result))\n"
        "print('Inserted ' + str(len(new_lines)) + ' line(s) into ' + filepath + ' at ' + anchor + '.')\n"
    )
    b64_script = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = f"echo '{b64_script}' | base64 -d | python3 - '{b64_code}'"
    return run_cmd(cmd, timeout=30)
