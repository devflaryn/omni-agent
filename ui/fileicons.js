/* File-type icons for the tree, tabs and archive lists: a few outline shapes (document, image, film, note,
   archive, PDF, folder) tinted by language family, so a glance tells .ts from .py from .json. */
export const ICONS = {
  folder: `<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v1H4.2L2 12z"/><path d="M2 12l2.2-5H15l-2.2 5z"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>`,
  text: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4"/></svg>`,
  code: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/><path d="M7 8.2 5.8 9.5 7 10.8M9 8.2l1.2 1.3L9 10.8"/></svg>`,
  data: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/><path d="M6.8 7.8c-.6 0-.8.3-.8.8v.4c0 .3-.2.5-.5.5.3 0 .5.2.5.5v.4c0 .5.2.8.8.8M9.2 7.8c.6 0 .8.3.8.8v.4c0 .3.2.5.5.5-.3 0-.5.2-.5.5v.4c0 .5-.2.8-.8.8"/></svg>`,
  markdown: `<svg viewBox="0 0 16 16"><path d="M2 4h12v8H2zM4 10V6l2 2 2-2v4M11 6v4M9.5 8.5 11 10l1.5-1.5"/></svg>`,
  image: `<svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m3 12 3.5-3.5 2 2 2-2L13 12"/></svg>`,
  video: `<svg viewBox="0 0 16 16"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M6.8 6.3v3.4L9.8 8z"/></svg>`,
  audio: `<svg viewBox="0 0 16 16"><path d="M6 11.5V4l6-1.5v7.5"/><circle cx="4.7" cy="11.5" r="1.4"/><circle cx="10.7" cy="10" r="1.4"/></svg>`,
  archive: `<svg viewBox="0 0 16 16"><path d="M3 3h10v10H3zM8 3v2M8 6v2M8 9v1.5M7 10.5h2v2H7z"/></svg>`,
  pdf: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/><path d="M5.8 11.5c1.6-1 3-3.5 2.6-4.6-.3-.7-1.2-.2-.9 1 .4 1.6 2 3.2 3 3 .8-.2.2-1-1.4-.8-1.2.2-2.7.8-3.3 1.4z"/></svg>`,
  binary: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/><path d="M6 9h4M6 11h2" stroke-dasharray="1 1.5"/></svg>`,
  config: `<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/><circle cx="8" cy="9.8" r="1.3"/><path d="M8 7.3v.9M8 11.4v.9M5.5 9.8h.9M9.6 9.8h.9"/></svg>`,
  lock: `<svg viewBox="0 0 16 16"><rect x="4" y="7" width="8" height="6.5" rx="1"/><path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7"/></svg>`,
};

