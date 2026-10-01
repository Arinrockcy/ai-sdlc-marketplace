import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OLDEST_COMPATIBLE_MANIFEST, compareVersions, rangeMinMajor, detectPackageManager, detectWorkspaces, resolveThresholds, enginesCheck,
} from '../scripts/nodejs.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PLUGIN, 'scripts/nodejs.mjs');
const FLOOR = { branches: 80, functions: 80, lines: 80, statements: 80 };

// Messages the script uses when it doesn't understand an invocation, as opposed to refusing it because of state.
const NOT_UNDERSTOOD = /Usage:|Unknown option|Invalid --(package-manager|module-type|format)/;
const PLACEHOLDERS = { path: 'coverage/lcov.info', name: 'x' };

// Writes an LCOV report with the given number of covered lines out of 10, so a gate command can be faked.
const REPORT_WRITER = `const fs = require('node:fs');
fs.mkdirSync('coverage', { recursive: true });
fs.writeFileSync('coverage/lcov.info', 'SF:a.js\\nLF:10\\nLH:' + process.argv[2] + '\\nBRF:2\\nBRH:2\\nFNF:1\\nFNH:1\\nend_of_record\\n');
`;

function project({ git = true, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-nodejs-'));
  fs.mkdirSync(path.join(dir, '.aisdlc/stacks'), { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function run(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { code: result.status, json, stderr: result.stderr };
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), 'utf8'));
}

function writeManifest(dir, change) {
  const manifest = readManifest(dir);
  change(manifest);
  fs.writeFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), JSON.stringify(manifest));
}

function registerLcov(dir, coveredLines) {
  assert.equal(run(dir, ['manifest', 'write', '--package-manager', 'npm', '--module-type', 'module', '--format', 'lcov', '--report', 'coverage/lcov.info']).code, 0);
  fs.writeFileSync(path.join(dir, 'write-report.cjs'), REPORT_WRITER);
  writeManifest(dir, function useFakeGate(manifest) {
    manifest.hooks.after_task.run = ['node -e "process.exit(0)"', `node write-report.cjs ${coveredLines}`];
  });
}

const RANGE_CASES = [
  ['>=24', 24], ['>= 24.1.0', 24], ['^24.0.0', 24], ['24.x', 24], ['~24.3', 24], ['24', 24], ['>24', 24],
  ['>=18', 18], ['>=18 <25', 18], ['^20 || ^22 || >=24', 20], ['18 - 22', 18], ['<26', 0], ['*', 0], ['', 0],
  ['>=24 <26', 24], ['lts/*', null], ['node', null],
];

function verifyRangeMinMajor() {
  for (const [range, expected] of RANGE_CASES) assert.equal(rangeMinMajor(range), expected, range);
  assert.deepEqual(enginesCheck(undefined), { range: null, min_major: null, ok: false, suggested: '>=24' });
  assert.equal(enginesCheck('>=24').ok, true);
  assert.equal(enginesCheck('^22').ok, false);
  assert.equal(enginesCheck('lts/*').ok, null);
}

const PACKAGE_MANAGER_CASES = [
  { lockfiles: [], pkg: {}, name: 'npm', source: 'default' },
  { lockfiles: ['package-lock.json'], pkg: {}, name: 'npm', source: 'lockfile' },
  { lockfiles: ['npm-shrinkwrap.json'], pkg: {}, name: 'npm', source: 'lockfile' },
  { lockfiles: ['pnpm-lock.yaml'], pkg: {}, name: 'pnpm', source: 'lockfile' },
  { lockfiles: ['yarn.lock'], pkg: {}, name: 'yarn', source: 'lockfile' },
  { lockfiles: ['bun.lockb'], pkg: {}, name: 'bun', source: 'lockfile' },
  { lockfiles: ['bun.lock'], pkg: {}, name: 'bun', source: 'lockfile' },
  { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], pkg: {}, name: 'npm', source: 'lockfile' },
  { lockfiles: ['package-lock.json', 'yarn.lock'], pkg: {}, name: null, source: 'lockfile', ambiguous: true },
  { lockfiles: ['package-lock.json', 'yarn.lock'], pkg: { packageManager: 'yarn@4.1.0' }, name: 'yarn', source: 'packageManager' },
  { lockfiles: ['package-lock.json'], pkg: { packageManager: 'pnpm@9.0.0' }, name: 'pnpm', source: 'packageManager', note: /lockfiles belong to npm/ },
  { lockfiles: [], pkg: { packageManager: 'deno@2' }, name: null, source: 'packageManager', note: /no supported manager/ },
];

