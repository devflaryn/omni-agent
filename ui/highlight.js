/* Syntax colouring for the editor: one pass over the whole text (so block comments, template strings and
   triple-quoted strings that span lines need no line state), sticky regexes tried in order at each position,
   identifiers sorted into keyword / type / literal / function afterwards. No DOM, so `node --test` imports it.
   Output is HTML: escaped text in <span class="t-…"> runs; the editor lays it under a transparent textarea. */
import { esc } from "./lib.js";

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const LIT = words("true false null undefined NaN Infinity nil None True False NULL nullptr this self super");

// ------------------------------------------------------------- languages
const C_LIKE_OPS = [/[+\-*/%=&|^!<>?:~]+/y, "op"];
// Every run that a lookahead or a closing mark may reject is bounded: tried again from each position, an unbounded one is quadratic on a far machine's file.
const NUM = [/(?:0[xX][\da-fA-F_]{1,64}|0[bB][01_]{1,64}|0[oO][0-7_]{1,64}|(?:\d[\d_]{0,63}(?:\.[\d_]{0,63})?|\.\d[\d_]{0,63})(?:[eE][+-]?\d{1,8})?)[a-zA-Z]{0,16}\b/y, "num"];
const WS = [/\s+/y, null];
const IDENT = [/[A-Za-z_$][\w$]*/y, "id"];
const DQ = [/"(?:\\[\s\S]|[^"\\\n])*"?/y, "str"];
const SQ = [/'(?:\\[\s\S]|[^'\\\n])*'?/y, "str"];
const BT = [/`(?:\\[\s\S]|[^`\\])*`?/y, "str"];
const SLASH_COM = [/\/\/[^\n]*/y, "com"];
const BLOCK_COM = [/\/\*[\s\S]*?(?:\*\/|$)/y, "com"];
const HASH_COM = [/#[^\n]*/y, "com"];
const PUNCT = [/[{}()[\];,.]/y, "punct"];

const cLike = (kw, { types = "", extra = [], hashCom = false, preproc = false, idUpperType = true, ci = false } = {}) => ({
  rules: [WS, ...(preproc ? [[/#\s*[a-z]+[^\n]*/y, "meta"]] : []), SLASH_COM, BLOCK_COM, ...(hashCom ? [HASH_COM] : []), ...extra, DQ, SQ, NUM, IDENT, PUNCT, C_LIKE_OPS],
  kw: words(kw), types: words(types), idUpperType, ci,
});

const JS_KW = "break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static switch throw try typeof var void while with yield async await as";
const TS_EXTRA = "interface type enum implements namespace declare abstract private protected public readonly keyof infer is satisfies override";
const JS_TYPES = "string number boolean any unknown never object symbol bigint void Array Promise Map Set Record Partial Error Date RegExp JSON Math Object String Number Boolean";

const LANGS = {
  js: cLike(JS_KW, { types: JS_TYPES, extra: [BT, [/@[\w.]+/y, "meta"]] }),
  ts: cLike(`${JS_KW} ${TS_EXTRA}`, { types: JS_TYPES, extra: [BT, [/@[\w.]+/y, "meta"]] }),
  json: { rules: [WS, SLASH_COM, BLOCK_COM, [/"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y, "prop"], DQ, NUM, IDENT, PUNCT, [/:/y, "punct"]], kw: words(""), types: words("") },
  py: {
    rules: [WS, HASH_COM, [/[rRbBuUfF]{0,2}("""|''')[\s\S]*?(?:\1|$)/y, "str"], [/[rRbBuUfF]{1,2}(?=["'])/y, "str"], DQ, SQ, [/@[\w.]+/y, "meta"], NUM, IDENT, PUNCT, C_LIKE_OPS],
    kw: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    types: words("int float str bytes bool list dict set tuple object type print len range open isinstance super Exception ValueError TypeError KeyError"),
  },
  sh: {
    rules: [WS, [/(^|(?<=\s))#[^\n]*/y, "com"], [/\$(?:\{[^}\n]{0,500}\}|\(|[\w@#?$!*-])/y, "var"], DQ, SQ, NUM, [/[\w-]{1,100}(?==)/y, "var"], [/[A-Za-z_][\w-]*/y, "id"], [/[|&;<>()]+/y, "op"]],
    kw: words("if then else elif fi for while until do done case esac in function return local export readonly declare set unset shift exit break continue source alias echo cd"), types: words(""),
  },
  ps1: {
    rules: [WS, [/<#[\s\S]*?(?:#>|$)/y, "com"], HASH_COM, [/\$[\w:]+|\$\{[^}\n]{0,500}\}/y, "var"], DQ, SQ, NUM, [/[A-Za-z]+-[A-Za-z]+/y, "fn"], [/-[A-Za-z]+/y, "attr"], IDENT, PUNCT, [/[+\-*/%=!<>|&]+/y, "op"]],
    kw: words("if else elseif switch foreach for while do until function param return break continue try catch finally throw begin process end filter in"), types: words(""), ci: true,
  },
  bat: {
    rules: [WS, [/(?:^|(?<=\n))\s*(?:rem\b|::)[^\n]*/iy, "com"], [/%[\w~:]+%|%~?\d|!\w+!/y, "var"], DQ, NUM, [/:[\w]+/y, "fn"], IDENT, [/[|&<>()@=]+/y, "op"]],
    kw: words("if else for in do goto call set setlocal endlocal echo exit not exist defined errorlevel off on start shift pushd popd"), types: words(""), ci: true,
  },
  c: cLike("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool class namespace template typename public private protected virtual override new delete using try catch throw const_cast static_cast dynamic_cast reinterpret_cast operator friend constexpr noexcept nullptr this", { preproc: true, types: "size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t std string vector" }),
  java: cLike("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized throw throws transient try volatile while var record sealed permits yield", { extra: [[/@\w+/y, "meta"]], types: "int long short byte char float double boolean void String Object List Map Integer" }),
  kt: cLike("as break class continue do else for fun if in interface is null object package return super this throw try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg", { extra: [BT, [/@\w+/y, "meta"]], types: "Int Long Short Byte Char Float Double Boolean Unit String Any Nothing List Map" }),
  cs: cLike("abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch throw try typeof unchecked unsafe using virtual volatile while var async await get set value record init", { preproc: true, extra: [[/@"(?:""|[^"])*"/y, "str"], [/\[[A-Z]\w*(?=[\](])/y, "meta"]], types: "int long short byte char float double decimal bool void string object" }),
  go: cLike("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var", { extra: [BT], types: "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any" }),
  rs: cLike("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while Self", { extra: [[/'[a-z_]\w*(?!')/y, "type"], [/[a-z_]\w*!/y, "fn"], [/#!?\[[^\]\n]{0,500}\]/y, "meta"], [/r#*"[\s\S]*?"#*/y, "str"]], types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Some Ok Err" }),
  swift: cLike("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is rethrows throw throws try async await some any", { extra: [[/@\w+/y, "meta"]], types: "Int Double Float String Bool Character Array Dictionary Set Optional Any Void" }),
  php: cLike("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public require require_once return static switch throw trait try unset use var while xor yield", { hashCom: true, extra: [[/\$\w+/y, "var"]] }),
  dart: cLike("abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory final finally for get hide if implements import in interface is late library mixin new on operator part required rethrow return set show static super switch sync this throw try typedef var void while with yield", { extra: [[/@\w+/y, "meta"]], types: "int double num String bool List Map Set Future Stream" }),
  lua: { rules: [WS, [/--\[(=*)\[[\s\S]*?(?:\]\1\]|$)/y, "com"], [/--[^\n]*/y, "com"], [/\[(=*)\[[\s\S]*?(?:\]\1\]|$)/y, "str"], DQ, SQ, NUM, IDENT, PUNCT, [/[+\-*/%^#=~<>:]+/y, "op"]], kw: words("and break do else elseif end for function goto if in local not or repeat return then until while"), types: words("") },
  rb: { rules: [WS, [/=begin[\s\S]*?(?:=end|$)/y, "com"], HASH_COM, DQ, SQ, [/:\w+/y, "lit"], [/@@?\w+|\$\w+/y, "var"], NUM, [/[A-Za-z_]\w*[?!]?/y, "id"], PUNCT, C_LIKE_OPS], kw: words("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return then undef unless until when while yield require require_relative attr_accessor attr_reader puts"), types: words(""), idUpperType: true },
  sql: { rules: [WS, [/--[^\n]*/y, "com"], BLOCK_COM, SQ, DQ, [/`[^`]*`/y, "prop"], NUM, IDENT, PUNCT, [/[+\-*/%=<>!|]+/y, "op"]], kw: words("select from where and or not insert into values update set delete create table drop alter add column index view join left right inner outer full on as group by order having limit offset distinct union all case when then else end is null like in between exists primary key foreign references default unique begin commit rollback transaction with returning if replace trigger database schema asc desc count sum avg min max"), types: words("int integer bigint smallint text varchar char boolean date timestamp real float double numeric blob json"), ci: true },
  css: { css: true, rules: [WS, BLOCK_COM, SLASH_COM, DQ, SQ, [/@[\w-]+/y, "kw"], [/#[\da-fA-F]{3,8}\b/y, "num"], [/-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, "num"], [/--[\w-]+/y, "var"], [/[\w-]+(?=\()/y, "fn"], [/[.#][\w-]+|[\w-]+|&/y, "sel"], [/::?[\w-]+/y, "attr"], [/[{}]/y, "brace"], [/[;:,()>+~*=[\]]/y, "punct"]], kw: words(""), types: words("") },
  md: {
    rules: [[/```[^\n]{0,500}\n[\s\S]*?(?:\n```[^\n]*|$)/y, "str"], [/(?:^|(?<=\n))#{1,6}[^\n]*/y, "head"], [/(?:^|(?<=\n))[ \t]{0,100}>[^\n]*/y, "com"], [/(?:^|(?<=\n))[ \t]{0,100}(?:[-*+]|\d{1,9}\.)(?=\s)/y, "op"], [/`[^`\n]+`/y, "str"], [/\*\*[^*\n]+\*\*|__[^_\n]+__/y, "strong"], [/\*[^*\n]+\*|_[^_\n]+_/y, "em"], [/!?\[[^\]\n]{0,500}\]\([^)\n]{0,500}\)/y, "link"], [/<[^>\n]{1,500}>/y, "tag"], [/[^\n`*_[!<#>]+|[\s\S]/y, null]],
    kw: words(""), types: words(""), plainIds: true,
  },
  yaml: { rules: [WS, [/(^|(?<=\s))#[^\n]*/y, "com"], [/^---|(?<=\n)---|(?<=\n)\.\.\./y, "meta"], [/[\w.\-/][\w.\-/ ]{0,80}(?=[ \t]{0,40}:(?:\s|$))/y, "prop"], [/-(?=\s)/y, "op"], DQ, SQ, [/[&*][\w-]+/y, "var"], [/!!?[\w/]+/y, "type"], NUM, [/[|>][-+]?(?=\s*\n)/y, "op"], IDENT, [/[^\s#"':]+/y, null], [/[:\-,[\]{}]/y, "punct"]], kw: words(""), types: words(""), lit: words("true false null yes no on off ~") },
  toml: { rules: [WS, [/[#;][^\n]*/y, "com"], [/\[\[?[^\]\n]{0,500}\]\]?/y, "type"], [/"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/y, "str"], [/[\w.\-"']{1,100}(?=[ \t]{0,40}[=:])/y, "prop"], DQ, SQ, NUM, IDENT, [/[=:,[\]{}]/y, "punct"]], kw: words(""), types: words("") },
  diff: { rules: [[/(?:^|(?<=\n))(?:diff |index |--- |\+\+\+ )[^\n]*/y, "head"], [/(?:^|(?<=\n))\+[^\n]*/y, "ins"], [/(?:^|(?<=\n))-[^\n]*/y, "del"], [/(?:^|(?<=\n))@@[^\n]*/y, "meta"], [/[^\n]*\n?/y, null]], kw: words(""), types: words(""), plainIds: true },
  docker: { rules: [WS, HASH_COM, [/(?:^|(?<=\n))\s*[A-Za-z]+(?=\s)/y, "kw"], DQ, SQ, [/\$\{?\w+\}?/y, "var"], NUM, [/[^\s"'$#]+/y, null]], kw: words(""), types: words(""), plainIds: true },
  make: { rules: [WS, HASH_COM, [/(?:^|(?<=\n))[\w.%/-]{1,200}(?=[ \t]{0,40}:(?!=))/y, "fn"], [/\$[({][^)}\n]{0,500}[)}]|\$[@<^*?%]/y, "var"], [/[\w.]{1,100}(?=[ \t]{0,40}[:+?]?=)/y, "prop"], DQ, SQ, IDENT, [/[^\s\w]/y, "op"]], kw: words("ifeq ifneq ifdef ifndef else endif include define endef export override"), types: words("") },
  smali: { rules: [[/(?<=(?:^|\n)[ \t]*)[a-z][\w/-]*(?=\s|$)/y, "fn"], WS, HASH_COM, [/\.\w[\w-]*/y, "kw"], [/L[\w/$-]{1,500};/y, "type"], [/\b[vp]\d+\b/y, "var"], DQ, [/:\w+/y, "attr"], [/-?0x[\da-fA-F]+|-?\d+/y, "num"], [/[\w$<>-]+/y, null], [/[^\s]/y, "punct"]], kw: words(""), types: words(""), plainIds: true },
  ini: { rules: [WS, [/(?:^|(?<=\n))\s*[#;][^\n]*/y, "com"], [/\[[^\]\n]{0,500}\]/y, "type"], [/[^=\n[#;]{1,100}(?==)/y, "prop"], DQ, SQ, NUM, [/=/y, "punct"], [/[^\n]/y, null]], kw: words(""), types: words(""), plainIds: true },
  log: { rules: [[/\d{4}-\d\d-\d\d[T ][\d:.,]+Z?|\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/y, "num"], [/\b(?:ERROR|FATAL|FAIL(?:ED)?|Error|Exception|panic)\b[^\n]*/y, "err"], [/\b(?:WARN(?:ING)?|warning)\b/y, "warn"], [/\b(?:INFO|DEBUG|TRACE)\b/y, "kw"], DQ, [/[^\n]/y, null]], kw: words(""), types: words(""), plainIds: true },
};
LANGS.html = { html: true };
export const LANGUAGES = Object.keys(LANGS);

// --------------------------------------------------------------- by name
const EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", mts: "ts", cts: "ts", json: "json", jsonc: "json", jsonl: "json", json5: "json", map: "json", webmanifest: "json", ipynb: "json",
  py: "py", pyw: "py", pyi: "py", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ps1: "ps1", psm1: "ps1", psd1: "ps1", bat: "bat", cmd: "bat",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", hxx: "c", ino: "c", m: "c", mm: "c", cu: "c", java: "java", kt: "kt", kts: "kt", gradle: "kt", cs: "cs", go: "go", rs: "rs", swift: "swift", php: "php", dart: "dart", scala: "java", groovy: "java",
  lua: "lua", rb: "rb", sql: "sql", css: "css", scss: "css", sass: "css", less: "css", html: "html", htm: "html", xml: "html", svg: "html", xhtml: "html", vue: "html", svelte: "html", plist: "html", xaml: "html", csproj: "html", props: "html",
  md: "md", markdown: "md", mdx: "md", yml: "yaml", yaml: "yaml", toml: "toml", lock: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "ini", editorconfig: "ini", gitconfig: "ini",
  diff: "diff", patch: "diff", smali: "smali", log: "log", mk: "make",
};
const NAMES = { dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", ".gitignore": "sh", ".env": "ini", ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh", "cmakelists.txt": "sh" };
export const LANG_LABEL = { js: "JavaScript", ts: "TypeScript", json: "JSON", py: "Python", sh: "Shell", ps1: "PowerShell", bat: "Batch", c: "C/C++", java: "Java", kt: "Kotlin", cs: "C#", go: "Go", rs: "Rust", swift: "Swift", php: "PHP", dart: "Dart", lua: "Lua", rb: "Ruby", sql: "SQL", css: "CSS", html: "HTML/XML", md: "Markdown", yaml: "YAML", toml: "TOML", ini: "INI", diff: "Diff", smali: "Smali", log: "Log", docker: "Dockerfile", make: "Makefile", plain: "Plain Text" };

/** Language id for a file name ("plain" when none fits). */
export function languageFor(name) {
  const base = String(name || "").split(/[\\/]/).pop().toLowerCase();
  if (Object.hasOwn(NAMES, base)) return NAMES[base];
  if (/^dockerfile\./.test(base)) return "docker";
  const m = /\.([a-z0-9]+)$/.exec(base);
  if (m && Object.hasOwn(EXT, m[1])) return EXT[m[1]];
  if (/^\.\w+rc$/.test(base)) return "sh";
  return "plain";
}

// ------------------------------------------------------------- tokenizer
/** [[cls|null, text], …] covering `src` exactly. Past `deadline` (a performance.now() time) the rest is one plain run. */
export function tokenize(src, lang, deadline = Infinity) {
  const L = Object.hasOwn(LANGS, lang) ? LANGS[lang] : null;
  if (!L) return [[null, src]];
  if (L.html) return tokenizeHtml(src, deadline);
  const out = [];
  const push = (cls, text) => { const last = out[out.length - 1]; if (last && last[0] === cls) last[1] += text; else out.push([cls, text]); };
  let i = 0, depth = 0, turns = 0;
  const n = src.length;
  while (i < n) {
    if (!(++turns & 31) && performance.now() > deadline) { push(null, src.slice(i)); break; }
    let hit = false;
    for (const [re, cls] of L.rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m || !m[0].length) continue;
      const t = m[0];
      let c = cls;
      if (c === "id") c = L.plainIds ? null : classifyIdent(t, L, src, i + t.length);
      else if (L.css) {
        if (c === "brace") { depth += t === "{" ? 1 : -1; if (depth < 0) depth = 0; c = "punct"; }
        else if (c === "sel") c = depth > 0 ? (/^\s*:/.test(src.slice(i + t.length, i + t.length + 40)) && !/^[.#&]/.test(t) ? "prop" : null) : "tag";
      }
      push(c, t);
      i += t.length; hit = true;
      break;
    }
    if (!hit) { push(null, src[i]); i++; }
  }
  return out;
}

function classifyIdent(t, L, src, end) {
  const k = L.ci ? t.toLowerCase() : t;
  if (L.kw.has(k)) return "kw";
  if ((L.lit || LIT).has(L.ci ? k : t)) return "lit";
  if (L.types.has(t)) return "type";
  // A call: the name right before "(" (spaces allowed).
  let j = end;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  if (src[j] === "(") return "fn";
  if (L.idUpperType && /^[A-Z][a-z0-9]\w*$/.test(t)) return "type";
  return null;
}

/** HTML / XML: tags, attributes, values, comments, entities; <script> and <style> bodies in their own language. */
function tokenizeHtml(src, deadline) {
  const lower = src.length === src.toLowerCase().length ? src.toLowerCase() : null; // once: per closing tag it is quadratic
  const out = [];
  const push = (cls, text) => { if (!text) return; const last = out[out.length - 1]; if (last && last[0] === cls) last[1] += text; else out.push([cls, text]); };
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>?|<\/?[A-Za-z][\w:.-]*|&[#\w]+;/g;
  let i = 0, m, turns = 0;
  while ((m = re.exec(src))) {
    if (!(++turns & 31) && performance.now() > deadline) break;
    push(null, src.slice(i, m.index));
    const t = m[0];
    i = m.index + t.length;
    if (t.startsWith("<!--")) { push("com", t); continue; }
    if (t.startsWith("<![CDATA[")) { push("str", t); continue; }
    if (t.startsWith("<!") || t.startsWith("<?")) { push("meta", t); continue; }
    if (t.startsWith("&")) { push("num", t); continue; }
    push("tag", t);
    // Attributes up to the closing ">".
    const attr = /\s+|[^\s=>/"']+|=|"[^"]*"?|'[^']*'?|\/?>/y;
    attr.lastIndex = i;
    let a, closed = false;
    while (i < src.length && (a = attr.exec(src))) {
      const s = a[0];
      i += s.length;
      if (/^\/?>$/.test(s)) { push("tag", s); closed = true; break; }
      push(/^\s+$/.test(s) ? null : s === "=" ? "punct" : /^["']/.test(s) ? "str" : "attr", s);
      attr.lastIndex = i;
    }
    if (!a && i < src.length) { push(null, src[i]); i++; }
    // An embedded script or style body.
    const name = t.slice(1).toLowerCase();
    if (closed && (name === "script" || name === "style")) {
      const endAt = (lower ?? src.toLowerCase()).indexOf(`</${name}`, i);
      const body = src.slice(i, endAt < 0 ? src.length : endAt);
      for (const tok of tokenize(body, name === "script" ? "js" : "css", deadline)) push(tok[0], tok[1]);
      i += body.length;
    }
    re.lastIndex = i;
  }
  push(null, src.slice(i));
  return out;
}

/** Time for one highlight: a file that takes longer shows the rest uncoloured rather than freeze the window. */
export const HIGHLIGHT_BUDGET_MS = 400;

/** Highlighted HTML for `src` in `lang`. */
export function highlight(src, lang, budgetMs = HIGHLIGHT_BUDGET_MS) {
  if (!lang || lang === "plain" || !Object.hasOwn(LANGS, lang)) return esc(src);
  let html = "";
  for (const [cls, text] of tokenize(src, lang, performance.now() + budgetMs)) html += cls ? `<span class="t-${cls}">${esc(text)}</span>` : esc(text);
  return html;
}
