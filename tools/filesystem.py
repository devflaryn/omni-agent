from tool_registry import registry
from tools.common import normalize_path
from docker_sandbox import run_cmd
import os

@registry.register(
    name="list_directory",
    description="Lists files and folders inside a given directory in the workspace. Use this FIRST to see what files are available. Example: '.' lists the root of the active project workspace.",
    params_schema={"directory": "string (path relative to workspace or absolute starting with /workspace, default '.')"},
    output="A text listing (ls -la format) with file permissions, owner, size, date, and name for each entry. Directories end with '/'. Hidden files are shown.",
    when_to_use="Call this first whenever you enter a new workspace or need to discover what files/folders exist before reading or editing them."
)
def list_directory(directory="."):
    directory = normalize_path(directory)
    cmd = f"ls -la /workspace/{directory}"
    return run_cmd(cmd)

@registry.register(
    name="find_files",
    description=(
        "Recursively finds files (and folders) by name pattern anywhere under a directory. "
        "Use this to locate a file in a large decompiled/jadx tree when you know its name but not its path "
        "(e.g. find 'MainActivity.smali', all '*.so', every 'AndroidManifest.xml', or classes named '*Login*'). "
        "Much faster than list_directory-ing folder by folder. The pattern is a shell glob matched against the "
        "file NAME only (not the full path)."
    ),
    params_schema={
        "name_pattern": "string (glob against the filename, e.g. '*.so', 'MainActivity.smali', '*Login*')",
        "directory": "string (optional, directory to search under, relative to /workspace, default '.')",
        "type": "string (optional, 'f' for files only, 'd' for directories only, omit for both)",
        "max_results": "integer (optional, default 200)"
    },
    output="One matching path per line (relative to /workspace). Capped at max_results. Says so if nothing matches.",
    when_to_use="Use this to locate files by name in a big tree (which .dex has a class, where a .so lives, finding a specific smali/java/xml file) instead of walking directories manually. To search file CONTENTS instead of names, use grep_directory / search_smali."
)
def find_files(name_pattern, directory=".", type=None, max_results=200):
    directory = normalize_path(directory)
    try:
        max_results = int(max_results)
    except (TypeError, ValueError):
        max_results = 200
    type_flag = ""
    if type in ("f", "d"):
        type_flag = f"-type {type} "
    # -iname for case-insensitive name matching; strip the /workspace/ prefix so
    # results are workspace-relative like every other tool's paths.
    cmd = (
        f"find /workspace/{directory} {type_flag}-iname '{name_pattern}' 2>/dev/null "
        f"| sed 's#^/workspace/##' | head -n {max_results}"
    )
    res = run_cmd(cmd, timeout=90)
    if res.get("returncode") == 0 and not res.get("stdout", "").strip():
        return {"stdout": f"(no files matching '{name_pattern}' under {directory})"}
    return res


@registry.register(
    name="read_file_chunk",
    description=(
        "Reads a specific chunk of lines from a text file. Use this for large files (smali, decompiled C, "
        "scripts) to avoid context overflow. Always check total lines and continue with the next chunk if "
        "needed. IMPORTANT: this is for reading the ONE slice you've already pinpointed — NOT for exploring "
        "a decompiled app by opening file after file. In a decompiled/large tree, first build_code_graph + "
        "query_code_graph (smali) or grep_directory / find_files / search_smali to locate the exact file:line, "
        "then read just that slice here. Reading many files in a row to 'understand the app' will blow your "
        "context and is the wrong approach."
    ),
    params_schema={
        "filepath": "string (path relative to workspace or absolute)",
        "start_line": "integer (1-indexed, default 1)",
        "num_lines": "integer (number of lines to read, e.g., 100, default 150)"
    },
    output="A header showing the line range and TOTAL line count of the file, followed by the raw text of those lines. If the file continues, a hint tells you the next start_line to use.",
    when_to_use="Use this to read a SPECIFIC slice a graph query (query_code_graph) or a search (grep_directory/search_smali/find_files) already pointed you to. For huge files, page through with start_line in ~150-line chunks. For logs where the interesting part is at the end, prefer tail_file. If you find yourself about to read a series of files just to figure out where something is, stop and use build_code_graph/query_code_graph or a search instead."
)
def read_file_chunk(filepath, start_line=1, num_lines=150):
    filepath = normalize_path(filepath)
    end_line = start_line + num_lines - 1
    # Check total lines to give context to the LLM
    count_cmd = f"wc -l < /workspace/{filepath}"
    count_res = run_cmd(count_cmd)
    
    total_lines = "Unknown"
    if count_res['returncode'] == 0:
        total_lines = count_res['stdout'].strip()

    # Read the actual lines
    cmd = f"sed -n '{start_line},{end_line}p' /workspace/{filepath}"
    res = run_cmd(cmd)
    
    if res['returncode'] == 0:
        output = f"--- Reading lines {start_line} to {end_line} of {filepath} (Total Lines: {total_lines}) ---\n"
        output += res['stdout']
        if end_line < int(total_lines if total_lines.isdigit() else 0):
            output += f"\n--- (File continues, use read_file_chunk with start_line={end_line + 1} to read more) ---"
        return {"stdout": output}
    return res

