#!/usr/bin/env node
// nodejs.mjs — deterministic helper for the aisdlc-nodejs skills: project inspection, the stack manifest and the
// baseline gate run. Zero dependencies. Run it from the project root. Output is JSON on stdout; a usage error or a
// refusal exits 1 with a message on stderr, and a failed check exits 1 with its problems in the JSON.
// It must run on old Node versions too, so `inspect` can report that Node.js is too old instead of crashing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');
const MANIFEST_FILE = '.aisdlc/stacks/nodejs.json';
// Templates `template <name>` copies into the project root.
const TEMPLATES = { eslint: 'eslint.aisdlc.mjs' };
// SHA-256 of each earlier release of a template, so an unedited copy from an older release counts as outdated
// rather than modified. Add the old hash whenever a template changes.
export const TEMPLATE_HISTORY = {
  eslint: {
    '5589d066fa55ae77feb5f68a6cac1c708274fe4b25cb1a29c751ca8835f133a7': '0.6.0',
    '335c7159b7855569b622f5e4d56d8b75547abaae63047894c22845671b2c5e2a': '0.7.0',
  },
};

// Raise this with every release that changes what a manifest must contain. Older manifests must be re-registered;
// newer ones within the same plugin version line stay valid, so a non-breaking release asks nothing of projects.
export const OLDEST_COMPATIBLE_MANIFEST = '0.4.0';

export const MIN_NODE_MAJOR = 24;
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const MODULE_TYPES = ['module', 'commonjs'];
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];
const VERSION_PIN_FILES = ['.nvmrc', '.node-version'];
const TOOL_PACKAGES = ['eslint', 'jest', '@jest/globals', 'vitest', '@vitest/coverage-v8', '@vitest/coverage-istanbul', 'c8', 'nyc', 'typescript', '@sonar/scan', 'sonarqube-scanner'];
const CONFIG_FILES = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.ts', 'jest.config.json',
  'vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts', 'vitest.config.mts',
  '.c8rc', '.c8rc.json', '.nycrc', '.nycrc.json', '.nycrc.yml',
  'tsconfig.json', 'jsconfig.json', '.gitignore', 'sonar-project.properties',
];
const PACKAGE_JSON_CONFIG_KEYS = ['jest', 'eslintConfig', 'c8', 'nyc'];
const GATE_SCRIPTS = ['lint', 'test:coverage', 'test', 'sonar', 'security:audit'];
const SCAN_SCRIPTS = { vulnerabilities: 'security:audit', sonar: 'sonar' };

// The module-system scan reads at most this many `.js` files, each up to this size.
const SCAN_LIMITS = { files: 2000, bytes: 512 * 1024, examples: 5 };
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.aisdlc', 'coverage', 'dist', 'build', 'graphify-out']);
const COMMONJS_SYNTAX = /\brequire\s*\(\s*['"`]|\bmodule\.exports\b|\bexports\.[\w$]+\s*=/;
const ESM_SYNTAX = /^\s*(import\s[^(]|export\s)/m;

const OUTPUT_TAIL_LINES = 40;

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} isn't valid JSON: ${error.message}`);
  }
}

// ---------- versions and ranges ----------

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

// The lowest Node major a semver range admits, or null when the range isn't understood.
export function rangeMinMajor(range) {
  const majors = String(range).split('||').map(alternativeMinMajor);
  if (majors.includes(null)) return null;
  return Math.min(...majors);
}

function alternativeMinMajor(alternative) {
  const text = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
  if (text === '' || text === '*' || /^x$/i.test(text)) return 0;
  const hyphen = /^(\S+)\s+-\s+\S+$/.exec(text);
  if (hyphen) return comparatorLowerBound(hyphen[1]);
  let lowest = 0;
  for (const comparator of text.split(/\s+/)) {
    const bound = comparatorLowerBound(comparator);
    if (bound === null) return null;
    lowest = Math.max(lowest, bound);
  }
  return lowest;
}

