#!/usr/bin/env node
// Builds ui/ into dist/ui: one output for the desktop server, the hub and the iPhone bundle.
//
//   npm run build            build, after any change in ui/
//   npm run build -- --check is dist/ui what ui/ makes? Exit 1 and why, if not
//   npm run build -- --list  every file a deployment must carry, one per line
//   npm run build -- --phone the files the iPhone app bundles (ios/), by name in dist/ui, one per line
//
// --check and --list need nothing installed. Only building needs esbuild (a pinned dev dependency: npm install once).
//
// What is in it follows from the pages: the scripts, styles and icons index.html and web.html name, what those scripts import
// (a dynamic import makes a lazy chunk), and the workers they start. So a new file in ui/ needs no list here or anywhere.
//
// dist/ui is committed: the desktop launcher runs from a plain checkout with no install step, and the hub is deployed from one.
// The server checks it against the sources at each page load (server/ui-build.mjs) and a test fails if a commit leaves it behind,
// so a forgotten build costs speed, never correctness. After a merge, run the build rather than resolving build.json by hand.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { checkBuild, hashSource } from "../server/ui-build.mjs";
import { readBuild } from "../hub/static.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI = join(ROOT, "ui");
const DIST = join(ROOT, "dist", "ui");
const SELF = "scripts/build-ui.mjs";
/** The pages. phone.html joins these when the iPhone app's page lands in ui/. */
const PAGES = ["index.html", "web.html", "phone.html"].filter((page) => existsSync(join(UI, page)));
const TARGET = ["es2022", "chrome111", "safari16.4", "firefox128"];
const WORKER = /new URL\("\.\/([\w.-]+\.js)", import\.meta\.url\)/g;
const ASSET = /\b(href|src)="(\/?)([\w.-]+\.(?:css|js|svg|png|webmanifest))"/g;
/** The icons a web manifest names: "src": "icon-192.png". They are built (hashed) like any image, and the manifest names the built ones. */
const MANIFEST_ICON = /("src"\s*:\s*")([\w.-]+\.png)(")/g;

const posix = (p) => p.replace(/\\/g, "/");
const lf = (text) => text.replace(/\r\n/g, "\n");
const sha256 = (bytes, encoding = "hex") => createHash("sha256").update(bytes).digest(encoding);
const fail = (message) => { console.error(message); process.exit(1); };

/** Reads ui/*.js for esbuild: with line endings settled, so the same source builds the same on any checkout, and worker names swapped for the built ones. */
function sourcePlugin({ workerNames, foundWorkers }) {
  return {
    name: "omni-ui-source",
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, (args) => {
        const contents = lf(readFileSync(args.path, "utf8")).replace(WORKER, (whole, name) => {
          // Any file this form names is a worker's script: nothing else in ui/ takes a URL from a sibling.
          foundWorkers?.add(name);
          if (!workerNames) return whole;
          const built = workerNames.get(name);
          if (!built) throw new Error(`${args.path} starts ${name}, which was not built`);
          return `new URL("./${built}", import.meta.url)`;
        });
        return { contents, loader: "js" };
      });
    },
  };
}

