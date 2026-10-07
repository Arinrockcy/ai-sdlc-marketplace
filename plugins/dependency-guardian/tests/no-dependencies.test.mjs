import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.name === 'node_modules') return [full];
    return e.isDirectory() ? files(full) : [full];
  });
}

// Matches static, bare and dynamic imports, and require calls, each with a string specifier.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

test('no third-party code: the plugin has no manifest dependencies and no node_modules', () => {
  const all = files(PLUGIN);
  assert.deepEqual(all.filter((f) => f.split(path.sep).includes('node_modules')), [], 'node_modules must not exist');
  for (const f of all.filter((f) => path.basename(f) === 'package.json')) {
    const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
      assert.equal(pkg[key], undefined, `${f}: ${key} is not allowed`);
    }
  }
});

test('no third-party code: scripts and tests import only node: built-ins or relative files', () => {
  for (const f of files(PLUGIN).filter((f) => /\.(mjs|js|cjs)$/.test(f))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      const ok = spec.startsWith('./') || spec.startsWith('../') || (spec.startsWith('node:') && isBuiltin(spec));
      assert.ok(ok, `${path.relative(PLUGIN, f)} imports "${spec}": only node: built-ins and relative files are allowed`);
    }
  }
});
