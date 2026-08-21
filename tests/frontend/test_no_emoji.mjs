// Glyphs stood in for an icon system for a long time. This is the guard that
// stops them creeping back once the sprite exists.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');
const FILES = ['index.html', 'app.js', 'workflow_view.js', 'workflow_library.js',
               'device_view.js', 'wave_stats.js', 'icons.js'];

// Pictographs, dingbats, arrows and box/braille glyphs used as icons, plus the
// circled-operator glyphs (⊘ ban, ⊗ close-alt) that fall outside those ranges.
// Typographic punctuation an interface legitimately needs — — – … · × ° — is
// NOT matched.
const GLYPH = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2800}-\u{28FF}\u{25A0}-\u{25FF}\u{FE0F}\u{2297}\u{2298}]/gu;

const offenders = [];
for (const f of FILES) {
  const p = path.join(FRONTEND, f);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(GLYPH)) {
      offenders.push(`${f}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 70)}`);
    }
  });
}

assert.deepEqual(offenders, [],
  'glyphs are being used where a sprite icon belongs:\n  ' + offenders.join('\n  '));

console.log(`no-emoji: OK (${FILES.length} files clean)`);
