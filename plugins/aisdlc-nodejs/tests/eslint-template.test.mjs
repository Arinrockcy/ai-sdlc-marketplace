// The ESLint template register offers. The repository has no npm dependencies, so the rules are checked against a
// real ESLint (9 or later) only when AISDLC_ESLINT names a directory it resolves from, for example a project with
// ESLint installed: AISDLC_ESLINT=~/work/some-app npm test. Without it, those tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import aisdlcStandards from '../templates/eslint.aisdlc.mjs';
import { TEMPLATE_HISTORY } from '../scripts/nodejs.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PLUGIN, '../..');
const TEMPLATE = path.join(PLUGIN, 'templates/eslint.aisdlc.mjs');
const SCRIPT = path.join(PLUGIN, 'scripts/nodejs.mjs');
const ESLINT_FROM = process.env.AISDLC_ESLINT;

const INLINE = 'no-restricted-syntax';

// [file, code, rule IDs ESLint reports, in order, for the module or commonjs setting]
const MODULE_CASES = [
  ['src/a.js', 'export const ids = [1].map((x) => x);', [INLINE]],
  ['src/a.js', 'export const ids = [1].map(function (x) { return x; });', [INLINE]],
  ['src/a.js', 'function double(x) { return x * 2; }\nexport const ids = [1].map(double);', []],
  ['src/a.js', 'export const ids = [1].map(function double(x) { return x * 2; });', []],
  ['src/a.js', 'export const triple = (x) => x * 3;', []],
  ['src/a.js', 'export const wait = new Promise((resolve) => { setTimeout(resolve, 1); });', [INLINE]],
  ['src/a.js', 'export function make() { return () => 1; }', [INLINE]],
  ['src/a.js', 'export const add = (a) => (b) => a + b;', [INLINE]],
  ['src/a.js', 'export const handlers = { onClick: () => 1 };', [INLINE]],
  ['src/a.js', 'export const api = { run() { return 1; }, get size() { return 1; } };', []],
  ['src/a.js', 'export class Service { handle = () => 1; run() { return this.handle(); } }', []],
  ['src/a.js', 'export function wire(emitter) { emitter.onclose = () => 1; }', [INLINE]],
  ['src/a.js', "import fs from 'fs';\nexport default fs;", ['no-restricted-imports']],
  ['src/a.js', "import { readFile } from 'fs/promises';\nexport default readFile;", ['no-restricted-imports']],
  ['src/a.js', "import fs from 'node:fs';\nimport { readFile } from 'node:fs/promises';\nexport default [fs, readFile];", []],
  ['src/a.js', 'export const port = process.env.PORT;', ['no-restricted-properties']],
  ['src/config/index.js', 'export const port = Number(process.env.PORT);', []],
  ['test/a.test.js', 'process.env.PORT = "1";', []],
  ['src/a.js', 'export const here = __dirname;', ['no-restricted-globals']],
  ['src/a.js', 'export const here = import.meta.dirname;', []],
  ['src/a.js', "throw 'boom';", ['no-throw-literal']],
  ['src/a.js', 'export function read(f) { try { return f(); } catch { } return null; }', ['no-empty']],
  ['src/a.js', 'export const fail = Promise.reject(1);', ['prefer-promise-reject-errors']],
  ['src/a.js', 'console.log(1);', ['no-console']],
  ['src/a.js', '// eslint-disable-next-line no-console\nexport const x = 1;', [null]],
  ['src/a.mjs', 'export const here = __filename;', ['no-restricted-globals']],
  ['src/a.cjs', "const fs = require('fs');\nmodule.exports = { fs, dir: __dirname };", [INLINE]],
  ['src/a.js', "export const run = (code) => eval(code);", ['no-eval']],
  ['src/a.js', "export const make = new Function('a', 'return a');", ['no-new-func']],
  ['src/a.js', "setTimeout('tick()', 10);", ['no-implied-eval']],
  ['src/a.js', "import { exec } from 'node:child_process';\nexport default exec;", ['no-restricted-imports']],
  ['src/a.js', "import { execFile, spawn } from 'node:child_process';\nexport default [execFile, spawn];", []],
  ['src/a.js', 'export const agent = { rejectUnauthorized: false };', [INLINE]],
  ['src/a.js', 'export const agent = { rejectUnauthorized: true };', []],
  ['src/a.cjs', "const fs = require('node:fs');\nmodule.exports = { fs, dir: __dirname };", []],
];

