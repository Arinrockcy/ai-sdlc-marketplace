import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_POINTS } from '../../aisdlc/scripts/aisdlc.mjs';

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

function verifyCoverageReport() {
  const report = readJson('stack.json').quality_gate.coverage_report;

  assert.deepEqual(report, { path: 'coverage/coverage-summary.json', format: 'json-summary' });
}

function verifyRuntimeDefaults() {
  const runtime = readJson('stack.json').runtime;

  assert.deepEqual(runtime, { node: '>=24', module_type: 'module' });
}

function verifyHookPoints() {
  const points = Object.keys(readJson('stack.json').hooks);
  const unknown = points.filter(isUnknownHookPoint);

  assert.deepEqual(unknown, [], `stack.json sets hook points the core doesn't have: ${unknown.join(', ')}`);
  assert.deepEqual(points, ['after_task'], 'stack.json should set only the hook points it changes');
}

function isUnknownHookPoint(point) {
  return !HOOK_POINTS.includes(point);
}

function verifyStandardsSkill() {
  const stack = readJson('stack.json');
  const plugin = readJson('.claude-plugin/plugin.json');
  const [pluginName, skillName] = stack.standards_skill.split(':');
  const pluginPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const skill = fs.readFileSync(path.join(pluginPath, 'skills', skillName, 'SKILL.md'), 'utf8');

  assert.equal(pluginName, plugin.name);
  assert.match(skill, new RegExp(`^---\\nname: ${skillName}\\n`));
}

test('nodejs stack runs lint and coverage as separate after-task gates', verifyAfterTaskGates);
test('nodejs stack sets only known hook points, and only the one it changes', verifyHookPoints);
test('nodejs stack names a standards skill this plugin has', verifyStandardsSkill);
test('nodejs stack declares the complete 80 percent quality floor', verifyQualityFloor);
test('nodejs stack declares the json-summary report that after_goal checks', verifyCoverageReport);
test('nodejs stack requires Node.js 24+ and defaults to ES modules', verifyRuntimeDefaults);
