import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(relativePath) {
  const pluginPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return JSON.parse(fs.readFileSync(path.join(pluginPath, relativePath), 'utf8'));
}

function verifyAfterTaskGates() {
  const stack = readJson('stack.json');

  assert.deepEqual(stack.hooks.after_task.run, [
    'npm run lint',
    'npm run test:coverage',
  ]);
}

function verifyQualityFloor() {
  const gate = readJson('stack.json').quality_gate;

  assert.equal(gate.linter, 'eslint');
  assert.equal(gate.test_runner, 'jest');
  assert.deepEqual(gate.coverage_thresholds, {
    branches: 80,
    functions: 80,
    lines: 80,
    statements: 80,
  });
}

function verifyRuntimeDefaults() {
  const runtime = readJson('stack.json').runtime;

  assert.deepEqual(runtime, { node: '>=24', module_type: 'module' });
}

test('nodejs stack runs lint and coverage as separate after-task gates', verifyAfterTaskGates);
test('nodejs stack declares the complete 80 percent quality floor', verifyQualityFloor);
test('nodejs stack requires Node.js 24+ and defaults to ES modules', verifyRuntimeDefaults);