function verifyPackageManager() {
  for (const testCase of PACKAGE_MANAGER_CASES) {
    const dir = project({ git: false });
    for (const file of testCase.lockfiles) fs.writeFileSync(path.join(dir, file), '');
    const detected = detectPackageManager(dir, testCase.pkg);
    const label = JSON.stringify(testCase);
    assert.equal(detected.name, testCase.name, label);
    assert.equal(detected.source, testCase.source, label);
    assert.equal(detected.ambiguous ?? false, testCase.ambiguous ?? false, label);
    if (testCase.note) assert.match(detected.notes.join('\n'), testCase.note, label);
  }
}

const PNPM_WORKSPACE = `# monorepo
packages:
  - 'packages/*'
  - "apps/*" # deployables

  - tools
catalog:
  react: ^19
`;

function verifyWorkspaces() {
  const dir = project({ git: false });
  assert.equal(detectWorkspaces(dir, {}), null);
  assert.deepEqual(detectWorkspaces(dir, { workspaces: ['packages/*'] }), { source: 'package.json', patterns: ['packages/*'] });
  assert.deepEqual(detectWorkspaces(dir, { workspaces: { packages: ['libs/*'], nohoist: ['**/x'] } }), { source: 'package.json', patterns: ['libs/*'] });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), PNPM_WORKSPACE);
  assert.deepEqual(detectWorkspaces(dir, {}), { source: 'pnpm-workspace.yaml', patterns: ['packages/*', 'apps/*', 'tools'] });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'catalog:\n  react: ^19\n');
  assert.equal(detectWorkspaces(dir, {}), null);
}

function verifyThresholds() {
  assert.deepEqual(resolveThresholds('json-summary', undefined, FLOOR), { thresholds: FLOOR, leftOut: [] });
  const lcov = resolveThresholds('lcov', undefined, FLOOR);
  assert.deepEqual(lcov.thresholds, { branches: 80, functions: 80, lines: 80 });
  assert.deepEqual(lcov.leftOut, [{ metric: 'statements', reason: 'lcov reports have no statements figure' }]);
  const stricter = resolveThresholds('json-summary', { lines: 90, branches: 85, functions: 80 }, FLOOR);
  assert.deepEqual(stricter.thresholds, { lines: 90, branches: 85, functions: 80 });
  assert.match(stricter.leftOut[0].reason, /doesn't enforce it/);
  assert.throws(resolveThresholds.bind(null, 'json-summary', { lines: 70 }, FLOOR), /below this stack's 80% floor/);
  assert.throws(resolveThresholds.bind(null, 'json-summary', { lines: 101 }, FLOOR), /above 100%/);
  assert.throws(resolveThresholds.bind(null, 'lcov', { statements: 80 }, FLOOR), /no statements figure/);
  assert.throws(resolveThresholds.bind(null, 'lcov', { mutations: 80 }, FLOOR), /Invalid threshold metric/);
}

function verifyManifestWrite() {
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    const dir = project({ git: false });
    const result = run(dir, ['manifest', 'write', '--package-manager', manager, '--module-type', 'commonjs', '--format', 'json-summary', '--report', 'coverage/coverage-summary.json', '--thresholds', 'lines=90,branches=80,functions=80,statements=85']);
    assert.equal(result.code, 0, result.stderr);
    const manifest = readManifest(dir);
    assert.deepEqual(manifest.hooks.after_task.run, [`${manager} run lint`, `${manager} run test:coverage`]);
    assert.equal(manifest.runtime.module_type, 'commonjs');
    assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(PLUGIN, 'stack.json'), 'utf8')).version);
    assert.deepEqual(manifest.quality_gate.coverage_report, { path: 'coverage/coverage-summary.json', format: 'json-summary' });
    assert.deepEqual(manifest.quality_gate.coverage_thresholds, { lines: 90, branches: 80, functions: 80, statements: 85 });
    assert.equal(manifest.quality_gate.test_runner, 'jest');
  }
  const dir = project({ git: false });
  assert.match(run(dir, ['manifest', 'write', '--package-manager', 'npm', '--module-type', 'module', '--format', 'lcov', '--report', '../lcov.info']).stderr, /inside the project/);
  assert.match(run(dir, ['manifest', 'write', '--package-manager', 'deno', '--module-type', 'module', '--format', 'lcov', '--report', 'x']).stderr, /Invalid --package-manager "deno"/);
  fs.rmSync(path.join(dir, '.aisdlc'), { recursive: true });
  assert.match(run(dir, ['manifest', 'write', '--package-manager', 'npm', '--module-type', 'module', '--format', 'lcov', '--report', 'x']).stderr, /Run \/aisdlc:init first/);
}

