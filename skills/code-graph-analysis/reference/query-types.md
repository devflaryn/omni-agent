# query_code_graph — query_type Reference

| You want to... | query_type | name argument | Returns |
|---|---|---|---|
| See a summary of the whole codebase | `stats` | (leave empty) | Graph summary + top 10 biggest classes |
| Find a class by (partial) name | `search_classes` | substring, e.g. `MainActivity` | Matching class descriptors + files |
| See a class's methods/fields/super | `class` | class descriptor or `com.foo.Bar` | super/interfaces/fields/methods with line + file |
| Find a method and see what it calls | `method` | `Class;->proto` or substring | file:line + callees + referenced strings |
| Find who calls a method | `callers` | method or class-method | Reverse call-edges (who calls it) |
| See what a class/method calls | `callees` | class or method | Forward call-edges (what it calls) |
| Find where a string literal is used | `string_refs` | substring of the string | file:line + holder method — best tool for finding signature/anti-tamper/pinning checks |
| Walk the inheritance tree | `hierarchy` | class | Superclass chain + direct subclasses + interfaces |
| Find native symbols in a .so | `so_symbols` | .so path or symbol substring | Exported/imported native symbols |

## Tips
- Start broad (`stats`, `search_classes`) then narrow (`class`, `method`) — don't jump straight to `callers`/`callees` on a guessed name.
- `string_refs` is the single highest-value query for reverse-engineering tasks: hardcoded URLs, error messages, and comparison strings almost always sit right next to the check you're looking for.
- All results include `file:line` — always follow up with `read_file_chunk` on that exact location instead of opening the whole file.
- `limit` defaults to 40; raise it only if you know a query will have many legitimate matches (e.g. `callers` on a widely-used utility method).
