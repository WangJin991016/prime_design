import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = [
  ['P', 'P', '6'].join(''),
  ['Primer', 'Premier'].join(' '),
  ['primer', 'Premier'].join(''),
  ['J', 'A', 'B'].join(''),
  String.fromCharCode(74, 97, 98, 80, 114, 111, 98, 101),
  ['Java', 'Access', 'Bridge'].join(' '),
];
const roots = ['src', 'scripts', 'config', 'docs', 'test'];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

test('tracked application surfaces describe only the Primer3 workflow', async () => {
  const files = [path.join(root, 'README.md'), path.join(root, '.gitignore')];
  for (const name of roots) files.push(...await filesBelow(path.join(root, name)));
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const content = await readFile(file, 'utf8');
    for (const term of forbidden) {
      assert.equal(content.toLowerCase().includes(term.toLowerCase()), false, `${path.relative(root, file)} contains a retired integration term`);
    }
  }
});