function verifyManifestCheck() {
  const dir = project({ git: false });
  const missing = run(dir, ['manifest', 'check']);
  assert.equal(missing.code, 1);
  assert.match(missing.json.problems[0], /doesn't exist/);

  registerLcov(dir, 9);
  const pluginVersion = readManifest(dir).version;
  assert.deepEqual([run(dir, ['manifest', 'check']).code, run(dir, ['manifest', 'check']).json.current], [0, true]);

  const versions = [
    ['0.3.0', 1, new RegExp(`needs one from ${OLDEST_COMPATIBLE_MANIFEST.replaceAll('.', '\\.')} or later`)],
    ['99.0.0', 1, /newer than this plugin/],
    ['not-a-version', 1, /no valid version/],
  ];
  if (compareVersions(OLDEST_COMPATIBLE_MANIFEST, pluginVersion) < 0) versions.push([OLDEST_COMPATIBLE_MANIFEST, 0, /still works/]);
  for (const [version, code, message] of versions) {
    writeManifest(dir, function setVersion(manifest) {
      manifest.version = version;
    });
    const result = run(dir, ['manifest', 'check']);
    assert.equal(result.code, code, version);
    assert.match([...result.json.problems, ...result.json.notes].join('\n'), message, version);
  }
  fs.writeFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), '{');
  assert.match(run(dir, ['manifest', 'check']).json.problems[0], /isn't valid JSON/);
}

function verifyOldestCompatibleManifest() {
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'stack.json'), 'utf8')).version;
  assert.ok(compareVersions(OLDEST_COMPATIBLE_MANIFEST, pluginVersion) <= 0, `${OLDEST_COMPATIBLE_MANIFEST} is newer than stack.json ${pluginVersion}`);
}