const COMMONJS_CASES = [
  ['src/a.js', "const fs = require('fs');\nmodule.exports = fs;", [INLINE]],
  ['src/a.js', "const fs = require('node:fs');\nmodule.exports = { fs, dir: __dirname };", []],
  ['src/a.js', 'module.exports = [1].map((x) => x);', [INLINE]],
  ['src/a.mjs', 'export const here = __dirname;', ['no-restricted-globals']],
];

async function loadESLint() {
  const require = createRequire(path.join(path.resolve(ESLINT_FROM.replace(/^~/, os.homedir())), 'package.json'));
  return (await import(require.resolve('eslint'))).ESLint;
}

// Projects declare Node's globals (for example with the globals package); no-implied-eval needs setTimeout among them.
const NODE_GLOBALS = { name: 'test/node-globals', languageOptions: { globals: { setTimeout: 'readonly' } } };

async function ruleIds(ESLint, config, file, code) {
  const eslint = new ESLint({ cwd: PLUGIN, overrideConfigFile: true, overrideConfig: [...config, NODE_GLOBALS] });
  const [result] = await eslint.lintText(code, { filePath: path.join(PLUGIN, file) });
  return result.messages.map(ruleIdOf);
}

function ruleIdOf(message) {
  return message.ruleId;
}

function verifyTemplateShape() {
  const source = fs.readFileSync(TEMPLATE, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(importSpecifier);
  assert.deepEqual(imports, ['node:module'], 'the template may import only Node.js built-ins');

  const config = aisdlcStandards();
  assert.deepEqual(config.map(configName), ['aisdlc/linter-options', 'aisdlc/source-type', 'aisdlc/standards', 'aisdlc/es-modules', 'aisdlc/config-and-tests']);
  const imported = config[2].rules['no-restricted-imports'][1].paths.filter(isWholeModule).map(pathName);
  assert.ok(imported.includes('fs') && imported.includes('fs/promises'));
  assert.ok(!imported.some(isPrefixed));
  assert.deepEqual(aisdlcStandards({ sourceType: 'commonjs' })[3].files, ['**/*.mjs']);
  assert.throws(aisdlcStandards.bind(null, { sourceType: 'umd' }), /sourceType must be/);

  const extended = aisdlcStandards({ restrictedSyntax: [{ selector: 'WithStatement', message: 'no' }] });
  assert.equal(extended[2].rules['no-restricted-syntax'].at(-1).selector, 'WithStatement');
}

function importSpecifier(match) {
  return match[1];
}

function configName(entry) {
  return entry.name;
}

function isWholeModule(entry) {
  return !entry.importNames;
}

function pathName(entry) {
  return entry.name;
}

function isPrefixed(name) {
  return name.startsWith('node:');
}

function verifyTemplateCommand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-nodejs-template-'));
  const run = spawnSync.bind(null, process.execPath, [SCRIPT, 'template', 'eslint'], { cwd: dir, encoding: 'utf8' });
  assert.equal(JSON.parse(run().stdout).status, 'created');
  assert.equal(fs.readFileSync(path.join(dir, 'eslint.aisdlc.mjs'), 'utf8'), fs.readFileSync(TEMPLATE, 'utf8'));
  assert.equal(JSON.parse(run().stdout).status, 'unchanged');
  fs.appendFileSync(path.join(dir, 'eslint.aisdlc.mjs'), '// edited\n');
  const refused = run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /differs from this plugin's template/);

  const [oldHash] = Object.keys(TEMPLATE_HISTORY.eslint);
  const oldCopy = olderTemplate(oldHash);
  fs.writeFileSync(path.join(dir, 'eslint.aisdlc.mjs'), oldCopy);
  assert.equal(JSON.parse(run().stdout).status, 'updated');
  assert.equal(fs.readFileSync(path.join(dir, 'eslint.aisdlc.mjs'), 'utf8'), fs.readFileSync(TEMPLATE, 'utf8'));
}

