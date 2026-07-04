# Smali Syntax Cheatsheet

## Type descriptors
| Java type | Smali descriptor |
|---|---|
| `boolean` | `Z` |
| `byte` | `B` |
| `char` | `C` |
| `short` | `S` |
| `int` | `I` |
| `long` | `J` |
| `float` | `F` |
| `double` | `D` |
| `void` | `V` |
| `String` | `Ljava/lang/String;` |
| `Object` | `Ljava/lang/Object;` |
| any class | `Lcom/example/Foo;` (dots become slashes, trailing `;`) |
| array of X | `[X`, e.g. `[I` = `int[]`, `[Ljava/lang/String;` = `String[]` |

## Method signature format
`methodName(ParamType1ParamType2...)ReturnType`, e.g.:
- `isValid()Z` — no args, returns boolean
- `checkLicense(Ljava/lang/String;I)Z` — takes (String, int), returns boolean
- `<init>(Landroid/content/Context;)V` — a constructor taking a Context, returns void

## Method skeleton
```
.method public checkLicense(Ljava/lang/String;)Z
    .locals 2
    # v0, v1 are local registers you can use freely; p0 is 'this', p1 is the first parameter
    const/4 v0, 0x1
    return v0
.end method
```
- `.locals N` declares how many local (v0..vN-1) registers the method body uses — get this right or the verifier rejects the method.
- Instance methods implicitly receive `p0` = `this`; static methods do not (their first parameter is `p0`).
- `public`/`private`/`protected`, `static`, `final` work as normal Java modifiers, space-separated before the method name.

## Common instructions
| Purpose | Smali |
|---|---|
| Load a small integer constant | `const/4 v0, 0x1` (4-bit range) or `const/16 v0, 0x100` or `const v0, 0x10000` |
| Load a string constant | `const-string v0, "hello"` |
| Return a value | `return v0` (object/int/boolean/etc.) / `return-void` / `return-wide v0` (long/double) |
| Call a static method | `invoke-static {p0, p1}, Lcom/example/Foo;->bar(Ljava/lang/String;)Z` then `move-result v0` to capture the return value |
| Call an instance method | `invoke-virtual {p0}, Lcom/example/Foo;->bar()V` (use `invoke-direct` for private/constructor calls, `invoke-super` to call the superclass's implementation) |
| Read/write an instance field | `iget v0, p0, Lcom/example/Foo;->flag:Z` / `iput v0, p0, Lcom/example/Foo;->flag:Z` |
| Read/write a static field | `sget v0, Lcom/example/Foo;->flag:Z` / `sput v0, Lcom/example/Foo;->flag:Z` |
| Conditional branch | `if-eqz v0, :label` (branch if v0 == 0) / `if-nez v0, :label` (branch if v0 != 0), paired with a `:label` line elsewhere in the method |
| Unconditional jump | `goto :label` |

## Field declaration
```
.field private patchedFlag:Z
```
Add `static` for a static field, and ` = 0x1` (a compile-time constant) only for `static final` primitive/String fields.

## Gotchas
- Register count in `.locals` must cover every `vN` register you reference — an off-by-one here is the most common cause of a build failure.
- `invoke-*` argument lists must match the callee's declared parameter types and count exactly, including `this` for instance calls.
- Wide types (`long`, `double`) occupy TWO consecutive registers (e.g. `v0` and `v1`) — use `move-result-wide`/`return-wide`/`const-wide` for these, not the plain variants.