@registry.register(
    name="write_file",
    description="Writes text content to a file in the workspace. Overwrites existing content. Use this to edit smali files, scripts, or any text artifact. The path is relative to /workspace.",
    params_schema={"filepath": "string (path relative to workspace)", "content": "string"},
    output="A confirmation line 'Successfully wrote to /workspace/<filepath>' on success, or the stderr/error from the shell command on failure.",
    when_to_use="Use this to CREATE new files or FULLY OVERWRITE existing ones. To edit only part of a file, read it first with read_file_chunk, modify the content in memory, then write the full content back."
)
def write_file(filepath, content):
    filepath = normalize_path(filepath)
    # Easiest way to write a file from host to sandbox safely is via the mounted host volume.
    # Note: this assumes we are dealing with the current project's workspace.
    # A more robust way is to run a command inside docker using tee, but host write is fine if CWD is correct.
    
    # We should actually use the run_cmd to echo/tee into it if we want it completely safe from project switching,
    # but let's stick to the host-side write for large contents, just fixing the path issue.
    # Actually, the agent.py dynamically mounts the project directory. If write_file just uses ./workspace/ it might write to the root workspace folder, not the project workspace folder.
    # Wait, the current project's directory is passed to docker, but not saved globally for `write_file`? 
    # Let's fix that by writing via Docker! It's much safer!
    
    # Write using a base64 encoded string to avoid shell escaping issues
    import base64
    b64_content = base64.b64encode(content.encode('utf-8')).decode('utf-8')
    cmd = f"mkdir -p $(dirname /workspace/{filepath}) && echo '{b64_content}' | base64 -d > /workspace/{filepath}"
    res = run_cmd(cmd)
    
    if res['returncode'] == 0:
        return {"stdout": f"Successfully wrote to /workspace/{filepath}"}
    return res

@registry.register(
    name="delete_path",
    description="Deletes a file or directory recursively inside the workspace. Use this to remove files the user asks you to remove, or to clean up temporary artifacts.",
    params_schema={"filepath": "string (path relative to workspace)"},
    output="A confirmation line 'Successfully deleted /workspace/<filepath>' on success, or an error if the path is the workspace root or the shell command fails.",
    when_to_use="Use this when the user asks to remove a file or folder, or when you need to clean up temporary/intermediate artifacts you created."
)
def delete_path(filepath):
    filepath = normalize_path(filepath)
    if not filepath or filepath == ".":
        return {"error": "Cannot delete root workspace directory."}
    cmd = f"rm -rf /workspace/{filepath}"
    res = run_cmd(cmd)
    if res['returncode'] == 0:
        return {"stdout": f"Successfully deleted /workspace/{filepath}"}
    return res

@registry.register(
    name="move_file",
    description=(
        "Moves or renames a file or directory inside the workspace. "
        "Use this to relocate files or rename them. "
        "Both source and destination are relative to /workspace. "
        "Parent directories of the destination are created automatically if they do not exist."
    ),
    params_schema={
        "source": "string (path relative to workspace, e.g. 'lib/arm64-v8a/libfoo.so')",
        "destination": "string (path relative to workspace, e.g. 'backup/libfoo.so')"
    },
    output="A confirmation line 'Moved /workspace/<source> -> /workspace/<destination>' on success, or an error if either path is the workspace root or the move fails.",
    when_to_use="Use this to relocate or rename a file/folder. To copy without removing the original, use duplicate_file instead."
)
def move_file(source, destination):
    source = normalize_path(source)
    destination = normalize_path(destination)
    if not source or source == ".":
        return {"error": "Source path cannot be the workspace root."}
    if not destination or destination == ".":
        return {"error": "Destination path cannot be the workspace root."}
    cmd = (
        f"mkdir -p $(dirname /workspace/{destination}) && "
        f"mv /workspace/{source} /workspace/{destination}"
    )
    res = run_cmd(cmd)
    if res['returncode'] == 0:
        return {"stdout": f"Moved /workspace/{source} -> /workspace/{destination}"}
    return res

@registry.register(
    name="duplicate_file",
    description=(
        "Finds a file (or directory) in the workspace and places an exact copy of it at a new location. "
        "Use this when you need to duplicate a file without removing the original — for example, "
        "backing up a .so library before patching it, or copying a config into a different folder. "
        "Source is found anywhere under /workspace; the copy is placed at the given destination path. "
        "Parent directories of the destination are created automatically if they do not exist."
    ),
    params_schema={
        "source": "string (path relative to workspace of the file or directory to copy, e.g. 'lib/arm64-v8a/libfoo.so')",
        "destination": "string (path relative to workspace for the copy, e.g. 'backup/libfoo.so')"
    },
    output="A confirmation line 'Duplicated /workspace/<source> -> /workspace/<destination>' on success, or an error if either path is the workspace root or the copy fails.",
    when_to_use="Use this to back up a file before modifying it (e.g. copy a .so before hex-patching), or to place a copy of a file/template into a new location. To move (remove original), use move_file."
)
def duplicate_file(source, destination):
    source = normalize_path(source)
    destination = normalize_path(destination)
    if not source or source == ".":
        return {"error": "Source path cannot be the workspace root."}
    if not destination or destination == ".":
        return {"error": "Destination path cannot be the workspace root."}
    cmd = (
        f"mkdir -p $(dirname /workspace/{destination}) && "
        f"cp -r /workspace/{source} /workspace/{destination}"
    )
    res = run_cmd(cmd)
    if res['returncode'] == 0:
        return {"stdout": f"Duplicated /workspace/{source} -> /workspace/{destination}"}
    return res