function comparatorLowerBound(comparator) {
  const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(\.(\d+|[xX*])){0,2}$/.exec(comparator);
  if (!match) return null;
  if (match[1] === '<' || match[1] === '<=') return 0;
  return /\d/.test(match[2]) ? Number(match[2]) : 0;
}

function pinMajor(value) {
  const match = /^v?(\d+)/.exec(String(value).trim());
  return match ? Number(match[1]) : null;
}

// ---------- inspect ----------

export function detectPackageManager(root, pkg) {
  const present = LOCKFILES.filter(lockfileExists.bind(null, root));
  const lockfiles = present.map(lockfileName);
  const fromLockfiles = [...new Set(present.map(lockfileManager))];
  const notes = [];
  if (pkg?.packageManager) {
    const match = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager);
    if (!match) return { name: null, source: 'packageManager', field: pkg.packageManager, lockfiles, notes: [`packageManager "${pkg.packageManager}" names no supported manager (${PACKAGE_MANAGERS.join(', ')}).`] };
    if (fromLockfiles.length && !fromLockfiles.includes(match[1])) notes.push(`packageManager says ${match[1]}, but the lockfiles belong to ${fromLockfiles.join(', ')}.`);
    return { name: match[1], source: 'packageManager', field: pkg.packageManager, lockfiles, notes };
  }
  if (fromLockfiles.length > 1) return { name: null, source: 'lockfile', ambiguous: true, lockfiles, notes: [`Lockfiles for ${fromLockfiles.join(' and ')} exist, and package.json has no packageManager field.`] };
  if (fromLockfiles.length === 1) return { name: fromLockfiles[0], source: 'lockfile', lockfiles, notes };
  return { name: 'npm', source: 'default', lockfiles, notes: ['No lockfile and no packageManager field, so npm is assumed.'] };
}

function lockfileExists(root, [file]) {
  return fs.existsSync(path.join(root, file));
}

function lockfileName([file]) {
  return file;
}

function lockfileManager([, manager]) {
  return manager;
}

export function nodeRuntime(version) {
  const major = Number(String(version).split('.')[0]);
  return { version, major, required: `>=${MIN_NODE_MAJOR}`, ok: major >= MIN_NODE_MAJOR };
}

export function enginesCheck(range) {
  if (range === undefined || range === null) return { range: null, min_major: null, ok: false, suggested: `>=${MIN_NODE_MAJOR}` };
  const minMajor = rangeMinMajor(range);
  return { range, min_major: minMajor, ok: minMajor === null ? null : minMajor >= MIN_NODE_MAJOR, suggested: `>=${MIN_NODE_MAJOR}` };
}

function versionPins(root, pkg) {
  const pins = [];
  for (const file of VERSION_PIN_FILES) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) pins.push(pinStatus(file, fs.readFileSync(full, 'utf8').split('\n')[0].trim()));
  }
  if (pkg?.volta?.node) pins.push(pinStatus('package.json volta.node', pkg.volta.node));
  return pins;
}

function pinStatus(source, value) {
  const major = pinMajor(value);
  return { source, value, major, ok: major === null ? null : major >= MIN_NODE_MAJOR, suggested: String(MIN_NODE_MAJOR) };
}

