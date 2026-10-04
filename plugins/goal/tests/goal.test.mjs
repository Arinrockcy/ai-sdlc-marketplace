// The goal plugin's own checks. Each part of the plugin adds its tests here as it is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PLUGIN, '../..');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('goal: the manifest names the plugin, its version, a one-line description and its author', () => {
  const manifest = json(path.join(PLUGIN, '.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'goal');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.trim() && !manifest.description.includes('\n'), 'description is one non-empty line');
  assert.deepEqual(manifest.author, { name: 'arin' });
});

test('goal: the changelog is titled for the plugin and its latest entry is the manifest version', () => {
  const manifest = json(path.join(PLUGIN, '.claude-plugin/plugin.json'));
  const changelog = fs.readFileSync(path.join(PLUGIN, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.startsWith('# Changelog: goal\n'), 'CHANGELOG.md starts with "# Changelog: goal"');
  const latest = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m)?.[1];
  assert.equal(latest, manifest.version);
});

test('goal: the marketplace lists the plugin from its folder under the development category', () => {
  const entries = json(path.join(REPO, '.claude-plugin/marketplace.json')).plugins.filter((p) => p.name === 'goal');
  assert.equal(entries.length, 1, 'one marketplace entry named goal');
  assert.equal(path.resolve(REPO, entries[0].source), PLUGIN);
  assert.equal(entries[0].category, 'development');
});