async function build() {
  let esbuild;
  try { esbuild = await import("esbuild"); }
  catch { fail("esbuild is not installed: run npm install. (A checkout with no build runs from source: the server says so.)"); }

  const common = { absWorkingDir: ROOT, bundle: true, minify: true, target: TARGET, charset: "utf8", legalComments: "none", logLevel: "warning", metafile: true, write: false, outdir: DIST };
  const outputs = new Map();   // built name → bytes
  const inputs = new Set([SELF, "ui/sw.js", ...PAGES.map((page) => `ui/${page}`)]);
  const imports = {};          // built name → the built names it imports at load, for preloading and the size test
  const nameOf = (path) => basename(path);
  const take = (result) => {
    for (const file of result.outputFiles) outputs.set(nameOf(file.path), Buffer.from(file.contents));
    for (const name of Object.keys(result.metafile.inputs)) inputs.add(posix(name));
  };

  // What each page names.
  const pages = PAGES.map((page) => {
    const html = lf(readFileSync(join(UI, page), "utf8"));
    const named = [...html.matchAll(ASSET)].map((m) => m[3]);
    for (const name of named) if (!existsSync(join(UI, name))) fail(`${page} names ${name}, which is not in ui/`);
    return { page, html, named };
  });
  const scripts = [...new Set(pages.flatMap((p) => p.named.filter((n) => n.endsWith(".js"))))];
  const styles = [...new Set(pages.flatMap((p) => p.named.filter((n) => n.endsWith(".css"))))];
  const manifests = [...new Set(pages.flatMap((p) => p.named.filter((n) => n.endsWith(".webmanifest"))))];
  const manifestIcons = manifests.flatMap((n) => [...lf(readFileSync(join(UI, n), "utf8")).matchAll(MANIFEST_ICON)].map((m) => m[2]));
  for (const name of manifestIcons) if (!existsSync(join(UI, name))) fail(`a manifest names ${name}, which is not in ui/`);
  const images = [...new Set([...pages.flatMap((p) => p.named.filter((n) => /\.(svg|png)$/.test(n))), ...manifestIcons])];

  // A first look through the imports, for the workers the code starts. Each is built whole, on its own: it shares nothing with a page.
  const found = new Set();
  await esbuild.build({ ...common, minify: false, format: "esm", splitting: true, entryPoints: scripts.map((n) => join(UI, n)), plugins: [sourcePlugin({ foundWorkers: found })] });
  const workerNames = new Map();
  if (found.size) {
    const nested = new Set();
    const result = await esbuild.build({ ...common, format: "esm", entryNames: "[name]-[hash]", entryPoints: [...found].map((n) => join(UI, n)), plugins: [sourcePlugin({ foundWorkers: nested })] });
    if (nested.size) fail(`a worker starting a worker is not handled: ${[...nested].join(", ")}`);
    take(result);
    for (const [path, meta] of Object.entries(result.metafile.outputs)) if (meta.entryPoint) workerNames.set(basename(meta.entryPoint), nameOf(path));
  }

  // The pages' code, with what they share in chunks and every dynamic import a chunk of its own.
  const code = await esbuild.build({ ...common, format: "esm", splitting: true, entryNames: "[name]-[hash]", chunkNames: "chunk-[hash]", entryPoints: scripts.map((n) => join(UI, n)), plugins: [sourcePlugin({ workerNames })] });
  take(code);
  const builtName = new Map();
  for (const [path, meta] of Object.entries(code.metafile.outputs)) {
    if (!path.endsWith(".js")) continue;
    const name = nameOf(path);
    imports[name] = meta.imports.filter((i) => i.kind === "import-statement").map((i) => nameOf(i.path));
    if (meta.entryPoint) builtName.set(basename(meta.entryPoint), name);
  }

  if (styles.length) {
    const css = await esbuild.build({ ...common, entryNames: "[name]-[hash]", entryPoints: styles.map((n) => join(UI, n)) });
    take(css);
    for (const [path, meta] of Object.entries(css.metafile.outputs)) if (meta.entryPoint) builtName.set(basename(meta.entryPoint), nameOf(path));
  }

  for (const name of images) {
    const bytes = readFileSync(join(UI, name));
    const text = name.endsWith(".svg") ? Buffer.from(lf(bytes.toString("utf8"))) : bytes;
    const dot = name.lastIndexOf(".");
    const hashed = `${name.slice(0, dot)}-${sha256(text).slice(0, 8)}${name.slice(dot)}`;
    outputs.set(hashed, text);
    builtName.set(name, hashed);
    inputs.add(`ui/${name}`);
  }

  // The web manifests: after the images, since they name the built icons.
  for (const name of manifests) {
    const text = Buffer.from(lf(readFileSync(join(UI, name), "utf8")).replace(MANIFEST_ICON, (_, a, icon, b) => `${a}${builtName.get(icon)}${b}`));
    const dot = name.lastIndexOf(".");
    const hashed = `${name.slice(0, dot)}-${sha256(text).slice(0, 8)}${name.slice(dot)}`;
    outputs.set(hashed, text);
    builtName.set(name, hashed);
    inputs.add(`ui/${name}`);
  }

  // The pages, last: their content names everything else.
  const staticImports = (name, seen = new Set()) => { for (const dep of imports[name] ?? []) if (!seen.has(dep)) { seen.add(dep); staticImports(dep, seen); } return seen; };
  for (const { page, html } of pages) {
    const preload = new Set();
    const body = html.replace(ASSET, (_, attribute, slash, name) => {
      if (name.endsWith(".js")) for (const dep of staticImports(builtName.get(name))) preload.add(dep);
      return `${attribute}="${slash}${builtName.get(name)}"`;
    });
    const slash = /(?:href|src)="\//.test(html) ? "/" : "";
    const links = [...preload].map((dep) => `<link rel="modulepreload" href="${slash}${dep}" />`).join("\n");
    outputs.set(page, Buffer.from(body.replace("</head>", `${links ? `${links}\n` : ""}</head>`)));
  }

  // The service worker, last of all: its list holds a hash of each of the others, and so changes with any of them.
  const integrity = (bytes) => `sha256-${sha256(bytes, "base64")}`;
  const listed = [...outputs.keys()].sort();
  const version = sha256(listed.map((name) => `${name}:${sha256(outputs.get(name))}`).join("\n")).slice(0, 16);
  const precache = listed.filter((name) => name !== "phone.html").map((name) => ({ url: name === "web.html" ? "/" : `/${name}`, integrity: integrity(outputs.get(name)) }));
  const template = lf(readFileSync(join(UI, "sw.js"), "utf8"));
  if (!template.includes('"__VERSION__"') || !template.includes('"__PRECACHE__"')) fail("ui/sw.js has lost the strings the build fills in");
  const worker = await esbuild.transform(template.replace('"__VERSION__"', JSON.stringify(version)).replace('"__PRECACHE__"', JSON.stringify(precache)), { minify: true, target: TARGET, charset: "utf8", legalComments: "none", loader: "js" });
  outputs.set("sw.js", Buffer.from(worker.code));

  // Written whole, or not at all.
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  const files = {};
  const totals = { body: 0, br: 0 };
  for (const name of [...outputs.keys()].sort()) {
    const bytes = outputs.get(name);
    writeFileSync(join(DIST, name), bytes);
    const file = { sha256: sha256(bytes), integrity: integrity(bytes), immutable: !["index.html", "web.html", "phone.html", "sw.js"].includes(name) };
    totals.body += bytes.length;
    if (/\.(html|js|css|svg|webmanifest)$/.test(name)) {
      const br = brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
      const gz = gzipSync(bytes, { level: 9 });
      if (br.length < bytes.length) { writeFileSync(join(DIST, `${name}.br`), br); file.br = true; }
      if (gz.length < bytes.length) { writeFileSync(join(DIST, `${name}.gz`), gz); file.gz = true; }
      totals.br += file.br ? br.length : bytes.length;
    } else totals.br += bytes.length;
    files[name] = file;
  }
  const inputHashes = {};
  for (const name of [...inputs].sort()) inputHashes[name] = hashSource(readFileSync(join(ROOT, name)), name);
  writeFileSync(join(DIST, "build.json"), `${JSON.stringify({ format: 1, version, esbuild: esbuild.version, inputs: inputHashes, imports, files }, null, 1)}\n`);
  console.log(`dist/ui: ${Object.keys(files).length} files, ${Math.round(totals.body / 1024)} KB, ${Math.round(totals.br / 1024)} KB as brotli, from ${Object.keys(inputHashes).length} sources`);
}