function moduleSystem(root, pkg) {
  const { files, truncated } = listJsFiles(root);
  const commonjs = [];
  let esm = 0;
  for (const file of files) {
    const full = path.join(root, file);
    let text;
    try {
      if (fs.statSync(full).size > SCAN_LIMITS.bytes) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (COMMONJS_SYNTAX.test(text)) commonjs.push(file);
    if (ESM_SYNTAX.test(text)) esm += 1;
  }
  return {
    type: pkg?.type ?? null,
    scanned_js_files: files.length,
    truncated,
    commonjs_files: commonjs.length,
    commonjs_examples: commonjs.slice(0, SCAN_LIMITS.examples),
    esm_files: esm,
  };
}

// Tracked and untracked `.js` files git doesn't ignore, or a directory walk outside git.
function listJsFiles(root) {
  const git = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const all = git.status === 0 ? git.stdout.split('\0').filter(isJsFile) : walkJsFiles(root);
  return { files: all.slice(0, SCAN_LIMITS.files), truncated: all.length > SCAN_LIMITS.files };
}

function isJsFile(file) {
  return file.endsWith('.js') && !file.split('/').some(isSkippedDir);
}

function isSkippedDir(segment) {
  return SCAN_SKIP_DIRS.has(segment);
}

function walkJsFiles(root) {
  const found = [];
  const pending = [''];
  while (pending.length && found.length <= SCAN_LIMITS.files) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SCAN_SKIP_DIRS.has(entry.name)) pending.push(rel);
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(rel);
    }
  }
  return found.sort();
}

// Workspace package globs from package.json `workspaces` (an array or `{ packages }`) or pnpm-workspace.yaml.
export function detectWorkspaces(root, pkg) {
  const fromPackage = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(fromPackage) && fromPackage.length) return { source: 'package.json', patterns: fromPackage };
  const pnpmFile = path.join(root, 'pnpm-workspace.yaml');
  if (!fs.existsSync(pnpmFile)) return null;
  const patterns = pnpmWorkspacePackages(fs.readFileSync(pnpmFile, 'utf8'));
  return patterns.length ? { source: 'pnpm-workspace.yaml', patterns } : null;
}

