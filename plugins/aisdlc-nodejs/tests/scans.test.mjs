import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PLUGIN, 'scripts/nodejs.mjs');
const MANIFEST = '.aisdlc/stacks/nodejs.json';
const REGISTER = ['manifest', 'write', '--module-type', 'module', '--format', 'lcov', '--report', 'coverage/lcov.info'];
const REPORT_WRITER = `require('node:fs').mkdirSync('coverage', { recursive: true });
require('node:fs').writeFileSync('coverage/lcov.info', 'SF:src.js\\nLF:1\\nLH:1\\nBRF:1\\nBRH:1\\nFNF:1\\nFNH:1\\nend_of_record\\n');
`;

function run(root, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
  return { code: result.status, json: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
}

function writeManifest(root, manifest) {
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest));
}

function project(t, scripts = { sonar: 'node -e "process.exit(0)"', 'security:audit': 'node -e "process.exit(0)"' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-scans-'));
  function cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  t.after(cleanup);
  fs.mkdirSync(path.join(root, '.aisdlc/stacks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
  assert.equal(run(root, [...REGISTER, '--package-manager', 'npm']).code, 0);
  return root;
}

function verifyScanSettings(t) {
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    const root = project(t);
    const original = readManifest(root);
    original.hooks.after_task.run.push('node custom-check.mjs');
    writeManifest(root, original);
    const args = ['manifest', 'scans', '--package-manager', manager, '--sonar', 'on', '--vulnerabilities', 'on'];
    const enabled = run(root, args);
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.deepEqual(enabled.json.manifest.hooks.after_task.run, [...original.hooks.after_task.run, `${manager} run security:audit`, `${manager} run sonar`]);
    assert.deepEqual(enabled.json.manifest.quality_gate.scans, { vulnerabilities: true, sonar: true });
    assert.equal(run(root, args).code, 0);
    assert.deepEqual(readManifest(root), enabled.json.manifest, 'enabling twice is idempotent');
    const disabled = run(root, ['manifest', 'scans', '--package-manager', manager, '--sonar', 'off']);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.deepEqual(disabled.json.manifest.hooks.after_task.run, [...original.hooks.after_task.run, `${manager} run security:audit`]);
    assert.equal(disabled.json.manifest.quality_gate.scans.vulnerabilities, true);
    assert.deepEqual(disabled.json.manifest.quality_gate.coverage_thresholds, original.quality_gate.coverage_thresholds);
  }
}

function verifyRegistrationRetainsScans(t) {
  const root = project(t);
  assert.equal(run(root, ['manifest', 'scans', '--package-manager', 'npm', '--sonar', 'on', '--vulnerabilities', 'on']).code, 0);
  const registered = run(root, [...REGISTER, '--package-manager', 'pnpm']);
  assert.equal(registered.code, 0, registered.stderr);
  assert.deepEqual(registered.json.manifest.hooks.after_task.run, ['pnpm run lint', 'pnpm run test:coverage', 'pnpm run security:audit', 'pnpm run sonar']);
  assert.deepEqual(registered.json.manifest.quality_gate.scans, { vulnerabilities: true, sonar: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const before = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
  assert.equal(run(root, [...REGISTER, '--package-manager', 'npm']).code, 1);
  assert.equal(fs.readFileSync(path.join(root, MANIFEST), 'utf8'), before, 'missing scripts cannot silently remove an enabled gate');
}

function verifyRefusals(t) {
  const root = project(t, {});
  const before = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
  for (const options of [[], ['--sonar', 'maybe'], ['--sonar', 'on'], ['--vulnerabilities', 'on']]) {
    const result = run(root, ['manifest', 'scans', '--package-manager', 'npm', ...options]);
    assert.equal(result.code, 1, JSON.stringify(options));
    assert.equal(fs.readFileSync(path.join(root, MANIFEST), 'utf8'), before);
  }
  assert.equal(run(root, ['manifest', 'scans', '--package-manager', 'npm;echo unsafe', '--sonar', 'off']).code, 1);
  assert.equal(run(root, [...REGISTER, '--package-manager', 'npm', '--sonar', 'on']).code, 1);
  // A disabled hook cannot acquire scan commands that the core would still ignore.
  const manifest = readManifest(root);
  manifest.hooks.after_task = null;
  writeManifest(root, manifest);
  assert.equal(run(root, ['manifest', 'scans', '--package-manager', 'npm', '--sonar', 'off']).code, 1);
  manifest.hooks.after_task = { use: 'default', run: ['npm run lint'] };
  writeManifest(root, manifest);
  assert.equal(run(root, ['manifest', 'scans', '--package-manager', 'npm', '--sonar', 'off']).code, 1);
}

function verifyExistingScanIsPreserved(t) {
  const root = project(t);
  const manifest = readManifest(root);
  manifest.hooks.after_task.run.push('npm run sonar');
  writeManifest(root, manifest);
  const updated = run(root, ['manifest', 'scans', '--package-manager', 'npm', '--vulnerabilities', 'on']);
  assert.equal(updated.code, 0, updated.stderr);
  assert.deepEqual(updated.json.manifest.hooks.after_task.run, [...manifest.hooks.after_task.run, 'npm run security:audit']);
}

function verifyScanFailurePropagation(t) {
  for (const failing of ['sonar', 'security:audit']) {
    const scripts = { lint: 'node -e "process.exit(0)"', 'test:coverage': 'node coverage.cjs', sonar: 'node -e "process.exit(0)"', 'security:audit': 'node -e "process.exit(0)"' };
    scripts[failing] = 'node -e "process.exit(7)"';
    const root = project(t, scripts);
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitignore'), 'coverage/\n');
    fs.writeFileSync(path.join(root, 'coverage.cjs'), REPORT_WRITER);
    assert.equal(run(root, ['manifest', 'scans', '--package-manager', 'npm', '--sonar', 'on', '--vulnerabilities', 'on']).code, 0);
    const failed = run(root, ['baseline', '--clean']);
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.json.ok, false);
    assert.equal(failed.json.report.fresh, true);
    assert.equal(failed.json.report.metrics.lines, 100);
    assert.equal(failed.json.commands.length, 4);
    assert.match(failed.json.problems.join('\n'), new RegExp(`npm run ${failing}`));
    scripts[failing] = 'node -e "process.exit(0)"';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
    const passed = run(root, ['baseline', '--clean']);
    assert.equal(passed.code, 0, JSON.stringify(passed.json ?? passed.stderr));
    assert.equal(passed.json.ok, true);
  }
}

function verifyScanInspection(t) {
  const root = project(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.devDependencies = { '@sonar/scan': '4.0.0' };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'sonar-project.properties'), 'sonar.projectKey=example\n');
  const result = run(root, ['inspect']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.tools['@sonar/scan'], '4.0.0');
  assert.ok(result.json.config_files.includes('sonar-project.properties'));
  assert.equal(result.json.scripts.sonar, pkg.scripts.sonar);
  assert.equal(result.json.scripts['security:audit'], pkg.scripts['security:audit']);
}

test('scans: explicit gates preserve other hooks, are ordered, and are idempotent for all managers', verifyScanSettings);
test('scans: re-registration preserves enabled gates and updates their package manager', verifyRegistrationRetainsScans);
test('scans: invalid choices, missing scripts, and disabled hooks leave the manifest unchanged', verifyRefusals);
test('scans: enabling one scan preserves an existing independently configured scan command', verifyExistingScanIsPreserved);
test('scans: baseline fails on each scanner failure even when coverage passes', verifyScanFailurePropagation);
test('scans: inspect reports scanner tools, scripts, and configuration', verifyScanInspection);
