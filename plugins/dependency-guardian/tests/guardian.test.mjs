import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, nodeVersionError, validateCatalog, validateConfig, validateRule, waiverState, matchRules, matchesPackage,
  loadPolicy, findProjectRoot, UserError, BUILTIN_RULES, GUARDIAN_VERSION,
} from '../scripts/guardian.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PLUGIN, 'scripts/guardian.mjs');
const catalog = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'catalog/npm.json'), 'utf8'));

const rule = (over = {}) => ({ id: 'ORG-NOLODASH', package: 'lodash', direct: 'warn', transitive: 'allow', rationale: 'Prefer native helpers.', ...over });
const waiver = (over = {}) => ({ ruleId: 'NPM-MOMENT', package: 'moment', owner: 'team-a', reason: 'Migration is tracked', expiresAt: '2026-12-31', ...over });

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('runtime: the script refuses Node.js older than 24, and importing it runs nothing', () => {
  assert.equal(nodeVersionError('24.0.0'), null);
  assert.equal(nodeVersionError('22.12.0'), 'dependency-guardian needs Node.js 24 or later; this is Node.js 22.12.0.');
  assert.match(GUARDIAN_VERSION, /^\d+\.\d+\.\d+$/);
});

test('args: unknown options fail, flags take no value, and -- passes the rest through untouched', () => {
  assert.deepEqual(parseArgs(['--ci', '--json']), { pos: [], opts: { ci: true, json: true }, rest: [] });
  assert.deepEqual(parseArgs(['--workspace', 'api', '--signatures']).opts, { workspace: 'api', signatures: true });
  assert.deepEqual(parseArgs(['--', 'install', '--save-dev', '--ci', 'x']), { pos: [], opts: {}, rest: ['install', '--save-dev', '--ci', 'x'] });
  assert.deepEqual(parseArgs(['--json', '--', 'i', 'moment@2']).rest, ['i', 'moment@2']);
  assert.throws(() => parseArgs(['--bogus']), (e) => e instanceof UserError && /Unknown option --bogus/.test(e.message));
  assert.throws(() => parseArgs(['--workspace']), /--workspace needs a value/);
  assert.throws(() => parseArgs(['--workspace', '--', 'x']), /--workspace needs a value/);
});

test('catalog: the shipped catalog is valid and holds the reviewed Moment.js rule', () => {
  assert.deepEqual(validateCatalog(catalog), []);
  const [moment] = matchRules(catalog.rules, 'moment');
  assert.deepEqual([moment.id, moment.direct, moment.transitive], ['NPM-MOMENT', 'deny', 'warn']);
  assert.deepEqual(moment.alternatives.map((a) => a.name), ['Intl and Date', 'Temporal', 'date-fns', 'Luxon', 'Day.js']);
  assert.ok(moment.sources.every((s) => s.startsWith('https://')) && moment.reviewed);
  assert.deepEqual(matchRules(catalog.rules, 'moment-timezone'), [], 'an exact matcher does not match a longer name');
});

test('catalog: every defect is named, and the scanner\'s own rule ids are reserved', () => {
  const bad = (over) => validateCatalog({ ...catalog, rules: [{ ...catalog.rules[0], ...over }] }).join('\n');
  assert.match(bad({ id: 'moment' }), /id "moment" must look like/);
  assert.match(bad({ id: 'GUARD-AUDIT' }), /reserved for the scanner/);
  assert.match(bad({ direct: 'block' }), /direct must be one of deny, warn, allow/);
  assert.match(bad({ rationale: ' ' }), /rationale is required/);
  assert.match(bad({ sources: [] }), /at least one/);
  assert.match(bad({ sources: ['http://x.test'] }), /https URLs/);
  assert.match(bad({ reviewed: '2026-02-30' }), /reviewed must be a date/);
  assert.match(bad({ alternatives: [{ name: 'x' }] }), /alternatives\[0\] needs a name and a use/);
  assert.match(bad({ colour: 'red' }), /unknown field "colour"/);
  assert.match(validateCatalog({ ...catalog, version: 2 }).join(), /version must be 1/);
  assert.match(validateCatalog({ ...catalog, ecosystem: 'maven' }).join(), /ecosystem must be "npm"/);
  assert.deepEqual(validateCatalog([]), ['catalog: must be a JSON object']);
});