// The `packages:` list of pnpm-workspace.yaml, read line by line: the file is flat enough not to need a YAML parser.
function pnpmWorkspacePackages(text) {
  const patterns = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages || /^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s*(['"]?)(.+?)\1\s*(#.*)?$/.exec(line);
    if (!item) break;
    patterns.push(item[2]);
  }
  return patterns;
}

function installedTools(pkg) {
  const tools = {};
  for (const name of TOOL_PACKAGES) {
    const spec = pkg?.devDependencies?.[name] ?? pkg?.dependencies?.[name];
    if (spec) tools[name] = spec;
  }
  return tools;
}

function configFiles(root, pkg) {
  const found = [];
  for (const file of CONFIG_FILES) if (fs.existsSync(path.join(root, file))) found.push(file);
  for (const key of PACKAGE_JSON_CONFIG_KEYS) if (pkg?.[key] !== undefined) found.push(`package.json#${key}`);
  return found;
}

function gateScripts(pkg) {
  const scripts = {};
  for (const name of GATE_SCRIPTS) scripts[name] = pkg?.scripts?.[name] ?? null;
  return scripts;
}

// What could keep the workflow from using this manifest or its after_task gate.
function workflowSettings(root) {
  const config = readJsonIfExists(path.join(root, '.aisdlc/config.json'));
  const stacksDir = path.join(root, '.aisdlc/stacks');
  const installed = fs.existsSync(stacksDir) ? fs.readdirSync(stacksDir).filter(isJsonFile).map(stripJsonExtension).sort() : [];
  return {
    initialized: fs.existsSync(path.join(root, '.aisdlc')),
    configured_stack: config?.stack ?? 'auto',
    installed_stack_manifests: installed,
    config_after_task: config?.hooks && Object.hasOwn(config.hooks, 'after_task') ? { set: true, value: config.hooks.after_task } : { set: false },
    env_after_task: process.env.AISDLC_HOOK_AFTER_TASK === undefined ? { set: false } : { set: true, value: process.env.AISDLC_HOOK_AFTER_TASK },
  };
}

function isJsonFile(name) {
  return name.endsWith('.json');
}

function stripJsonExtension(name) {
  return name.slice(0, -'.json'.length);
}

export function inspectProject(root) {
  const pkg = readJsonIfExists(path.join(root, 'package.json'));
  return {
    root,
    package_json: pkg !== null,
    package_manager: detectPackageManager(root, pkg),
    workspaces: detectWorkspaces(root, pkg),
    yarn_pnp: fs.existsSync(path.join(root, '.pnp.cjs')) || fs.existsSync(path.join(root, '.pnp.js')),
    node: nodeRuntime(process.versions.node),
    engines: enginesCheck(pkg?.engines?.node),
    version_pins: versionPins(root, pkg),
    module: moduleSystem(root, pkg),
    scripts: gateScripts(pkg),
    tools: installedTools(pkg),
    config_files: configFiles(root, pkg),
    coverage_dir_ignored: gitIgnores(root, 'coverage/'),
    eslint_template: templateStatus(root, 'eslint'),
    workflow: workflowSettings(root),
    manifest: checkManifest(root),
  };
}

// ---------- coverage reports ----------

// A metric with nothing to cover counts as fully covered.
function percent(hit, total) {
  return total ? Math.round((hit / total) * 10000) / 100 : 100;
}

// The same formats and parsers as COVERAGE_FORMATS in the core script, which shares no code with stack plugins.
export const REPORT_FORMATS = {
  'json-summary': { metrics: ['lines', 'statements', 'functions', 'branches'], parse: parseJsonSummary },
  lcov: { metrics: ['lines', 'branches', 'functions'], parse: parseLcov },
};

function parseJsonSummary(text) {
  const { total } = JSON.parse(text);
  if (!total) throw new Error('it has no "total" entry');
  const metrics = {};
  for (const metric of REPORT_FORMATS['json-summary'].metrics) {
    if (!total[metric]) continue;
    metrics[metric] = typeof total[metric].pct === 'number' ? total[metric].pct : percent(total[metric].covered, total[metric].total);
  }
  return metrics;
}

function parseLcov(text) {
  const sums = {};
  for (const match of text.matchAll(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)\s*$/gm)) sums[match[1]] = (sums[match[1]] || 0) + Number(match[2]);
  if (!('LF' in sums)) throw new Error('it has no LF: line counts');
  const metrics = { lines: percent(sums.LH || 0, sums.LF) };
  if ('BRF' in sums) metrics.branches = percent(sums.BRH || 0, sums.BRF);
  if ('FNF' in sums) metrics.functions = percent(sums.FNH || 0, sums.FNF);
  return metrics;
}

// true or false, or null outside a git repository.
function gitIgnores(root, relPath) {
  const result = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: root });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// ---------- manifest ----------

function pluginManifest() {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'stack.json'), 'utf8'));
}

function requireInitialized(root) {
  if (!fs.existsSync(path.join(root, '.aisdlc'))) fail('.aisdlc/ doesn\'t exist here. Run /aisdlc:init first, from the project root.');
}

function requireChoice(name, value, choices) {
  if (value === undefined) fail(`Usage: --${name} is required (${choices.join('|')})`);
  if (!choices.includes(value)) fail(`Invalid --${name} "${value}". Valid: ${choices.join(', ')}`);
  return value;
}

export function parseThresholds(text) {
  const thresholds = {};
  for (const pair of text.split(',')) {
    const match = /^\s*(\w+)\s*=\s*(\d+(\.\d+)?)\s*$/.exec(pair);
    if (!match) fail(`Invalid --thresholds entry "${pair}". Write metric=percent pairs, for example lines=80,branches=80.`);
    thresholds[match[1]] = Number(match[2]);
  }
  return thresholds;
}