// The released template with this hash, from git history.
function olderTemplate(hash) {
  const log = spawnSync('git', ['log', '--format=%H', '--', 'plugins/aisdlc-nodejs/templates/eslint.aisdlc.mjs'], { cwd: REPO, encoding: 'utf8' });
  for (const commit of log.stdout.split('\n').filter(Boolean)) {
    const shown = spawnSync('git', ['show', `${commit}:plugins/aisdlc-nodejs/templates/eslint.aisdlc.mjs`], { cwd: REPO, encoding: 'utf8' });
    if (shown.status === 0 && sha256(shown.stdout) === hash) return shown.stdout;
  }
  throw new Error(`No commit has the template with hash ${hash}.`);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Every committed version of the template except the current one is in TEMPLATE_HISTORY, so an unedited copy
// from any release updates instead of counting as modified.
function verifyTemplateHistory() {
  const current = sha256(fs.readFileSync(TEMPLATE, 'utf8'));
  assert.ok(!Object.hasOwn(TEMPLATE_HISTORY.eslint, current), 'TEMPLATE_HISTORY lists the current template, so a current copy would count as outdated');
  for (const hash of Object.keys(TEMPLATE_HISTORY.eslint)) assert.ok(olderTemplate(hash));
  const committed = committedTemplateHashes().filter(isNot.bind(null, current));
  const missing = committed.filter(isMissingFromHistory);
  assert.deepEqual(missing, [], 'add these hashes of earlier templates to TEMPLATE_HISTORY in scripts/nodejs.mjs');
}

function committedTemplateHashes() {
  const log = spawnSync('git', ['log', '--format=%H', '--', 'plugins/aisdlc-nodejs/templates/eslint.aisdlc.mjs'], { cwd: REPO, encoding: 'utf8' });
  return log.stdout.split('\n').filter(Boolean).map(templateHashAt);
}

function templateHashAt(commit) {
  return sha256(spawnSync('git', ['show', `${commit}:plugins/aisdlc-nodejs/templates/eslint.aisdlc.mjs`], { cwd: REPO, encoding: 'utf8' }).stdout);
}

function isNot(value, other) {
  return other !== value;
}

function isMissingFromHistory(hash) {
  return !Object.hasOwn(TEMPLATE_HISTORY.eslint, hash);
}

async function verifyRules(t) {
  if (!ESLINT_FROM) return t.skip('set AISDLC_ESLINT to a directory ESLint 9+ resolves from');
  const ESLint = await loadESLint();
  for (const [sourceType, cases] of [['module', MODULE_CASES], ['commonjs', COMMONJS_CASES]]) {
    const config = aisdlcStandards({ sourceType });
    for (const [file, code, expected] of cases) assert.deepEqual(await ruleIds(ESLint, config, file, code), expected, `${sourceType} ${file}: ${code}`);
  }
}

async function verifyTemplatePassesItsOwnRules(t) {
  if (!ESLINT_FROM) return t.skip('set AISDLC_ESLINT to a directory ESLint 9+ resolves from');
  const ESLint = await loadESLint();
  assert.deepEqual(await ruleIds(ESLint, aisdlcStandards(), 'eslint.aisdlc.mjs', fs.readFileSync(TEMPLATE, 'utf8')), []);
}

test('eslint template: core rules only, configurable and extendable', verifyTemplateShape);
test('eslint template: template eslint copies it once and keeps a modified copy', verifyTemplateCommand);
test('eslint template: TEMPLATE_HISTORY holds exactly the earlier committed templates', verifyTemplateHistory);
test('eslint template: rules catch what the standards forbid and allow what they permit', verifyRules);
test('eslint template: the template passes its own rules', verifyTemplatePassesItsOwnRules);