test('config: defaults are strict, own rules need no sources, and typos fail', () => {
  assert.deepEqual(validateConfig({ version: 1 }, catalog), []);
  assert.deepEqual(validateConfig({ version: 1, auditLevel: 'high', deprecated: 'warn', outdated: 'off', signatures: true, workspaces: ['api'], rules: [rule()] }, catalog), []);
  const bad = (over) => validateConfig({ version: 1, ...over }, catalog).join('\n');
  assert.match(bad({ auditLevel: 'severe' }), /auditLevel must be one of/);
  assert.match(bad({ deprecated: 'off' }), /deprecated must be one of deny, warn/);
  assert.match(bad({ signatures: 'yes' }), /signatures must be true or false/);
  assert.match(bad({ audit_level: 'low' }), /unknown field "audit_level"/);
  assert.match(bad({ rules: [rule({ id: 'NPM-MOMENT' })] }), /rule id NPM-MOMENT is defined twice/);
  assert.match(bad({ rules: [rule({ sources: ['ftp://x'] })] }), /https URLs/);
  assert.match(validateConfig({}, catalog).join(), /version must be 1/);
});

test('waivers: all five fields are required, scoped to one known rule and one package', () => {
  const bad = (over) => validateConfig({ version: 1, waivers: [waiver(over)] }, catalog).join('\n');
  assert.deepEqual(validateConfig({ version: 1, waivers: [waiver(), waiver({ ruleId: 'GUARD-AUDIT', package: 'minimist' })] }, catalog), []);
  for (const field of ['ruleId', 'package', 'owner', 'reason']) assert.match(bad({ [field]: '' }), new RegExp(`${field} is required`));
  assert.match(bad({ expiresAt: undefined }), /expiresAt must be a date/);
  assert.match(bad({ expiresAt: 'next week' }), /expiresAt must be a date/);
  assert.match(bad({ ruleId: 'NPM-NOPE' }), /ruleId NPM-NOPE is not a known rule/);
  assert.match(bad({ package: 'mom*' }), /one package, not a pattern/);
  assert.match(bad({ extra: 1 }), /unknown field "extra"/);
  assert.ok(BUILTIN_RULES.every((id) => validateConfig({ version: 1, waivers: [waiver({ ruleId: id })] }, catalog).length === 0));
});

test('waivers: active through the whole expiresAt day (UTC) and expired from the next midnight', () => {
  const w = waiver({ expiresAt: '2026-10-07' });
  assert.equal(waiverState(w, new Date('2026-10-06T23:59:59Z')), 'active');
  assert.equal(waiverState(w, new Date('2026-10-07T00:00:00Z')), 'active');
  assert.equal(waiverState(w, new Date('2026-10-07T23:59:59.999Z')), 'active');
  assert.equal(waiverState(w, new Date('2026-10-08T00:00:00Z')), 'expired');
  assert.equal(waiverState({ ...w, expiresAt: 'soon' }), 'invalid');
  assert.equal(waiverState(undefined), 'invalid');
});

test('matching: exact names, scope prefixes and lists', () => {
  assert.ok(matchesPackage('@scope/*', '@scope/pkg'));
  assert.ok(!matchesPackage('@scope/*', '@other/pkg'));
  assert.ok(matchesPackage('left-pad', 'left-pad'));
  assert.ok(!matchesPackage('left-pad', 'left-pad2'));
  const r = rule({ package: ['request', 'request-*'] });
  assert.deepEqual([matchesPackage('request', 'request'), matchRules([r], 'request-promise').length, matchRules([r], 'requests').length], [true, 1, 0]);
  assert.match(validateRule(rule({ package: [] }), 'r', { sourcesRequired: false }).join(), /package must be a name/);
});