// The thresholds the manifest records: the given ones, or the plugin's floor for every metric the format measures.
export function resolveThresholds(format, given, floor) {
  const measured = REPORT_FORMATS[format].metrics;
  const leftOut = [];
  const thresholds = {};
  const requested = given ?? Object.fromEntries(Object.entries(floor).filter(isMeasuredBy.bind(null, measured)));
  for (const [metric, min] of Object.entries(requested)) {
    if (!(metric in floor)) fail(`Invalid threshold metric "${metric}". Valid: ${Object.keys(floor).join(', ')}`);
    if (!measured.includes(metric)) fail(`${format} reports have no ${metric} figure, so there can't be a ${metric} threshold. Leave it out.`);
    if (min > 100) fail(`The ${metric} threshold ${min}% is above 100%.`);
    if (min < floor[metric]) fail(`The ${metric} threshold ${min}% is below this stack's ${floor[metric]}% floor. Registration doesn't lower thresholds.`);
    thresholds[metric] = min;
  }
  for (const metric of Object.keys(floor)) {
    if (metric in thresholds) continue;
    leftOut.push({ metric, reason: measured.includes(metric) ? 'not passed in --thresholds: the coverage command doesn\'t enforce it' : `${format} reports have no ${metric} figure` });
  }
  return { thresholds, leftOut };
}

function isMeasuredBy(measured, [metric]) {
  return measured.includes(metric);
}

export function buildManifest(template, choices) {
  const manifest = structuredClone(template);
  const { thresholds, leftOut } = resolveThresholds(choices.format, choices.thresholds, template.quality_gate.coverage_thresholds);
  manifest.runtime.module_type = choices.moduleType;
  manifest.quality_gate = {
    ...template.quality_gate,
    linter: choices.linter ?? template.quality_gate.linter,
    test_runner: choices.testRunner ?? template.quality_gate.test_runner,
    coverage_report: { path: choices.report, format: choices.format },
    coverage_thresholds: thresholds,
  };
  manifest.hooks.after_task.run = [].concat(template.hooks.after_task.run).map(withPackageManager.bind(null, choices.packageManager));
  return { manifest, leftOut };
}

function withPackageManager(manager, command) {
  return command.replace(/^npm /, `${manager} `);
}

