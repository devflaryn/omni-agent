// The app is offline: a font that is referenced but not bundled silently falls
// back, and the UI then renders differently on every machine — green tests, wrong
// typography. This asserts the whole chain: file, licence, @font-face, fallback.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

const font = path.join(FRONTEND, 'fonts', 'ibm-plex-sans-var.woff2');
assert.ok(fs.existsSync(font), 'the variable font is not bundled at frontend/fonts/');
const bytes = fs.statSync(font).size;
assert.ok(bytes > 10000, `font file is only ${bytes} bytes — truncated download?`);
assert.ok(bytes < 400000, `font file is ${bytes} bytes — expected a latin subset`);

assert.ok(fs.existsSync(path.join(FRONTEND, 'fonts', 'LICENSE-OFL.txt')),
  'the SIL OFL licence must ship beside the font');

assert.ok(/@font-face\s*{[^}]*IBM Plex Sans Var[^}]*}/s.test(html),
  'no @font-face declaring "IBM Plex Sans Var"');
assert.ok(/url\(["']?fonts\/ibm-plex-sans-var\.woff2/.test(html),
  '@font-face does not point at the bundled file by relative path');
assert.ok(/font-display:\s*swap/.test(html),
  'font-display: swap keeps text visible while the face loads');

// A bundled font can fail to load from file:// inside a webview. The fallback is
// what keeps the app usable when it does.
const uiVar = html.match(/--font-ui:\s*([^;]+);/);
assert.ok(uiVar, 'no --font-ui token');
assert.ok(/IBM Plex Sans Var/.test(uiVar[1]), '--font-ui must name the bundled face first');
assert.ok(/(system-ui|ui-sans-serif|Segoe UI)/.test(uiVar[1]),
  '--font-ui must carry a system fallback stack');

console.log('font: OK (bundled, licensed, declared, with fallback)');
