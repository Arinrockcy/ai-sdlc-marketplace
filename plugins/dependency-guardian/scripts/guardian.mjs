#!/usr/bin/env node
// guardian.mjs — npm dependency guard. Zero dependencies: only node: built-ins, so the file can be vendored into
// any repository (`.dependency-guardian/guardian.mjs`) and run in CI as it is.
//
// Exit codes: 0 passed, 1 blocking policy findings, 2 invalid configuration, unsupported input or an incomplete
// assessment. `hook` never exits 1, because agents treat that as a non-blocking error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARDIAN_VERSION = '0.2.0';
const MIN_NODE_MAJOR = 24;
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);

export class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// ---------- arguments ----------

// Boolean flags take no value; value options take the next argument. `--` ends option parsing, and everything after
// it goes to `rest` untouched (preflight passes an npm command line through it).
export const FLAGS = new Set(['ci', 'json', 'signatures', 'offline']);
export const VALUE_OPTIONS = new Set(['workspace']);

export function parseArgs(argv) {
  const pos = [];
  const opts = {};
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (FLAGS.has(key)) opts[key] = true;
    else if (VALUE_OPTIONS.has(key)) {
      if (argv[i + 1] === undefined || argv[i + 1] === '--') fail(`--${key} needs a value`);
      opts[key] = argv[++i];
    } else fail(`Unknown option --${key}. Valid: ${[...FLAGS, ...VALUE_OPTIONS].map((o) => `--${o}`).join(', ')}`);
  }
  return { pos, opts, rest };
}

export function nodeVersionError(version) {
  const major = Number(String(version).split('.')[0]);
  return major >= MIN_NODE_MAJOR ? null : `dependency-guardian needs Node.js ${MIN_NODE_MAJOR} or later; this is Node.js ${version}.`;
}

// ---------- policy: catalog, configuration and waivers ----------