function verifyBaseline() {
  const dir = project({ files: { '.gitignore': 'coverage/\n' } });
  registerLcov(dir, 9);
  const passed = run(dir, ['baseline', '--clean']);
  assert.equal(passed.code, 0, JSON.stringify(passed.json ?? passed.stderr));
  assert.equal(passed.json.cleaned, 'coverage/');
  assert.deepEqual(passed.json.report, { path: 'coverage/lcov.info', format: 'lcov', exists: true, fresh: true, metrics: { lines: 90, branches: 100, functions: 100 }, ignored_by_git: true });

  writeManifest(dir, function writeLowCoverage(manifest) {
    manifest.hooks.after_task.run = ['node -e "process.exit(3)"', 'node write-report.cjs 5'];
  });
  const failed = run(dir, ['baseline']);
  assert.equal(failed.code, 1);
  assert.equal(failed.json.commands[0].exit_code, 3);
  assert.deepEqual(failed.json.problems, ['`node -e "process.exit(3)"` exited with 3.', 'lines coverage is 50%, below the 80% threshold.']);

  writeManifest(dir, function skipReport(manifest) {
    manifest.hooks.after_task.run = ['node -e "process.exit(0)"'];
  });
  assert.match(run(dir, ['baseline']).json.problems.join('\n'), /wasn't rewritten by this run/);
  assert.match(run(dir, ['baseline', '--clean']).json.problems.join('\n'), /wasn't written/);
}

function verifyBaselineCleanOnlyDeletesIgnoredFiles() {
  const tracked = project();
  registerLcov(tracked, 9);
  assert.match(run(tracked, ['baseline', '--clean']).stderr, /git doesn't ignore it/);
  assert.match(run(tracked, ['baseline']).json.problems.join('\n'), /git doesn't ignore coverage\/lcov\.info/);

  const outsideGit = project({ git: false });
  registerLcov(outsideGit, 9);
  assert.match(run(outsideGit, ['baseline', '--clean']).stderr, /isn't a git repository/);
}

function verifyInspect() {
  const dir = project({
    files: {
      'package.json': JSON.stringify({ type: 'module', engines: { node: '>=20' }, volta: { node: '22.1.0' }, packageManager: 'pnpm@9.0.0', scripts: { lint: 'eslint .' }, devDependencies: { eslint: '^9', jest: '^30' }, jest: {} }),
      '.nvmrc': 'v24.1.0\n',
      '.gitignore': 'coverage/\n',
      'old.js': 'module.exports = require("node:fs");\n',
      'new.js': 'export const x = 1;\n',
      'eslint.config.js': 'export default [];\n',
    },
  });
  fs.writeFileSync(path.join(dir, '.aisdlc/config.json'), JSON.stringify({ stack: 'auto', hooks: { after_task: null } }));
  const result = run(dir, ['inspect'], { AISDLC_HOOK_AFTER_TASK: 'none' });
  assert.equal(result.code, 0, result.stderr);
  const facts = result.json;
  assert.equal(facts.package_manager.name, 'pnpm');
  assert.equal(facts.workspaces, null);
  assert.equal(facts.yarn_pnp, false);
  assert.equal(facts.engines.ok, false);
  assert.deepEqual(facts.version_pins.map(pinOk), [['.nvmrc', true], ['package.json volta.node', false]]);
  assert.deepEqual([facts.module.type, facts.module.commonjs_files, facts.module.commonjs_examples, facts.module.esm_files], ['module', 1, ['old.js'], 2]);
  assert.deepEqual(facts.scripts, { lint: 'eslint .', 'test:coverage': null, test: null, sonar: null, 'security:audit': null });
  assert.deepEqual(facts.tools, { eslint: '^9', jest: '^30' });
  assert.deepEqual(facts.config_files, ['eslint.config.js', '.gitignore', 'package.json#jest']);
  assert.equal(facts.coverage_dir_ignored, true);
  assert.deepEqual(facts.workflow, { initialized: true, configured_stack: 'auto', installed_stack_manifests: [], config_after_task: { set: true, value: null }, env_after_task: { set: true, value: 'none' } });
  assert.equal(facts.manifest.installed, false);
}

function pinOk(pin) {
  return [pin.source, pin.ok];
}

// `$NODEJS …` spans in the plugin's skills, with placeholders filled, optional parts dropped and `a|b` expanded.
function skillInvocations() {
  const skills = path.join(PLUGIN, 'skills');
  const found = [];
  for (const skill of fs.readdirSync(skills)) {
    const file = path.join(skills, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\$NODEJS ([^`\n]+)/g)) found.push({ skill, text: match[1].trim() });
  }
  return found;
}

function expandInvocation(text) {
  const filled = text.replace(/\[[^\]]*\]/g, '').replace(/<([^>]+)>/g, fillPlaceholder);
  let variants = [[]];
  for (const token of filled.split(/\s+/).filter(Boolean)) {
    const options = token.includes('|') ? token.split('|') : [token];
    variants = variants.flatMap(appendEach.bind(null, options));
  }
  return variants;
}

function fillPlaceholder(match, name) {
  return PLACEHOLDERS[name] ?? 'x';
}

function appendEach(options, variant) {
  return options.map(appendTo.bind(null, variant));
}

function appendTo(variant, option) {
  return [...variant, option];
}

function verifySkillInvocations() {
  const found = skillInvocations();
  assert.ok(found.length >= 4, `expected the skills to call the script, found ${found.length}`);
  const dir = project({ files: { 'package.json': '{}' } });
  const broken = [];
  for (const invocation of found) {
    for (const args of expandInvocation(invocation.text)) {
      const result = run(dir, args, { npm_config_loglevel: 'silent' });
      if (result.code !== 0 && NOT_UNDERSTOOD.test(result.stderr)) broken.push(`${invocation.skill}: $NODEJS ${args.join(' ')}\n    ${result.stderr.trim().split('\n')[0]}`);
    }
  }
  assert.deepEqual(broken, [], `skills call the script in ways it doesn't understand:\n${broken.join('\n')}`);
}

test('nodejs script: semver ranges resolve to the lowest Node major they admit', verifyRangeMinMajor);
test('nodejs script: package manager comes from packageManager, then lockfiles, then npm', verifyPackageManager);
test('nodejs script: workspaces come from package.json or pnpm-workspace.yaml', verifyWorkspaces);
test('nodejs script: thresholds keep the floor and only metrics the report measures', verifyThresholds);
test('nodejs script: manifest write adapts commands, runtime and quality gate', verifyManifestWrite);
test('nodejs script: manifest check compares the installed version with the oldest compatible one', verifyManifestCheck);
test('nodejs script: the oldest compatible manifest is not newer than the plugin', verifyOldestCompatibleManifest);
test('nodejs script: baseline runs the gate and checks the report is fresh and above thresholds', verifyBaseline);
test('nodejs script: baseline --clean only deletes what git ignores', verifyBaselineCleanOnlyDeletesIgnoredFiles);
test('nodejs script: inspect reports runtime, module system, tooling and gate overrides', verifyInspect);
test('nodejs skills: every $NODEJS invocation is understood by the script', verifySkillInvocations);
