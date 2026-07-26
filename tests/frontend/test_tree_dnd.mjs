// The file tree's selection and drop rules, against the real app.js.
//
// These are the decisions that must be right BEFORE a drop reaches the backend:
// which paths a drag carries, and whether a drop would put a folder inside
// itself. The backend refuses the latter too, but the cursor has to say no
// first — otherwise the user drags, releases, and only then learns it failed.
import assert from 'node:assert';
import { loadApp } from './_harness.mjs';

const { sandbox, evalInApp } = loadApp();

const TRASH_DIR = evalInApp('TRASH_DIR');
assert.equal(TRASH_DIR, '.omni-trash');

// Drive the module-level state the same way the row handlers do.
const setSelection = (paths) => evalInApp(`_treeSelection = new Set(${JSON.stringify(paths)})`);
const setOrder = (paths) => evalInApp(`_treeOrder = ${JSON.stringify(paths)}`);
const setAnchor = (p) => evalInApp(`_treeAnchor = ${JSON.stringify(p)}`);
const selection = () => [...evalInApp('_treeSelection')];
const setDrag = (paths) => evalInApp(`_treeDragPaths = ${JSON.stringify(paths)}`);

const { _dragPathsFor, _dropAllowed, _isInTrash, _selectTreeRow } = sandbox;

// --- what a drag carries -----------------------------------------------------
setSelection(['a.txt', 'b.txt', 'c.txt']);
assert.deepEqual(_dragPathsFor('b.txt').sort(), ['a.txt', 'b.txt', 'c.txt'],
  'dragging a row inside the selection carries the whole selection');
assert.deepEqual(_dragPathsFor('z.txt'), ['z.txt'],
  'dragging a row outside the selection carries only that row');

setSelection([]);
assert.deepEqual(_dragPathsFor('a.txt'), ['a.txt'],
  'with nothing selected, a drag carries just the dragged row');

// --- self-descendant guard ---------------------------------------------------
setDrag(['src']);
assert.equal(_dropAllowed('src'), false, 'a folder cannot be dropped on itself');
assert.equal(_dropAllowed('src/deep'), false, 'a folder cannot be dropped into its own child');
assert.equal(_dropAllowed('src/deep/deeper'), false, 'nor into a deeper descendant');
assert.equal(_dropAllowed('other'), true);
assert.equal(_dropAllowed(''), true, 'the workspace root is always a valid destination');

// A sibling whose name merely starts the same must NOT be treated as a child.
assert.equal(_dropAllowed('src-backup'), true,
  'prefix matching must respect the path separator');

setDrag(['a.txt', 'src']);
assert.equal(_dropAllowed('src/deep'), false,
  'a mixed drag is refused if ANY dragged path would contain the destination');

setDrag([]);
assert.equal(_dropAllowed('anything'), true);

// --- trash detection ---------------------------------------------------------
assert.equal(_isInTrash('.omni-trash'), true);
assert.equal(_isInTrash('.omni-trash/old.txt'), true);
assert.equal(_isInTrash('.omni-trash-notreally/x'), false,
  'a folder that merely starts with the trash name is not the trash');
assert.equal(_isInTrash('src/a.txt'), false);

// --- selection gestures ------------------------------------------------------
setOrder(['a', 'b', 'c', 'd', 'e']);
setSelection([]);
setAnchor(null);

_selectTreeRow('b', null);
assert.deepEqual(selection(), ['b'], 'a plain click selects exactly one row');

_selectTreeRow('d', { metaKey: true });
assert.deepEqual(selection().sort(), ['b', 'd'], 'cmd-click adds to the selection');

_selectTreeRow('b', { metaKey: true });
assert.deepEqual(selection(), ['d'], 'cmd-clicking a selected row removes it');

// Shift extends from the ANCHOR, and cmd-click moves the anchor to whatever it
// touched last — including a row it just deselected, matching Finder/VS Code.
assert.equal(evalInApp('_treeAnchor'), 'b',
  'cmd-click moves the anchor even when it deselects');

// Forward range.
_selectTreeRow('b', null);
_selectTreeRow('d', { shiftKey: true });
assert.deepEqual(selection().sort(), ['b', 'c', 'd'],
  'shift-click selects the inclusive range');

// Backward range — same result, anchor at the far end.
_selectTreeRow('d', null);
_selectTreeRow('b', { shiftKey: true });
assert.deepEqual(selection().sort(), ['b', 'c', 'd'],
  'a backward shift-range covers the same rows');

_selectTreeRow('a', null);
assert.deepEqual(selection(), ['a'], 'a plain click collapses the selection again');

// A shift-range whose endpoint is not in the visible order must not throw or
// produce a garbage range.
setAnchor('a');
_selectTreeRow('not-visible', { shiftKey: true });
assert.deepEqual(selection(), ['a'], 'an unknown endpoint leaves the selection intact');

console.log('tree dnd: OK');

// --- the tree actually renders ----------------------------------------------
// Exercises buildTreeNode/renderFileTree end to end. Beyond the assertions, this
// catches DOM APIs the renderer relies on that a stub would otherwise hide.
{
  const { sandbox: s2, doc } = loadApp();
  s2.window.__agent.onEvent({
    type: 'file_tree',
    tree: {
      name: 'ws', path: '', type: 'dir', children: [
        { name: 'src', path: 'src', type: 'dir', children: [
          { name: 'a.py', path: 'src/a.py', type: 'file', size: 12 },
        ] },
        { name: '.omni-trash', path: '.omni-trash', type: 'dir', children: [
          { name: 'gone.txt', path: '.omni-trash/gone.txt', type: 'file', size: 3 },
        ] },
        { name: 'top.txt', path: 'top.txt', type: 'file', size: 5 },
      ],
    },
  });

  const rows = doc.getElementById('fileTree').querySelectorAll('.tree-row');
  const paths = rows.map(r => r.path || r.dataset && r.dataset.path).filter(Boolean);
  assert.ok(paths.includes('src'), 'folders render');
  assert.ok(paths.includes('top.txt'), 'files render');
  assert.ok(paths.includes('.omni-trash'), 'the trash node renders');

  // The trash is pinned last regardless of alphabetical position.
  assert.equal(paths[paths.length - 1], '.omni-trash',
    'the trash must sort to the bottom of the tree');

  // The file count must exclude the trash — deleted files are not workspace files.
  assert.equal(doc.getElementById('treeFileCount').textContent, '2',
    'trashed files must not inflate the file count');

  const trashRow = rows.find(r => r.dataset.path === '.omni-trash');
  assert.ok(trashRow._classes.has('tree-trash'), 'the trash row is styled as such');
}

console.log('tree render: OK');
