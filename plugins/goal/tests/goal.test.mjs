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

// Every file the plugin ships, as paths relative to the plugin. Its tests are left out: they name the terms below.
function shippedFiles(dir = PLUGIN) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (!entry.isDirectory()) return [path.relative(PLUGIN, file)];
    return file === path.join(PLUGIN, 'tests') ? [] : shippedFiles(file);
  });
}

// Terms that belong to one project's stack, layout or tooling. The plugin is generic: it refers to the project's own
// instructions and the commands recorded in the ledger instead.
const PROJECT_TERMS = [/FLEX/, /vitest/i, /eslint/i, /validate:components/i, /PROJECT_INSTRUCTIONS/i, /\.agents\//i, /(^|[^\w.])\.ai\//im, /agent-contract/i, /Codex/i, /\/usr\/local\/bin/i];

const projectTerms = (text) => PROJECT_TERMS.filter((term) => term.test(text)).map(String);

test('goal: the project-term search flags a path under a project folder, not a URL on a similar domain', () => {
  assert.deepEqual(projectTerms('See https://example.ai/docs and https://www.example.ai/.'), []);
  for (const text of ['Read `.ai/index.txt` first.', '.ai/index.txt', 'see (.ai/index.txt)', 'line one\n.ai/index.txt']) {
    assert.equal(projectTerms(text).length, 1, text);
  }
  assert.deepEqual(projectTerms('Uses FLEX and Vitest.'), ['/FLEX/', '/vitest/i']);
  assert.deepEqual(projectTerms('A flexible plan.'), []);
});

test('goal: nothing the plugin ships names one project\'s stack, layout or tooling', () => {
  const files = shippedFiles();
  assert.ok(files.includes('skills/goal-workflow/SKILL.md'), 'the search covers the skill');
  const found = files.flatMap((file) => {
    const text = fs.readFileSync(path.join(PLUGIN, file), 'utf8');
    return projectTerms(text).map((term) => `${file}: ${term}`);
  });
  assert.deepEqual(found, []);
});

test('goal-workflow: the ledger template is next to the skill, where the skill says it is', () => {
  const folder = path.join(PLUGIN, 'skills/goal-workflow');
  const skill = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('`ledger-template.md` next to this SKILL.md'), 'the skill names ledger-template.md next to SKILL.md');
  assert.ok(skill.includes('`.agent-goals/<slug>.md`'), 'the skill says where a ledger goes');
  const template = fs.readFileSync(path.join(folder, 'ledger-template.md'), 'utf8');
  const parts = ['- **Branch:**', '- **Commits:**', '- **Fix loop:**', '## Project commands', '## Test baseline', '- **Source document:**', '- **Task detail:**', '## Decision log'];
  assert.deepEqual(parts.filter((part) => !template.includes(part)), [], 'the template has every part the skill fills in');
});