function writeManifest(root, opts) {
  requireInitialized(root);
  const report = opts.report;
  if (!report) fail('Usage: --report is required (the coverage report path, relative to the project root)');
  if (path.isAbsolute(report) || report.split(/[\\/]/).includes('..')) fail(`Invalid --report "${report}": give a path inside the project, relative to its root.`);
  const { manifest, leftOut } = buildManifest(pluginManifest(), {
    packageManager: requireChoice('package-manager', opts['package-manager'], PACKAGE_MANAGERS),
    moduleType: requireChoice('module-type', opts['module-type'], MODULE_TYPES),
    format: requireChoice('format', opts.format, Object.keys(REPORT_FORMATS)),
    report: report.split(path.sep).join('/'),
    linter: opts.linter,
    testRunner: opts['test-runner'],
    thresholds: opts.thresholds === undefined ? undefined : parseThresholds(opts.thresholds),
  });
  const file = path.join(root, MANIFEST_FILE);
  const existing = readJsonIfExists(file);
  if (existing?.quality_gate?.scans) {
    manifest.quality_gate.scans = existing.quality_gate.scans;
    applyScanGates(root, manifest, opts['package-manager']);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  out({ written: MANIFEST_FILE, manifest, left_out: leftOut });
}

// Scan settings are opt-in; project scripts own scanner configuration and failure policy.
// Keep these settings when re-registering so a tooling update cannot silently remove a gate.
function applyScanGates(root, manifest, manager) {
  const pkg = readJsonIfExists(path.join(root, 'package.json'));
  const scans = manifest.quality_gate.scans;
  if (!scans || typeof scans !== 'object' || Array.isArray(scans)) fail('quality_gate.scans must be an object.');
  for (const [name, enabled] of Object.entries(scans)) {
    if (!Object.hasOwn(SCAN_SCRIPTS, name) || typeof enabled !== 'boolean') fail(`Invalid scan setting "${name}"; expected sonar or vulnerabilities with a boolean value.`);
  }
  const hook = manifest.hooks?.after_task;
  const commands = [].concat(hook?.run ?? []);
  if (hook?.use || !commands.length || commands.some(isNotCommand)) fail('after_task must contain run commands before enabling scans. Re-run /aisdlc-nodejs:nodejs-register.');
  // Remove only exact commands owned by this integration; retain other project hooks in order.
  const retained = commands.filter(isNotConfiguredScanCommand.bind(null, scans));
  for (const [name, script] of Object.entries(SCAN_SCRIPTS)) {
    if (!scans[name]) continue;
    if (typeof pkg?.scripts?.[script] !== 'string' || !pkg.scripts[script].trim()) fail(`Configure package.json scripts["${script}"] before enabling ${name}.`);
    retained.push(`${manager} run ${script}`);
  }
  hook.run = retained;
}

function isNotCommand(value) {
  return typeof value !== 'string' || !value.trim();
}

function isNotConfiguredScanCommand(scans, command) {
  for (const [name, script] of Object.entries(SCAN_SCRIPTS)) {
    if (!Object.hasOwn(scans, name)) continue;
    for (const manager of PACKAGE_MANAGERS) if (command === `${manager} run ${script}`) return false;
  }
  return true;
}

function writeScanSettings(root, opts) {
  requireInitialized(root);
  const manager = requireChoice('package-manager', opts['package-manager'], PACKAGE_MANAGERS);
  if (opts.sonar === undefined && opts.vulnerabilities === undefined) fail('Usage: manifest scans requires --sonar on|off or --vulnerabilities on|off.');
  const status = checkManifest(root);
  if (!status.current) fail(`The stack manifest isn't usable: ${status.problems.join(' ')}`);
  const file = path.join(root, MANIFEST_FILE);
  const manifest = readJsonIfExists(file);
  manifest.quality_gate ??= {};
  manifest.quality_gate.scans ??= {};
  if (typeof manifest.quality_gate.scans !== 'object' || Array.isArray(manifest.quality_gate.scans)) fail('quality_gate.scans must be an object.');
  for (const name of Object.keys(SCAN_SCRIPTS)) {
    if (opts[name] !== undefined) manifest.quality_gate.scans[name] = requireChoice(name, opts[name], ['on', 'off']) === 'on';
  }
  applyScanGates(root, manifest, manager);
  manifest.version = pluginManifest().version;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  out({ written: MANIFEST_FILE, manifest });
}

export function checkManifest(root, pluginVersion = pluginManifest().version) {
  const result = { manifest: MANIFEST_FILE, installed: false, version: null, plugin_version: pluginVersion, oldest_compatible: OLDEST_COMPATIBLE_MANIFEST, current: false, problems: [], notes: [] };
  const file = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    result.problems.push(`${MANIFEST_FILE} doesn't exist. Register the stack with /aisdlc-nodejs:nodejs-register.`);
    return result;
  }
  result.installed = true;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    result.problems.push(`${MANIFEST_FILE} isn't valid JSON (${error.message}). Re-run /aisdlc-nodejs:nodejs-register.`);
    return result;
  }
  result.version = manifest.version ?? null;
  if (manifest.name !== 'nodejs') result.problems.push(`${MANIFEST_FILE} names the stack "${manifest.name}", not "nodejs". Re-run /aisdlc-nodejs:nodejs-register.`);
  if (!parseVersion(result.version)) {
    result.problems.push(`${MANIFEST_FILE} has no valid version. Re-run /aisdlc-nodejs:nodejs-register.`);
  } else if (compareVersions(result.version, OLDEST_COMPATIBLE_MANIFEST) < 0) {
    result.problems.push(`${MANIFEST_FILE} was written by aisdlc-nodejs ${result.version}, and this plugin needs one from ${OLDEST_COMPATIBLE_MANIFEST} or later. Re-run /aisdlc-nodejs:nodejs-register; the plugin's changelog lists what changed.`);
  } else if (compareVersions(result.version, pluginVersion) > 0) {
    result.problems.push(`${MANIFEST_FILE} was written by aisdlc-nodejs ${result.version}, newer than this plugin (${pluginVersion}). Update the aisdlc-nodejs plugin.`);
  } else if (compareVersions(result.version, pluginVersion) < 0) {
    result.notes.push(`${MANIFEST_FILE} was written by aisdlc-nodejs ${result.version} and still works with ${pluginVersion}. Re-running /aisdlc-nodejs:nodejs-register picks up the changes since then.`);
  }
  result.current = result.problems.length === 0;
  return result;
}

