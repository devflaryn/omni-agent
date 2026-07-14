---
name: code-graph-analysis
description: Efficiently analyze large decompiled codebases using the knowledge graph indexer instead of re-reading thousands of files.
when_to_use: Use this skill when working with a decompiled APK or large smali codebase where you need to navigate classes, methods, call graphs, or string references efficiently without burning context.
allowed-tools: build_code_graph, query_code_graph, read_file_chunk
---

# Code Graph Analysis Skill

When an APK is decompiled, it can produce thousands of .smali files. Reading them one by one wastes context and time. The code knowledge graph lets you query the entire codebase cheaply.

## Step 1 — Build the graph
After decoding an APK with `decode_apk`, call:
```
build_code_graph(root_dir="app_decompiled", include_so=true)
```
This indexes every .smali file and every .so symbol table. It only needs to run once (it caches and only rebuilds when files change). The graph is stored as small chunked JSON files under /workspace/.codegraph/.

## Step 2 — Get an overview
Call `query_code_graph(query_type="stats")` to see total smali files, classes, methods, call edges, string references, and the top 10 classes by method count (usually the most important).

## Step 3 — Navigate efficiently
`query_code_graph` supports 9 query types: `stats`, `search_classes`, `class`, `method`, `callers`, `callees`, `string_refs`, `hierarchy`, `so_symbols`. Load `reference/query-types.md` for the full table of what each one returns and when to reach for it — don't guess which query type fits, the table makes it a one-line lookup.

## Step 4 — Read only what you need
Query results include `file:line` references. Use `read_file_chunk` with that exact file and line number to read just the relevant slice — not the whole file.

## When to rebuild
- If you modify smali files and want the graph updated: `build_code_graph(force=true)`
- If you decompile a different APK: build a new graph pointing at the new root_dir

## Critical Rules
- ALWAYS build the graph BEFORE querying. If you get "No graph found", build it first.
- The graph saves enormous context — prefer it over reading smali files directly whenever possible.
- Use `string_refs` to find anti-tamper checks, hardcoded URLs, and feature flags quickly — this is usually the fastest path into a signature-bypass, ssl-pinning-bypass, or anti-debug-bypass task.