test('files: the project root is the nearest package.json, and the config loads over the catalog', () => {
  const p = project({ 'sub/deep/file.txt': 'x', '.dependency-guardian/config.json': { version: 1, auditLevel: 'high', rules: [rule()], waivers: [waiver()] } });
  try {
    assert.equal(fs.realpathSync(findProjectRoot(path.join(p.dir, 'sub/deep'))), fs.realpathSync(p.dir));
    const policy = loadPolicy(p.dir);
    assert.equal(policy.config.auditLevel, 'high');
    assert.equal(policy.config.outdated, 'warn', 'unset fields keep the strict default');
    assert.deepEqual(policy.rules.map((r) => r.id), ['NPM-MOMENT', 'ORG-NOLODASH']);
    assert.ok(policy.configFile.endsWith('config.json'));
  } finally { p.done(); }
  const none = project();
  try { assert.equal(loadPolicy(none.dir).configFile, null); } finally { none.done(); }
});

test('files: a vendored copy reads catalog.json beside the script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-vendored-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.copyFileSync(SCRIPT, path.join(dir, 'guardian.mjs'));
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ ...catalog, rules: [] }));
    const r = spawnSync(process.execPath, [path.join(dir, 'guardian.mjs'), 'validate-policy', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).catalogRules, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli: validate-policy exits 0 when valid, 1 for an expired waiver, 2 for anything malformed', () => {
  const valid = project();
  try {
    const r = valid.run(['validate-policy']);
    assert.deepEqual([r.status, r.stdout], [0, 'Policy is valid: 1 rule(s), 0 waiver(s).\n']);
    const j = JSON.parse(valid.run(['validate-policy', '--json']).stdout);
    assert.deepEqual([j.status, j.catalogRules, j.configFile], ['pass', 1, null]);
  } finally { valid.done(); }

  const expired = project({ '.dependency-guardian/config.json': { version: 1, waivers: [waiver({ expiresAt: '2020-01-01' })] } });
  try {
    const r = expired.run(['validate-policy', '--json']);
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.status, j.waivers[0].state], ['fail', 'expired']);
    assert.match(expired.run(['validate-policy']).stdout, /Expired waiver: NPM-MOMENT for moment \(owner team-a, expired 2020-01-01\)/);
  } finally { expired.done(); }

  const active = project({ '.dependency-guardian/config.json': { version: 1, waivers: [waiver({ expiresAt: '2999-01-01' })] } });
  try { assert.equal(active.run(['validate-policy']).status, 0); } finally { active.done(); }

  for (const [name, content, re] of [
    ['not json', '{oops', /not valid JSON/],
    ['unknown field', { version: 1, colour: 1 }, /unknown field "colour"/],
    ['bad waiver', { version: 1, waivers: [{ ruleId: 'NPM-MOMENT' }] }, /package is required/],
  ]) {
    const p = project({ '.dependency-guardian/config.json': content });
    try {
      const r = p.run(['validate-policy']);
      assert.equal(r.status, 2, name);
      assert.match(r.stderr, re, name);
      assert.equal(r.stdout, '', `${name}: nothing on stdout`);
    } finally { p.done(); }
  }
});

test('cli: unknown commands and options exit 2, and commands not built yet say so', () => {
  const p = project();
  try {
    assert.equal(p.run([]).status, 2);
    assert.match(p.run(['frobnicate']).stderr, /Usage: guardian\.mjs <validate-policy\|scan\|preflight\|hook>/);
    assert.match(p.run(['validate-policy', '--bogus']).stderr, /Unknown option --bogus/);
    for (const cmd of ['scan', 'preflight', 'hook']) {
      const r = p.run([cmd]);
      assert.deepEqual([r.status, /not implemented yet/.test(r.stderr)], [2, true], cmd);
    }
  } finally { p.done(); }
});

test('cli: running the script through a symlink still runs it', { skip: process.platform === 'win32' }, () => {
  const p = project();
  try {
    const link = path.join(p.dir, 'link.mjs');
    fs.symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link, 'validate-policy'], { cwd: p.dir, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout], [0, 'Policy is valid: 1 rule(s), 0 waiver(s).\n']);
  } finally { p.done(); }
});