// extension → [shape, colour family]
const MAP = {
  js: ["code", "js"], mjs: ["code", "js"], cjs: ["code", "js"], jsx: ["code", "react"], ts: ["code", "ts"], tsx: ["code", "react"], mts: ["code", "ts"], cts: ["code", "ts"],
  json: ["data", "json"], jsonc: ["data", "json"], jsonl: ["data", "json"], json5: ["data", "json"], map: ["data", "dim"], ipynb: ["data", "py"],
  py: ["code", "py"], pyw: ["code", "py"], pyi: ["code", "py"], rb: ["code", "rb"], php: ["code", "php"], lua: ["code", "lua"],
  sh: ["code", "sh"], bash: ["code", "sh"], zsh: ["code", "sh"], fish: ["code", "sh"], ps1: ["code", "ps"], psm1: ["code", "ps"], bat: ["code", "sh"], cmd: ["code", "sh"],
  c: ["code", "c"], h: ["code", "c"], cc: ["code", "cpp"], cpp: ["code", "cpp"], cxx: ["code", "cpp"], hpp: ["code", "cpp"], m: ["code", "c"], mm: ["code", "cpp"], cs: ["code", "cs"],
  java: ["code", "java"], kt: ["code", "kt"], kts: ["code", "kt"], gradle: ["config", "kt"], scala: ["code", "rb"], go: ["code", "go"], rs: ["code", "rs"], swift: ["code", "swift"], dart: ["code", "go"], smali: ["code", "smali"],
  html: ["code", "html"], htm: ["code", "html"], xml: ["code", "html"], svg: ["image", "img"], vue: ["code", "vue"], svelte: ["code", "html"], css: ["code", "css"], scss: ["code", "scss"], sass: ["code", "scss"], less: ["code", "css"],
  md: ["markdown", "md"], markdown: ["markdown", "md"], mdx: ["markdown", "md"], txt: ["text", "dim"], log: ["text", "dim"], csv: ["data", "sh"], tsv: ["data", "sh"], sql: ["data", "ts"],
  yml: ["config", "yaml"], yaml: ["config", "yaml"], toml: ["config", "yaml"], ini: ["config", "dim"], cfg: ["config", "dim"], conf: ["config", "dim"], properties: ["config", "dim"], env: ["config", "yaml"], lock: ["lock", "dim"],
  png: ["image", "img"], jpg: ["image", "img"], jpeg: ["image", "img"], gif: ["image", "img"], webp: ["image", "img"], bmp: ["image", "img"], ico: ["image", "img"], avif: ["image", "img"],
  mp4: ["video", "media"], m4v: ["video", "media"], webm: ["video", "media"], mov: ["video", "media"], mkv: ["video", "media"], ogv: ["video", "media"],
  mp3: ["audio", "audio"], wav: ["audio", "audio"], ogg: ["audio", "audio"], oga: ["audio", "audio"], opus: ["audio", "audio"], m4a: ["audio", "audio"], aac: ["audio", "audio"], flac: ["audio", "audio"],
  zip: ["archive", "zip"], apk: ["archive", "apk"], jar: ["archive", "java"], aar: ["archive", "apk"], xapk: ["archive", "apk"], apks: ["archive", "apk"], ipa: ["archive", "zip"], gz: ["archive", "zip"], tgz: ["archive", "zip"], tar: ["archive", "zip"], "7z": ["archive", "zip"], rar: ["archive", "zip"],
  pdf: ["pdf", "pdf"], exe: ["binary", "bin"], dll: ["binary", "bin"], so: ["binary", "bin"], dylib: ["binary", "bin"], bin: ["binary", "bin"], dex: ["binary", "apk"], o: ["binary", "bin"], class: ["binary", "java"], wasm: ["binary", "bin"], db: ["data", "dim"], sqlite: ["data", "dim"],
};
const NAMES = { dockerfile: ["config", "docker"], makefile: ["config", "dim"], license: ["text", "yaml"], ".gitignore": ["config", "dim"], ".gitattributes": ["config", "dim"], ".env": ["config", "yaml"], "package.json": ["data", "npm"], "package-lock.json": ["lock", "npm"], "tsconfig.json": ["config", "ts"], "readme.md": ["markdown", "info"], "cargo.toml": ["config", "rs"], "go.mod": ["config", "go"] };

/** [shape, colour family] for a file name. */
export function iconFor(name) {
  const base = String(name || "").split(/[\\/]/).pop().toLowerCase();
  // Own keys only: a file called "constructor" is a file name, not this object's method.
  if (Object.hasOwn(NAMES, base)) return NAMES[base];
  const m = /\.([a-z0-9]+)$/.exec(base);
  if (m && Object.hasOwn(MAP, m[1])) return MAP[m[1]];
  if (/^\.\w+rc$/.test(base) || /^readme/.test(base)) return ["config", "dim"];
  return m ? ["text", "dim"] : ["text", "dim"];
}
export const fileIcon = (name) => { const [shape, tint] = iconFor(name); return `<span class="ico ft ft-${tint}">${ICONS[shape]}</span>`; };
export const folderIcon = (openState) => `<span class="ico ft ft-folder">${openState ? ICONS.folderOpen : ICONS.folder}</span>`;