// ---------- templates ----------

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// 'missing', 'current', 'outdated' (an unedited copy from an earlier release), or 'modified' (edited in the project).
function templateStatus(root, name) {
  const target = path.join(root, TEMPLATES[name]);
  if (!fs.existsSync(target)) return 'missing';
  const copy = fs.readFileSync(target, 'utf8');
  if (copy === fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', TEMPLATES[name]), 'utf8')) return 'current';
  return Object.hasOwn(TEMPLATE_HISTORY[name], sha256(copy)) ? 'outdated' : 'modified';
}

const TEMPLATE_RESULTS = { missing: 'created', outdated: 'updated', current: 'unchanged' };

function copyTemplate(root, name) {
  if (!Object.hasOwn(TEMPLATES, name)) fail(`Usage: template ${Object.keys(TEMPLATES).join('|')}`);
  const file = TEMPLATES[name];
  const status = templateStatus(root, name);
  if (status === 'modified') fail(`${file} differs from this plugin's template (${path.join(PLUGIN_ROOT, 'templates', file)}). Show the user the difference; to replace it, delete ${file} with their approval and run this again.`);
  if (status !== 'current') fs.copyFileSync(path.join(PLUGIN_ROOT, 'templates', file), path.join(root, file));
  out({ template: name, file, status: TEMPLATE_RESULTS[status] });
}

// ---------- baseline ----------

function tail(text) {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-OUTPUT_TAIL_LINES).join('\n');
}

function reportStamp(file) {
  return fs.existsSync(file) ? fs.statSync(file).mtimeMs : null;
}

// Deletes the report (and its folder, unless that is the project root) so the run starts like a fresh clone.
// Only what git ignores is deleted, so nothing tracked or hand-written is lost.
function cleanReport(root, report) {
  const dir = path.posix.dirname(report);
  const target = dir === '.' ? report : `${dir}/`;
  const ignored = gitIgnores(root, target);
  if (ignored !== true) fail(`Refusing to delete ${target}: ${ignored === null ? 'this isn\'t a git repository' : 'git doesn\'t ignore it'}. Add it to .gitignore first, or run baseline without --clean.`);
  fs.rmSync(path.join(root, target), { recursive: true, force: true });
  return target;
}

function runCommand(root, command) {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const exitCode = result.error ? 1 : result.status ?? 1;
  if (exitCode === 0) return { command, exit_code: 0, ok: true };
  return { command, exit_code: exitCode, ok: false, output_tail: tail(`${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`) };
}

