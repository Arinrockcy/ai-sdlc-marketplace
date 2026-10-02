import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const json = (file) => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));

test('release: every plugin version matches the marketplace and heads its changelog', () => {
  for (const entry of json('.claude-plugin/marketplace.json').plugins) {
    const manifest = json(path.join(entry.source, '.claude-plugin/plugin.json'));
    assert.equal(manifest.version, entry.version, `${entry.name}: plugin.json and marketplace.json versions differ`);
    const changelog = fs.readFileSync(path.join(REPO, entry.source, 'CHANGELOG.md'), 'utf8');
    const latest = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m)?.[1];
    assert.equal(latest, entry.version, `${entry.name}: CHANGELOG.md's latest entry is not ${entry.version}`);
  }
});

// VS Code reads a marketplace only from .github/plugin/; Claude Code and Copilot CLI read .claude-plugin/.
test('release: the VS Code marketplace is a copy of the Claude Code one', () => {
  assert.deepEqual(json('.github/plugin/marketplace.json'), json('.claude-plugin/marketplace.json'), 'copy .claude-plugin/marketplace.json to .github/plugin/marketplace.json');
});