const ACTIONS = ['deny', 'warn', 'allow'];
const AUDIT_LEVELS = ['low', 'moderate', 'high', 'critical'];
const OUTDATED_ACTIONS = ['warn', 'deny', 'off'];
const DEPRECATED_ACTIONS = ['deny', 'warn'];
// Rules the scanner itself raises. Waivers can name them; the catalog and the configuration can't redefine them.
export const BUILTIN_RULES = ['GUARD-AUDIT', 'GUARD-DEPRECATED', 'GUARD-OUTDATED', 'GUARD-SOURCE'];
const RULE_ID = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isDate = (v) => typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`);
}

// A rule: which packages it matches, what to do for a direct and for a transitive one, and why.
export function validateRule(rule, where, { sourcesRequired }) {
  const errors = [];
  if (!isObject(rule)) return [`${where}: must be an object`];
  unknownKeys(rule, ['id', 'package', 'direct', 'transitive', 'rationale', 'alternatives', 'sources', 'reviewed'], where, errors);
  if (!RULE_ID.test(rule.id ?? '')) errors.push(`${where}: id "${rule.id}" must look like NPM-MOMENT (capitals, digits and dashes)`);
  else if (BUILTIN_RULES.includes(rule.id)) errors.push(`${where}: id ${rule.id} is reserved for the scanner`);
  const pkgs = Array.isArray(rule.package) ? rule.package : [rule.package];
  if (!pkgs.length || !pkgs.every(nonEmpty)) errors.push(`${where}: package must be a name, or a list of names (a trailing * matches a prefix, as in @scope/*)`);
  for (const key of ['direct', 'transitive']) {
    if (!ACTIONS.includes(rule[key])) errors.push(`${where}: ${key} must be one of ${ACTIONS.join(', ')}`);
  }
  if (!nonEmpty(rule.rationale)) errors.push(`${where}: rationale is required`);
  if (rule.alternatives !== undefined) {
    if (!Array.isArray(rule.alternatives)) errors.push(`${where}: alternatives must be a list`);
    else rule.alternatives.forEach((a, i) => {
      if (!isObject(a) || !nonEmpty(a.name) || !nonEmpty(a.use)) errors.push(`${where}: alternatives[${i}] needs a name and a use (when it fits)`);
    });
  }
  const sources = rule.sources;
  if (sources === undefined ? sourcesRequired : !Array.isArray(sources) || !sources.every((s) => /^https:\/\/\S+$/.test(s)) || (sourcesRequired && !sources.length)) {
    errors.push(`${where}: sources must be a list of https URLs${sourcesRequired ? ', at least one' : ''}`);
  }
  if (rule.reviewed === undefined ? sourcesRequired : !isDate(rule.reviewed)) errors.push(`${where}: reviewed must be a date (YYYY-MM-DD)`);
  return errors;
}

// The managed catalog: judgments npm metadata can't express. Reviewed, sourced, and replaced on upgrade.
export function validateCatalog(catalog) {
  if (!isObject(catalog)) return ['catalog: must be a JSON object'];
  const errors = [];
  unknownKeys(catalog, ['version', 'ecosystem', 'rules'], 'catalog', errors);
  if (catalog.version !== 1) errors.push('catalog: version must be 1');
  if (catalog.ecosystem !== 'npm') errors.push('catalog: ecosystem must be "npm"');
  if (!Array.isArray(catalog.rules)) return [...errors, 'catalog: rules must be a list'];
  catalog.rules.forEach((r, i) => errors.push(...validateRule(r, `catalog.rules[${i}]`, { sourcesRequired: true })));
  return errors;
}

export function validateWaiver(w, where, knownRules) {
  if (!isObject(w)) return [`${where}: must be an object`];
  const errors = [];
  unknownKeys(w, ['ruleId', 'package', 'owner', 'reason', 'expiresAt'], where, errors);
  for (const k of ['ruleId', 'package', 'owner', 'reason']) if (!nonEmpty(w[k])) errors.push(`${where}: ${k} is required`);
  if (nonEmpty(w.ruleId) && !knownRules.has(w.ruleId)) errors.push(`${where}: ruleId ${w.ruleId} is not a known rule`);
  if (nonEmpty(w.package) && w.package.includes('*')) errors.push(`${where}: package must name one package, not a pattern`);
  if (!isDate(w.expiresAt)) errors.push(`${where}: expiresAt must be a date (YYYY-MM-DD)`);
  return errors;
}

// A waiver lasts through the end of its expiresAt day, UTC, and stops working at the start of the next one.
export function waiverState(waiver, now = new Date()) {
  if (!isDate(waiver?.expiresAt)) return 'invalid';
  return now.getTime() < Date.parse(`${waiver.expiresAt}T00:00:00Z`) + 86_400_000 ? 'active' : 'expired';
}

// The project-owned configuration. Every field is optional; the defaults are the strict policy.
export const DEFAULT_CONFIG = Object.freeze({ auditLevel: 'moderate', deprecated: 'deny', outdated: 'warn', workspaces: [], signatures: false, rules: [], waivers: [] });

export function validateConfig(config, catalog) {
  if (!isObject(config)) return ['config: must be a JSON object'];
  const errors = [];
  unknownKeys(config, ['version', ...Object.keys(DEFAULT_CONFIG)], 'config', errors);
  if (config.version !== 1) errors.push('config: version must be 1');
  if (config.auditLevel !== undefined && !AUDIT_LEVELS.includes(config.auditLevel)) errors.push(`config: auditLevel must be one of ${AUDIT_LEVELS.join(', ')}`);
  if (config.deprecated !== undefined && !DEPRECATED_ACTIONS.includes(config.deprecated)) errors.push(`config: deprecated must be one of ${DEPRECATED_ACTIONS.join(', ')}`);
  if (config.outdated !== undefined && !OUTDATED_ACTIONS.includes(config.outdated)) errors.push(`config: outdated must be one of ${OUTDATED_ACTIONS.join(', ')}`);
  if (config.signatures !== undefined && typeof config.signatures !== 'boolean') errors.push('config: signatures must be true or false');
  if (config.workspaces !== undefined && !(Array.isArray(config.workspaces) && config.workspaces.every(nonEmpty))) errors.push('config: workspaces must be a list of workspace names');
  const own = config.rules ?? [];
  if (!Array.isArray(own)) errors.push('config: rules must be a list');
  else own.forEach((r, i) => errors.push(...validateRule(r, `config.rules[${i}]`, { sourcesRequired: false })));
  const ids = [...(catalog?.rules ?? []), ...(Array.isArray(own) ? own : [])].map((r) => r?.id).filter(Boolean);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`config: rule id ${id} is defined twice`);
  const waivers = config.waivers ?? [];
  if (!Array.isArray(waivers)) errors.push('config: waivers must be a list');
  else {
    const known = new Set([...BUILTIN_RULES, ...ids]);
    waivers.forEach((w, i) => errors.push(...validateWaiver(w, `config.waivers[${i}]`, known)));
  }
  return errors;
}

// A package name against a rule's matcher: an exact name, or a prefix when the matcher ends in *.
export function matchesPackage(matcher, name) {
  return matcher.endsWith('*') ? name.startsWith(matcher.slice(0, -1)) : matcher === name;
}

export function matchRules(rules, name) {
  return rules.filter((r) => (Array.isArray(r.package) ? r.package : [r.package]).some((m) => matchesPackage(m, name)));
}

// ---------- files ----------

// The project is the nearest folder, from the working directory upward, that holds a package.json.
export function findProjectRoot(from = process.cwd()) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (dir === path.dirname(dir)) return path.resolve(from);
  }
}

function readJson(file, what) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { fail(`${what} could not be read (${file}): ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { fail(`${what} is not valid JSON (${file}): ${e.message}`); }
}

// The vendored copy keeps catalog.json beside the script; the plugin's own copy keeps it in ../catalog/npm.json.
export function catalogPath(scriptDir = SCRIPT_DIR) {
  const vendored = path.join(scriptDir, 'catalog.json');
  return fs.existsSync(vendored) ? vendored : path.join(scriptDir, '..', 'catalog', 'npm.json');
}

export const configPath = (root) => path.join(root, '.dependency-guardian', 'config.json');

// Loads the catalog and the optional configuration, and fails (exit 2) on anything invalid.
export function loadPolicy(root, { scriptDir = SCRIPT_DIR } = {}) {
  const catalog = readJson(catalogPath(scriptDir), 'The npm catalog');
  const catalogErrors = validateCatalog(catalog);
  if (catalogErrors.length) fail(`The npm catalog is invalid:\n- ${catalogErrors.join('\n- ')}`);
  const file = configPath(root);
  const given = fs.existsSync(file) ? readJson(file, 'The configuration') : { version: 1 };
  const configErrors = validateConfig(given, catalog);
  if (configErrors.length) fail(`The configuration is invalid (${path.relative(root, file)}):\n- ${configErrors.join('\n- ')}`);
  const config = { ...DEFAULT_CONFIG, ...given };
  return { catalog, config, rules: [...catalog.rules, ...config.rules], configFile: fs.existsSync(file) ? file : null };
}

// ---------- commands ----------

const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const notYet = (name) => () => fail(`${name} is not implemented yet in dependency-guardian ${GUARDIAN_VERSION}.`);

const commands = {
  // Checks the catalog, the configuration and every waiver. Exit 2 when something is malformed, 1 when a waiver has expired.
  'validate-policy'(_pos, opts) {
    const root = findProjectRoot();
    const { catalog, config, rules, configFile } = loadPolicy(root);
    const waivers = config.waivers.map((w) => ({ ...w, state: waiverState(w) }));
    const expired = waivers.filter((w) => w.state === 'expired');
    const result = {
      status: expired.length ? 'fail' : 'pass',
      projectRoot: root,
      catalogRules: catalog.rules.length,
      configFile: configFile && path.relative(root, configFile),
      rules: rules.length,
      waivers: waivers.map((w) => ({ ruleId: w.ruleId, package: w.package, owner: w.owner, expiresAt: w.expiresAt, state: w.state })),
    };
    if (opts.json) out(result);
    else {
      process.stdout.write(`Policy is valid: ${rules.length} rule(s), ${waivers.length} waiver(s).\n`);
      for (const w of expired) process.stdout.write(`Expired waiver: ${w.ruleId} for ${w.package} (owner ${w.owner}, expired ${w.expiresAt}).\n`);
    }
    if (expired.length) process.exitCode = 1;
  },
  scan: notYet('scan'),
  preflight: notYet('preflight'),
  hook: notYet('hook'),
};

export function main(argv = process.argv.slice(2)) {
  const versionError = nodeVersionError(process.versions.node);
  if (versionError) {
    process.stderr.write(`dependency-guardian: ${versionError}\n`);
    process.exit(2);
  }
  const [cmd, ...args] = argv;
  if (!cmd || !commands[cmd]) {
    process.stderr.write(`Usage: guardian.mjs <${Object.keys(commands).join('|')}> [--ci] [--json] [--workspace <name>] [--signatures] [--offline] [-- <npm arguments>]\n`);
    process.exit(2);
  }
  try {
    const { pos, opts, rest } = parseArgs(args);
    commands[cmd](pos, opts, rest);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    process.stderr.write(`dependency-guardian: ${e.message}\n`);
    process.exit(2);
  }
}

// Compare real paths: a symlinked folder (macOS's /tmp, a linked project) must not make the script silently do nothing.
const realPath = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
if (process.argv[1] && realPath(process.argv[1]) === realPath(SCRIPT_FILE)) main();