/** Every file a deployment carries: the list, each file on it, and their compressed forms. */
function list() {
  const dist = pathToFileURL(`${DIST}/`);
  const { files } = readBuild(dist);
  const out = ["dist/ui/build.json"];
  for (const [name, file] of Object.entries(files)) {
    out.push(`dist/ui/${name}`);
    if (file.br) out.push(`dist/ui/${name}.br`);
    if (file.gz) out.push(`dist/ui/${name}.gz`);
  }
  return out;
}

/**
 * What the iPhone app carries, by plain name in dist/ui: the build less what only a server uses. The service worker and the web page
 * are the hub's; the compressed copies are for HTTP. The app serves the rest itself (ios/OmniAgent/BundleScheme.swift).
 */
function phoneBundle(files) {
  const names = Object.keys(files).filter((name) => !["sw.js", "web.html"].includes(name)).sort();
  if (!names.includes("phone.html")) fail("dist/ui has no phone.html: run npm run build");
  return names;
}

const args = new Set(process.argv.slice(2));
if (args.has("--phone")) {
  console.log(phoneBundle(readBuild(pathToFileURL(`${DIST}/`)).files).join("\n"));
} else if (args.has("--check")) {
  const problem = checkBuild(ROOT);
  if (problem) fail(`dist/ui is not what ui/ makes: ${problem}. Run: npm run build`);
  console.log(`dist/ui is current (${readBuild(pathToFileURL(`${DIST}/`)).version})`);
} else if (args.has("--list")) {
  console.log(list().join("\n"));
} else {
  await build();
  const problem = checkBuild(ROOT);
  if (problem) fail(`the build does not check out: ${problem}`);
}
