#!/usr/bin/env node
// guardian.mjs — npm dependency guard. Zero dependencies: only node: built-ins, so the file can be vendored into
// any repository (`.dependency-guardian/guardian.mjs`) and run in CI as it is.
//
// Exit codes: 0 passed, 1 blocking policy findings, 2 invalid configuration, unsupported input or an incomplete
// assessment. `hook` never exits 1, because agents treat that as a non-blocking error.

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARDIAN_VERSION = '0.3.0';
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
export const BUILTIN_RULES = ['GUARD-AUDIT', 'GUARD-DEPRECATED', 'GUARD-OUTDATED', 'GUARD-SOURCE', 'GUARD-SIGNATURE', 'GUARD-WAIVER'];
// Findings about waivers themselves: an expired waiver can't waive its own expiry.
const UNWAIVABLE = ['GUARD-WAIVER'];
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
  if (UNWAIVABLE.includes(w.ruleId)) errors.push(`${where}: ${w.ruleId} cannot be waived`);
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

// ---------- npm ----------

// Credentials never reach output: npm's own error text can echo a registry URL or a token from .npmrc.
export function redact(text) {
  return String(text ?? '')
    .replace(/(\/\/[^\s:]+\/?:_(?:authToken|auth|password)\s*=\s*)\S+/gi, '$1[redacted]')
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[redacted]');
}

