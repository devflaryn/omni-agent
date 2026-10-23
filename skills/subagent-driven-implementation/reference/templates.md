# Templates

## Implementer brief (agent_start kind "claude")

```
Goal: add a CSV serializer, src/csv.js, that the /export route will use.

Context:
- Repo: C:\work\shop (Node 22, ESM, tests: `npm test`, node:test files in test/).
- Contract (the route task depends on it, do not change it):
  export function toCsv(rows: object[], { columns?: string[], header = true } = {}): string
- Follow src/json-export.js for style and error handling.
- Decided already: RFC 4180 quoting, CRLF line ends, null/undefined -> empty cell.

Scope: create src/csv.js and test/csv.test.js only. Do not touch routes, UI or README. Do not commit.

Done when: `npm test` passes, and the new tests cover quoting, embedded newlines, missing keys,
the columns option and an empty input.

Report: the files you changed, the test command you ran and its summary line, anything you
were unsure of or left out.
```

## Reviewer persona (~/.pi/agent/agents/reviewer.md)

```markdown
---
name: reviewer
description: Reviews one uncommitted change against the task it was meant to do and reports real problems by severity with file:line. Use after an implementer finishes and before the next task starts.
tools: read, grep, find, ls, bash
---

You review ONE change. You do not edit files.

## Inputs
The task text you are given, and the working tree (`git diff`, `git status`, new files).

## Check, in this order
1. Spec: does the change do exactly what the task asked? Anything missing? Anything extra that
   was not asked for (new features, unrelated edits, changed contracts)?
2. Correctness: bugs, unhandled edge cases, broken error paths, races.
3. Tests: do they test the behaviour the task asked for, and do they pass (run them)?
4. Fit: does it match the surrounding code's naming, structure and idioms?

## Output, nothing else
VERDICT: approve | changes needed
- [critical|important|minor] path/to/file.ext:123: the problem, and the fix in one sentence
Tests: the command you ran and its result.
```

Smoke test after writing it:
`agent_start {kind: "pi", agent: "reviewer", title: "reviewer smoke test", task: "Review <a file in the repo> (or the uncommitted diff, when there is one) against this task: <one line>."}` — then check the report has the VERDICT format.