function baseline(root, opts) {
  requireInitialized(root);
  const status = checkManifest(root);
  if (!status.current) fail(`The stack manifest isn't usable: ${status.problems.join(' ')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
  const declared = manifest.quality_gate?.coverage_report;
  if (!declared?.path || !REPORT_FORMATS[declared.format]) fail(`${MANIFEST_FILE} declares no usable quality_gate.coverage_report. Re-run /aisdlc-nodejs:nodejs-register.`);
  const reportFile = path.join(root, declared.path);
  const cleaned = opts.clean ? cleanReport(root, declared.path) : null;
  const before = reportStamp(reportFile);
  const commands = [].concat(manifest.hooks?.after_task?.run ?? []).map(runCommand.bind(null, root));
  const after = reportStamp(reportFile);
  const problems = [];
  for (const command of commands) if (!command.ok) problems.push(`\`${command.command}\` exited with ${command.exit_code}.`);

  const report = { path: declared.path, format: declared.format, exists: after !== null, fresh: after !== null && after !== before, metrics: null, ignored_by_git: gitIgnores(root, declared.path) };
  if (!report.exists) problems.push(`${declared.path} wasn't written. Check the coverage reporter configuration.`);
  else if (!report.fresh) problems.push(`${declared.path} wasn't rewritten by this run, so it doesn't describe the current code. Check the coverage reporter configuration.`);
  if (report.exists) {
    try {
      report.metrics = REPORT_FORMATS[declared.format].parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (error) {
      problems.push(`${declared.path} isn't a valid ${declared.format} report: ${error.message}.`);
    }
  }
  if (report.ignored_by_git === false) problems.push(`git doesn't ignore ${declared.path}, so reports would show up in a goal's changes. Add its folder to .gitignore.`);
  for (const [metric, min] of Object.entries(manifest.quality_gate?.coverage_thresholds ?? {})) {
    const value = report.metrics?.[metric];
    if (report.metrics && value === undefined) problems.push(`${declared.path} has no ${metric} figure, but the manifest sets a ${metric} threshold of ${min}%.`);
    else if (value !== undefined && value < min) problems.push(`${metric} coverage is ${value}%, below the ${min}% threshold.`);
  }
  out({ cleaned, commands, report, thresholds: manifest.quality_gate?.coverage_thresholds ?? {}, ok: problems.length === 0, problems });
  if (problems.length) process.exitCode = 1;
}

// ---------- cli ----------

const OPTIONS = {
  'package-manager': { type: 'string' },
  'module-type': { type: 'string' },
  format: { type: 'string' },
  report: { type: 'string' },
  linter: { type: 'string' },
  'test-runner': { type: 'string' },
  thresholds: { type: 'string' },
  sonar: { type: 'string' },
  vulnerabilities: { type: 'string' },
  clean: { type: 'boolean' },
};

const USAGE = 'Usage: nodejs.mjs inspect | manifest write --package-manager npm|pnpm|yarn|bun --module-type module|commonjs --format json-summary|lcov --report <path> [--linter <name>] [--test-runner <name>] [--thresholds metric=percent,...] | manifest scans --package-manager npm|pnpm|yarn|bun [--sonar on|off] [--vulnerabilities on|off] | manifest check | baseline [--clean] | template eslint';

const commands = {
  inspect(positionals) {
    if (positionals.length) fail(USAGE);
    out(inspectProject(process.cwd()));
  },
  manifest([action, ...rest], opts) {
    if (rest.length) fail(USAGE);
    if (action === 'write') return writeManifest(process.cwd(), opts);
    if (action === 'scans') return writeScanSettings(process.cwd(), opts);
    if (action === 'check') {
      const result = checkManifest(process.cwd());
      out(result);
      if (!result.current) process.exitCode = 1;
      return;
    }
    fail(USAGE);
  },
  template([name, ...rest]) {
    if (!name || rest.length) fail(USAGE);
    copyTemplate(process.cwd(), name);
  },
  baseline(positionals, opts) {
    if (positionals.length) fail(USAGE);
    baseline(process.cwd(), opts);
  },
};

function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`nodejs: ${error.message}\n${USAGE}\n`);
    process.exit(1);
  }
  const [command, ...positionals] = parsed.positionals;
  if ((parsed.values.sonar !== undefined || parsed.values.vulnerabilities !== undefined) && (command !== 'manifest' || positionals[0] !== 'scans')) {
    process.stderr.write('nodejs: --sonar and --vulnerabilities are only supported by manifest scans.\n');
    process.exit(1);
  }
  if (!commands[command]) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(command ? 1 : 0);
  }
  try {
    commands[command](positionals, parsed.values);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    process.stderr.write(`nodejs: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) main();