// Runs npm without a shell and never throws on a non-zero exit: `npm audit` and `npm outdated` exit 1 on findings.
function npm(args, cwd, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile('npm', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return resolve({ code: 'ENOENT', stdout: '', stderr: 'npm was not found on PATH' });
      if (error?.killed) return resolve({ code: 'TIMEOUT', stdout: stdout ?? '', stderr: `npm ${args[0]} timed out` });
      resolve({ code: error ? error.code : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

const tryJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// ---------- project: package.json and package-lock.json ----------

const DEP_TYPES = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const rank = (sev) => SEVERITIES.indexOf(sev);
const NODE_MODULES = 'node_modules/';

// Reads the lockfile's package list. Only lockfile v2 and v3 name every package with its version.
export function readLockfile(root) {
  const file = path.join(root, 'package-lock.json');
  if (!fs.existsSync(file)) fail('package-lock.json is missing. The scan assesses the locked dependency tree. Create one without running install scripts: npm install --package-lock-only --ignore-scripts');
  const lock = readJson(file, 'package-lock.json');
  if (!isObject(lock.packages)) fail(`package-lock.json has lockfileVersion ${lock.lockfileVersion ?? 'unknown'}, which this version cannot read. Upgrade it without running install scripts: npm install --package-lock-only --ignore-scripts`);
  const packages = [];
  const workspaces = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || !isObject(entry)) continue;
    const at = key.lastIndexOf(NODE_MODULES);
    if (at === -1) { workspaces.push(key); continue; }
    if (entry.link) continue;
    const name = key.slice(at + NODE_MODULES.length);
    packages.push({ name, version: entry.version, key, resolved: entry.resolved, deprecated: typeof entry.deprecated === 'string' ? entry.deprecated : null, dev: Boolean(entry.dev) });
  }
  return { packages, workspaces };
}

// The direct dependencies of the selected workspaces (or of the root and every workspace), with the section each is in.
export function directDependencies(root, lock, selection) {
  const sources = [];
  const rootPkg = readJson(path.join(root, 'package.json'), 'package.json');
  const named = lock.workspaces.map((dir) => ({ dir, pkg: readJson(path.join(root, dir, 'package.json'), `${dir}/package.json`) }));
  if (selection.length) {
    for (const want of selection) if (!named.some((w) => w.pkg.name === want)) fail(`Unknown workspace "${want}". Workspaces: ${named.map((w) => w.pkg.name).join(', ') || 'none'}`);
    sources.push(...named.filter((w) => selection.includes(w.pkg.name)));
  } else sources.push({ dir: '', pkg: rootPkg }, ...named);
  const direct = new Map();
  for (const { dir, pkg } of sources) {
    for (const type of DEP_TYPES) for (const name of Object.keys(pkg[type] ?? {})) {
      if (!direct.has(name)) direct.set(name, { type, prefixes: new Set() });
      // npm hoists a workspace's dependencies to the root node_modules unless versions clash.
      direct.get(name).prefixes.add(`${NODE_MODULES}${name}`).add(`${dir ? `${dir}/` : ''}${NODE_MODULES}${name}`);
    }
  }
  return direct;
}

const isRegistryTarball = (resolved) => {
  try { const u = new URL(resolved); return /^https?:$/.test(u.protocol) && u.pathname.includes('/-/'); } catch { return false; }
};

// ---------- findings ----------

const finding = (f) => ({ waiver: null, alternatives: [], remediation: [], ...f });
const idOf = (rule, pkg, version) => `${rule}:${pkg}${version ? `@${version}` : ''}`;

function catalogFindings(entries, rules) {
  const found = [];
  for (const e of entries) {
    for (const rule of matchRules(rules, e.name)) {
      const action = e.direct ? rule.direct : rule.transitive;
      if (action === 'allow') continue;
      found.push(finding({
        id: idOf(rule.id, e.name, e.version), rule: rule.id, source: 'catalog', package: e.name, version: e.version,
        relationship: e.direct ? 'direct' : 'transitive', dependencyType: e.type, severity: action === 'deny' ? 'high' : 'low', action,
        evidence: [rule.rationale, ...(rule.sources ?? []).map((u) => `Source: ${u}`)],
        alternatives: rule.alternatives ?? [],
        remediation: action === 'deny' ? [`Remove ${e.name}${e.direct ? '' : ' (it is pulled in by another package)'}, or choose an alternative`] : [],
      }));
    }
  }
  return found;
}

function sourceFindings(entries) {
  return entries.filter((e) => e.resolved && !isRegistryTarball(e.resolved)).map((e) => finding({
    id: idOf('GUARD-SOURCE', e.name, e.version), rule: 'GUARD-SOURCE', source: 'lockfile', package: e.name, version: e.version,
    relationship: e.direct ? 'direct' : 'transitive', dependencyType: e.type, severity: 'high', action: 'deny',
    evidence: [`Installed from ${redact(e.resolved)}, not from a registry, so npm audit and npm view cannot assess it`],
    remediation: ['Publish it to a registry, or waive GUARD-SOURCE for this package with an owner, a reason and an expiry'],
  }));
}

function deprecationFinding(e, message, action) {
  return finding({
    id: idOf('GUARD-DEPRECATED', e.name, e.version), rule: 'GUARD-DEPRECATED', source: e.viaRegistry ? 'npm-view' : 'lockfile', package: e.name, version: e.version,
    relationship: e.direct ? 'direct' : 'transitive', dependencyType: e.type, severity: action === 'deny' ? 'high' : 'low', action,
    evidence: [redact(message)], remediation: [`Replace ${e.name}, or move to a version that is not deprecated`],
  });
}

function auditFindings(report, byName, level) {
  const found = [];
  for (const v of Object.values(report.vulnerabilities)) {
    const entry = byName.get(v.name);
    const blocking = rank(v.severity) >= rank(level);
    const fix = v.fixAvailable;
    found.push(finding({
      id: idOf('GUARD-AUDIT', v.name, entry?.version), rule: 'GUARD-AUDIT', source: 'npm-audit', package: v.name, version: entry?.version ?? null,
      relationship: v.isDirect ? 'direct' : 'transitive', dependencyType: entry?.type ?? 'transitive', severity: v.severity, action: blocking ? 'deny' : 'info',
      evidence: (v.via ?? []).map((x) => (isObject(x) ? `${x.title} (${x.url}) [${x.severity}]` : `Through ${x}`)),
      remediation: isObject(fix)
        ? [`npm install ${fix.name}@${fix.version}${fix.isSemVerMajor ? ' (major update, breaking changes possible)' : ''}`]
        : [fix === true ? 'npm audit fix' : 'No fix is available yet'],
    }));
  }
  return found;
}

// Active waivers make a blocking finding non-blocking and stay visible on it. An expired one blocks, with a finding of its own.
export function applyWaivers(findings, waivers, now = new Date()) {
  for (const f of findings) {
    const w = f.action === 'deny' ? waivers.find((x) => x.ruleId === f.rule && x.package === f.package) : null;
    if (w) f.waiver = { state: waiverState(w, now), owner: w.owner, reason: w.reason, expiresAt: w.expiresAt };
  }
  const expired = waivers.filter((w) => waiverState(w, now) === 'expired').map((w) => finding({
    id: idOf('GUARD-WAIVER', w.package) + `:${w.ruleId}`, rule: 'GUARD-WAIVER', source: 'waiver', package: w.package, version: null,
    relationship: 'direct', dependencyType: null, severity: 'high', action: 'deny',
    evidence: [`The waiver of ${w.ruleId} for ${w.package} (owner ${w.owner}) expired on ${w.expiresAt}: ${w.reason}`],
    remediation: ['Fix the finding and remove the waiver, or have its owner renew it with a new expiry'],
  }));
  return [...findings, ...expired];
}

const isBlocking = (f) => f.action === 'deny' && f.waiver?.state !== 'active';

// ---------- scan ----------

export async function scan(root, { ci = false, signatures = false, offline = false, workspace } = {}) {
  const { config, rules } = loadPolicy(root);
  const lock = readLockfile(root);
  const selection = workspace ? [workspace] : config.workspaces;
  const direct = directDependencies(root, lock, selection);
  const entries = lock.packages.map((p) => {
    const d = direct.get(p.name);
    const isDirect = Boolean(d) && [...d.prefixes].includes(p.key);
    return { ...p, direct: isDirect, type: isDirect ? d.type : 'transitive' };
  });
  const byName = new Map();
  for (const e of entries) if (!byName.has(e.name) || e.direct) byName.set(e.name, e);

  const errors = [];
  const wsArgs = selection.flatMap((w) => [`--workspace=${w}`]);
  const found = [...catalogFindings(entries, rules), ...sourceFindings(entries)];
  let npmVersion = null;

  // Deprecation. The lockfile records it for every package; direct ones are also asked of the registry, which is fresher.
  const deprecation = new Map();
  for (const e of entries) if (e.deprecated) deprecation.set(`${e.name}@${e.version}`, { e, message: e.deprecated });
  if (!offline) {
    const registry = entries.filter((e) => e.direct && e.resolved && isRegistryTarball(e.resolved));
    const views = await mapLimit(registry, 4, async (e) => ({ e, r: await npm(['view', `${e.name}@${e.version}`, 'deprecated', '--json'], root) }));
    for (const { e, r } of views) {
      const text = r.stdout.trim();
      const parsed = text ? tryJson(text) : '';
      if (r.code !== 0 || parsed === undefined || isObject(parsed)) errors.push(`npm view ${e.name}@${e.version} failed: ${redact((isObject(parsed) && parsed.error?.summary) || r.stderr || r.code).toString().trim().split('\n')[0]}`);
      else if (typeof parsed === 'string' && parsed) deprecation.set(`${e.name}@${e.version}`, { e: { ...e, viaRegistry: true }, message: parsed });
    }
  }
  for (const { e, message } of deprecation.values()) found.push(deprecationFinding(e, message, e.direct ? config.deprecated : 'warn'));

  if (!offline) {
    const v = await npm(['--version'], root);
    if (v.code === 0) npmVersion = v.stdout.trim();
    else errors.push(redact(v.stderr).trim() || 'npm could not be run');

    const audit = await npm(['audit', '--json', `--audit-level=${config.auditLevel}`, ...wsArgs], root);
    const report = tryJson(audit.stdout);
    if (report === undefined || report.error || report.message && !report.vulnerabilities) errors.push(`npm audit failed: ${redact(report?.message || report?.error?.summary || audit.stderr || audit.code).toString().trim().split('\n')[0]}`);
    else if (report.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) fail(`npm audit returned output this version cannot read (auditReportVersion ${report.auditReportVersion ?? 'missing'}). Use npm 7 or later.`);
    else found.push(...auditFindings(report, byName, config.auditLevel));

    if (config.outdated !== 'off') {
      const outdated = await npm(['outdated', '--json', ...wsArgs], root);
      const list = outdated.stdout.trim() ? tryJson(outdated.stdout) : {};
      if (!isObject(list)) errors.push(`npm outdated failed: ${redact(outdated.stderr || outdated.code).toString().trim().split('\n')[0]}`);
      else for (const [name, info] of Object.entries(list)) {
        const e = byName.get(name);
        for (const i of [info].flat()) {
          const current = i.current ?? e?.version;
          if (!e?.direct || !i.latest || current === i.latest) continue;
          found.push(finding({
            id: idOf('GUARD-OUTDATED', name, current), rule: 'GUARD-OUTDATED', source: 'npm-outdated', package: name, version: current,
            relationship: 'direct', dependencyType: e.type, severity: 'low', action: config.outdated,
            evidence: [`${current} is installed; the latest is ${i.latest}${i.wanted && i.wanted !== current ? ` (${i.wanted} satisfies the range)` : ''}`],
            remediation: [`npm install ${name}@${i.latest}`],
          }));
        }
      }
    }

    if (signatures || config.signatures) {
      const sig = await npm(['audit', 'signatures', '--json', ...wsArgs], root);
      const report2 = tryJson(sig.stdout);
      if (!isObject(report2) || (!Array.isArray(report2.invalid) && !Array.isArray(report2.missing))) errors.push(`npm audit signatures failed: ${redact(report2?.error?.summary || sig.stderr || sig.code).toString().trim().split('\n')[0]}`);
      else {
        for (const [list, action, what] of [[report2.invalid ?? [], 'deny', 'has an invalid registry signature'], [report2.missing ?? [], config.signatures ? 'deny' : 'warn', 'has no registry signature']]) {
          for (const x of list) {
            const e = byName.get(x.name);
            found.push(finding({
              id: idOf('GUARD-SIGNATURE', x.name, x.version), rule: 'GUARD-SIGNATURE', source: 'npm-signatures', package: x.name, version: x.version,
              relationship: e?.direct ? 'direct' : 'transitive', dependencyType: e?.type ?? 'transitive', severity: action === 'deny' ? 'high' : 'low', action,
              evidence: [`${x.name}@${x.version} ${what}`],
            }));
          }
        }
      }
    }
  }

  const findings = applyWaivers(found, config.waivers);
  const blocking = findings.filter(isBlocking).length;
  let status = blocking ? 'fail' : 'pass';
  if (!blocking && errors.length) status = 'error';
  if (!blocking && offline && ci) { status = 'error'; errors.push('An offline scan skips the registry checks, so it cannot pass strict CI.'); }
  return {
    schemaVersion: 1, status, projectRoot: root, offline, complete: !offline && !errors.length,
    toolVersions: { guardian: GUARDIAN_VERSION, node: process.versions.node, npm: npmVersion },
    summary: {
      packages: entries.length, direct: entries.filter((e) => e.direct).length, blocking,
      warnings: findings.filter((f) => f.action === 'warn').length, informational: findings.filter((f) => f.action === 'info').length,
      waived: findings.filter((f) => f.waiver?.state === 'active').length,
    },
    errors, findings,
  };
}

export function formatScan(result) {
  const head = { pass: 'PASS', fail: 'FAIL', error: 'ERROR' }[result.status];
  const s = result.summary;
  const lines = [`dependency-guardian ${GUARDIAN_VERSION}: ${head}: ${s.blocking} blocking, ${s.warnings} warning(s), ${s.informational} informational, ${s.waived} waived (${s.direct} direct of ${s.packages} packages)`];
  if (result.offline) lines.push('Offline: only the catalog and the lockfile were checked. Audit, outdated and registry checks were skipped.');
  const order = (f) => [isBlocking(f) ? 0 : f.action === 'warn' ? 1 : f.waiver ? 2 : 3, f.package];
  for (const f of [...result.findings].sort((a, b) => { const [x, y] = [order(a), order(b)]; return x[0] - y[0] || x[1].localeCompare(y[1]); })) {
    const tag = isBlocking(f) ? 'BLOCK' : f.waiver?.state === 'active' ? 'WAIVED' : f.action === 'warn' ? 'warn' : 'info';
    lines.push(`${tag.padEnd(6)} ${f.rule} ${f.package}${f.version ? `@${f.version}` : ''} (${f.relationship}${f.dependencyType && f.dependencyType !== 'transitive' ? `, ${f.dependencyType}` : ''}, ${f.severity})`);
    for (const e of f.evidence) lines.push(`         ${e}`);
    if (f.waiver) lines.push(`         Waiver: ${f.waiver.state}, owner ${f.waiver.owner}, until ${f.waiver.expiresAt}: ${f.waiver.reason}`);
    if (f.alternatives.length) lines.push(`         Alternatives: ${f.alternatives.map((a) => `${a.name} (${a.use})`).join('; ')}`);
    for (const r of f.remediation) lines.push(`         Fix: ${r}`);
  }
  for (const e of result.errors) lines.push(`ERROR  ${e}`);
  return `${lines.join('\n')}\n`;
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
  async scan(_pos, opts) {
    const result = await scan(findProjectRoot(), opts);
    process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatScan(result));
    process.exitCode = { pass: 0, fail: 1, error: 2 }[result.status];
  },
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
  let opts = {};
  const onError = (e) => {
    if (!(e instanceof UserError)) throw e;
    // A scan that cannot finish still answers in its own format when JSON was asked for.
    if (cmd === 'scan' && opts.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'error', error: e.message, errors: [e.message], findings: [] }, null, 2)}\n`);
    process.stderr.write(`dependency-guardian: ${e.message}\n`);
    process.exit(2);
  };
  try {
    const parsed = parseArgs(args);
    opts = parsed.opts;
    Promise.resolve(commands[cmd](parsed.pos, parsed.opts, parsed.rest)).catch(onError);
  } catch (e) { onError(e); }
}

// Compare real paths: a symlinked folder (macOS's /tmp, a linked project) must not make the script silently do nothing.
const realPath = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
if (process.argv[1] && realPath(process.argv[1]) === realPath(SCRIPT_FILE)) main();
