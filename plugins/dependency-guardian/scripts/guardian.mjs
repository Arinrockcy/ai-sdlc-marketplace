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

export const GUARDIAN_VERSION = '0.4.0';
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

// ---------- command parsing ----------

// parseCommandLine(line, { cwd }) reads a shell command line and says which of its npm commands change dependencies,
// which packages they add, and which parts it cannot judge. It is pure: it runs nothing, reads no file and expands
// nothing, so `$(…)` and `$VAR` stay what they are, unknown values.
//
// Result: { actions, unjudgeable }.
// - `actions` lists each dependency-changing npm command, in order: `install` (also add, i, install-test, …), `update`,
//   `ci`, `audit-fix`, and `exec` (npx, npm exec, npm init <initializer>). An action carries `tool`, `command`, `via`
//   (`init` for npm init), `raw`, `dir` (where npm looks for the project, upward from there; null for a global
//   install), `global`, `workspaces`, `allWorkspaces`, `includeWorkspaceRoot`, `force` and `packages`
//   ({ spec, name, range, alias }). Other npm commands, and commands that are not npm, produce nothing, so
//   `npm install && npm test` yields one action.
// - `unjudgeable` lists what the hook must fail closed on, each as { kind, reason, text }: a package name or option
//   value the shell expands at run time, a git, URL or path source, an unknown option that might swallow a package,
//   a working directory that `cd` left unknown, and wrappers or shell strings the parser cannot see through.
//
// Understood: quoting, `\` escapes, `;` `&&` `||` `|` `&` and newlines, `( … )` subshells, `$(…)` and backticks
// (parsed as commands of their own), redirections and here-documents, comments, `cd` and `pushd`, `NAME=value`
// prefixes, `export`, and the wrappers env, sudo, doas, time, command, exec, nohup, nice, timeout, setsid, stdbuf,
// corepack and xargs, plus `bash -c '…'` and `eval`. A dynamic command name or string is flagged only when the line
// also names a dependency verb or npm, so `eval "$(ssh-agent)"` passes.
// Not understood, and out of scope: what a script, `npm run`, an alias or `curl | sh` runs. The CI scan backs those up.

const MAX_NESTING = 8;

class Unparseable extends Error {}

function skipSingle(src, i) {
  const end = src.indexOf("'", i + 1);
  if (end < 0) throw new Unparseable("unterminated '");
  return end;
}
function skipBacktick(src, i) {
  for (let k = i + 1; k < src.length; k++) {
    if (src[k] === '\\') k++;
    else if (src[k] === '`') return k;
  }
  throw new Unparseable('unterminated `');
}
function skipDouble(src, i) {
  for (let k = i + 1; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') k++;
    else if (c === '"') return k;
    else if (c === '`') k = skipBacktick(src, k);
    else if (c === '$' && src[k + 1] === '(') k = matchParen(src, k + 1);
  }
  throw new Unparseable('unterminated "');
}
// Index of the `)` closing the `(` at `open`.
function matchParen(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') k++;
    else if (c === "'") k = skipSingle(src, k);
    else if (c === '"') k = skipDouble(src, k);
    else if (c === '`') k = skipBacktick(src, k);
    else if (c === '#' && /\s/.test(src[k - 1] ?? ' ')) {
      const nl = src.indexOf('\n', k);
      if (nl < 0) break;
      k = nl;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
  }
  throw new Unparseable('unterminated $(');
}
// Index of the `}` closing the `{` at `open`.
function matchBrace(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') k++;
    else if (c === "'") k = skipSingle(src, k);
    else if (c === '"') k = skipDouble(src, k);
    else if (c === '`') k = skipBacktick(src, k);
    else if (c === '$' && src[k + 1] === '(') k = matchParen(src, k + 1);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  throw new Unparseable('unterminated ${');
}
const unescapeBacktick = (s) => s.replace(/\\([`$\\])/g, '$1');
// Every command substitution in `text`. In a here-document body quotes are plain text.
function scanSubs(text, { literalQuotes = false } = {}) {
  const subs = [];
  let inDouble = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') k++;
    else if (c === '$' && text[k + 1] === '(') { const end = matchParen(text, k + 1); subs.push(text.slice(k + 2, end)); k = end; }
    else if (c === '`') { const end = skipBacktick(text, k); subs.push(unescapeBacktick(text.slice(k + 1, end))); k = end; }
    else if (literalQuotes) continue;
    else if (c === '"') inDouble = !inDouble;
    else if (c === "'" && !inDouble) k = skipSingle(text, k);
  }
  return subs;
}

// The expansion that starts at src[i] ('$' or a backtick), added to word `w`. Returns the index after it.
function expansion(src, i, w) {
  const note = (reason) => { if (!w.dynamic.includes(reason)) w.dynamic.push(reason); };
  if (src[i] === '`') {
    const end = skipBacktick(src, i);
    w.subs.push(unescapeBacktick(src.slice(i + 1, end)));
    note('substitution');
    w.text += src.slice(i, end + 1);
    return end + 1;
  }
  const n = src[i + 1];
  if (n === '(') {
    const end = matchParen(src, i + 1);
    w.subs.push(src.slice(i + 2, end));
    note('substitution');
    w.text += src.slice(i, end + 1);
    return end + 1;
  }
  if (n === '{') {
    const end = matchBrace(src, i + 1);
    w.subs.push(...scanSubs(src.slice(i + 2, end)));
    note('variable');
    w.text += src.slice(i, end + 1);
    return end + 1;
  }
  if (n && /[A-Za-z0-9_@*#?$!-]/.test(n)) {
    let k = i + 2;
    if (/[A-Za-z_]/.test(n)) while (k < src.length && /[A-Za-z0-9_]/.test(src[k])) k++;
    note('variable');
    w.text += src.slice(i, k);
    return k;
  }
  w.text += '$';
  return i + 1;
}

// Tokens: words ({ t: 'word', text, raw, quoted, dynamic: [reasons], subs: [command text] }), operators
// ({ t: 'op', op }) and redirections ({ t: 'redir', op }), which the word after them completes.
function tokenize(src) {
  const tokens = [];
  const pending = [];
  let w = null;
  let i = 0;
  const start = () => { w ??= { t: 'word', text: '', raw: '', from: i, quoted: false, dynamic: [], subs: [] }; return w; };
  const note = (reason) => { if (!start().dynamic.includes(reason)) w.dynamic.push(reason); };
  const flush = () => {
    if (!w) return;
    w.raw = src.slice(w.from, i);
    const prev = tokens[tokens.length - 1];
    if (prev?.t === 'redir' && prev.heredoc) pending.push({ delim: w.text, strip: prev.heredoc === '<<-', quoted: w.quoted });
    tokens.push(w);
    w = null;
  };
  const op = (o) => tokens.push({ t: 'op', op: o });

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush(); op('\n'); i++;
      for (const h of pending.splice(0)) i = readHeredoc(src, i, h, tokens);
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      start().quoted = true;
      w.text += src[i + 1] ?? '\\';
      i += 2;
      continue;
    }
    if (c === "'") { const end = skipSingle(src, i); start().quoted = true; w.text += src.slice(i + 1, end); i = end + 1; continue; }
    if (c === '"') {
      start().quoted = true;
      i++;
      for (;;) {
        if (i >= src.length) throw new Unparseable('unterminated "');
        const d = src[i];
        if (d === '"') { i++; break; }
        if (d === '\\') {
          const e = src[i + 1];
          if (e === '\n') { i += 2; continue; }
          if (e && '$`"\\'.includes(e)) { w.text += e; i += 2; continue; }
          w.text += d; i++;
        } else if (d === '$' || d === '`') i = expansion(src, i, w);
        else { w.text += d; i++; }
      }
      continue;
    }
    if (c === '$') {
      const n = src[i + 1];
      if (n === '"') { i++; continue; }
      if (n === "'") {
        start();
        note('ansi-c quoting');
        let k = i + 2;
        while (k < src.length && src[k] !== "'") k += src[k] === '\\' ? 2 : 1;
        if (k >= src.length) throw new Unparseable("unterminated $'");
        w.text += src.slice(i, k + 1);
        i = k + 1;
        continue;
      }
      i = expansion(src, i, start());
      continue;
    }
    if (c === '`') { i = expansion(src, i, start()); continue; }
    if (c === '#' && !w) { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === ';') { flush(); if (src[i + 1] === ';') { op(';;'); i += 2; } else { op(';'); i++; } continue; }
    if (c === '&') {
      flush();
      if (src[i + 1] === '&') { op('&&'); i += 2; } else if (src[i + 1] === '>') i++; else { op('&'); i++; }
      continue;
    }
    if (c === '|') {
      flush();
      const o = src.startsWith('||', i) ? '||' : src.startsWith('|&', i) ? '|&' : '|';
      op(o); i += o.length;
      continue;
    }
    if (c === '(' || c === ')') { flush(); op(c); i++; continue; }
    if (c === '<' || c === '>') {
      if (src[i + 1] === '(') {
        const end = matchParen(src, i + 1);
        start().subs.push(src.slice(i + 2, end));
        note('substitution');
        w.text += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (w && !w.quoted && /^\d+$/.test(w.text)) w = null; else flush();
      const o = c === '>'
        ? ['>>', '>&', '>|'].find((x) => src.startsWith(x, i)) ?? '>'
        : ['<<<', '<<-', '<<', '<&', '<>'].find((x) => src.startsWith(x, i)) ?? '<';
      tokens.push({ t: 'redir', op: o, heredoc: o === '<<' || o === '<<-' ? o : null });
      i += o.length;
      continue;
    }
    if (c === '*' || c === '?' || c === '[') note('glob');
    else if (c === '~' && (!w || (w.text === '' && !w.quoted))) note('tilde');
    else if (c === '{' && /^\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/.test(src.slice(i))) note('brace expansion');
    start().text += c;
    i++;
  }
  flush();
  return tokens;
}

// Skips a here-document body. An unquoted delimiter lets the body run command substitutions, so they become a word.
function readHeredoc(src, from, h, tokens) {
  let i = from;
  let body = '';
  while (i < src.length) {
    let end = src.indexOf('\n', i);
    if (end < 0) end = src.length;
    const line = src.slice(i, end);
    i = Math.min(end + 1, src.length);
    if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
    body += `${line}\n`;
  }
  const subs = h.quoted ? [] : scanSubs(body, { literalQuotes: true });
  if (subs.length) {
    tokens.push({ t: 'word', text: '<heredoc>', raw: '<heredoc>', quoted: true, dynamic: [], subs });
    tokens.push({ t: 'op', op: '\n' });
  }
  return i;
}

// ----- npm command words -----

const NPM_COMMANDS = ['access', 'adduser', 'audit', 'bugs', 'cache', 'ci', 'completion', 'config', 'dedupe', 'deprecate', 'diff', 'dist-tag', 'docs', 'doctor', 'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'get', 'help', 'help-search', 'init', 'install', 'install-ci-test', 'install-test', 'link', 'll', 'login', 'logout', 'ls', 'org', 'outdated', 'owner', 'pack', 'ping', 'pkg', 'prefix', 'profile', 'prune', 'publish', 'query', 'rebuild', 'repo', 'restart', 'root', 'run-script', 'sbom', 'search', 'set', 'shrinkwrap', 'star', 'stars', 'start', 'stop', 'team', 'test', 'token', 'undeprecate', 'uninstall', 'unpublish', 'unstar', 'update', 'version', 'view', 'whoami'];
const NPM_ALIASES = {
  add: 'install', i: 'install', in: 'install', ins: 'install', inst: 'install', insta: 'install', instal: 'install', isnt: 'install', isnta: 'install', isntal: 'install', isntall: 'install',
  it: 'install-test', cit: 'install-ci-test', 'clean-install': 'ci', ic: 'ci', 'install-clean': 'ci', 'isntall-clean': 'ci',
  up: 'update', upgrade: 'update', udpate: 'update', x: 'exec', create: 'init', innit: 'init',
  author: 'owner', home: 'docs', issues: 'bugs', info: 'view', show: 'view', v: 'view', rm: 'uninstall', r: 'uninstall', un: 'uninstall', unlink: 'uninstall', remove: 'uninstall',
  rum: 'run-script', run: 'run-script', urn: 'run-script', t: 'test', tst: 'test', ln: 'link', find: 'search', s: 'search', se: 'search', list: 'ls', la: 'ls',
  'dist-tags': 'dist-tag', ddp: 'dedupe', c: 'config', verison: 'version',
};
// npm resolves a command word by exact name, alias or unique abbreviation; one that is ambiguous is an error and runs nothing.
export function canonicalNpmCommand(word) {
  const s = word.toLowerCase();
  if (!s) return null;
  if (NPM_ALIASES[s]) return NPM_ALIASES[s];
  if (NPM_COMMANDS.includes(s)) return s;
  const targets = new Set([...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)].filter((n) => n.startsWith(s)).map((n) => NPM_ALIASES[n] ?? n));
  return targets.size === 1 ? [...targets][0] : null;
}
const isDependencyCommand = (cmd) => ['install', 'install-test', 'ci', 'install-ci-test', 'update', 'audit', 'exec', 'init'].includes(cmd);

// ----- npm options -----

const SHORT_BOOL = { g: 'global', S: 'save', D: 'save-dev', O: 'save-optional', P: 'save-prod', E: 'save-exact', B: 'save-bundle', f: 'force', d: 'loglevel', s: 'silent', q: 'quiet', y: 'yes', n: 'no', h: 'help', H: 'help', '?': 'help', l: 'long', p: 'parseable', v: 'version', a: 'all' };
const SHORT_VALUE = { w: 'workspace', C: 'prefix', c: 'call', m: 'message' };
const SHORT_WORDS = { ws: 'workspaces', iwr: 'include-workspace-root', dd: 'loglevel', ddd: 'loglevel', porcelain: 'porcelain' };
const BOOL_LONG = new Set(['global', 'save', 'save-dev', 'save-prod', 'save-optional', 'save-exact', 'save-bundle', 'force', 'dry-run', 'ignore-scripts', 'audit', 'fund', 'package-lock', 'package-lock-only', 'legacy-peer-deps', 'strict-peer-deps', 'workspaces', 'include-workspace-root', 'yes', 'no', 'offline', 'prefer-offline', 'prefer-online', 'json', 'silent', 'quiet', 'verbose', 'long', 'parseable', 'color', 'progress', 'update-notifier', 'global-style', 'legacy-bundling', 'bin-links', 'foreground-scripts', 'install-links', 'engine-strict', 'production', 'dev', 'optional', 'omit-lockfile-registry-resolved', 'help', 'version', 'all', 'unicode', 'prefer-dedupe', 'workspaces-update', 'allow-same-version', 'git-tag-version', 'commit-hooks', 'if-present', 'timing', 'strict-ssl', 'sign-git-tag', 'sign-git-commit', 'porcelain', 'loglevel', 'before-install', 'fix-dry-run', 'node-gyp']);
const VALUE_LONG = new Set(['prefix', 'workspace', 'registry', 'tag', 'save-prefix', 'omit', 'include', 'install-strategy', 'cache', 'loglevel', 'userconfig', 'globalconfig', 'audit-level', 'scope', 'otp', 'before', 'min-release-age', 'package', 'call', 'location', 'lockfile-version', 'script-shell', 'shell', 'node-options', 'access', 'message', 'logs-dir', 'logs-max', 'maxsockets', 'proxy', 'https-proxy', 'noproxy', 'cafile', 'ca', 'cert', 'key', 'local-address', 'user-agent', 'tag-version-prefix', 'searchlimit', 'searchopts', 'format-package-lock', 'replace-registry-host', 'libc', 'os', 'cpu', 'depth', 'heading', 'cidr', 'cache-min', 'cache-max', 'fetch-timeout', 'fetch-retries', 'fetch-retry-factor', 'fetch-retry-mintimeout', 'fetch-retry-maxtimeout', 'umask', 'tmp', 'onload-script', 'init-module', 'init-author-name', 'init-author-email', 'init-author-url', 'init-license', 'init-version', 'diff', 'diff-name-only', 'diff-unified', 'diff-ignore-all-space', 'diff-no-prefix', 'diff-src-prefix', 'diff-dst-prefix', 'diff-text', 'sbom-format', 'sbom-type', 'json-stringify']);
const isValueOption = (name) => VALUE_LONG.has(name) || /^@[^:\s]+:registry$/.test(name);
// Options that decide which project, which registry or which packages a command touches.
const RESOLUTION_OPTIONS = ['prefix', 'global', 'location', 'workspace', 'workspaces', 'include-workspace-root', 'registry', 'userconfig', 'globalconfig'];

const valueOf = (text, dynamic, raw) => ({ text, dynamic, raw });

// Splits npm's arguments into options and positionals. `exec` makes -p take a package; `stopAfter` ends parsing once that
// many positionals were seen, because what follows belongs to the program being run.
function readOptions(args, { exec = false, stopAfter = Infinity } = {}) {
  const opts = [];
  const positionals = [];
  const ambiguous = [];
  let ended = false;
  const unknown = (name, next) => {
    if (next && !ended && (!next.text.startsWith('-') || next.dynamic.length)) ambiguous.push({ name, next: next.raw });
    opts.push({ name, value: true });
  };
  for (let j = 0; j < args.length && positionals.length < stopAfter; j++) {
    const w = args[j];
    const t = w.text;
    if (ended || !t.startsWith('-') || t === '-') { positionals.push(w); continue; }
    if (t === '--') { ended = true; continue; }
    const dyn = w.dynamic.length > 0;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (eq >= 0) opts.push({ name, value: valueOf(t.slice(eq + 1), dyn, w.raw) });
      else if (name === 'no-install') opts.push({ name: 'no', value: true });
      else if (name.startsWith('no-') && (BOOL_LONG.has(name.slice(3)) || isValueOption(name.slice(3)))) opts.push({ name: name.slice(3), value: false });
      else if (isValueOption(name)) { opts.push({ name, value: args[j + 1] ? valueOf(args[j + 1].text, args[j + 1].dynamic.length > 0, args[j + 1].raw) : null }); j++; }
      else if (BOOL_LONG.has(name)) opts.push({ name, value: true });
      else unknown(name, args[j + 1]);
      continue;
    }
    const eq = t.indexOf('=');
    const head = eq < 0 ? t.slice(1) : t.slice(1, eq);
    if (SHORT_WORDS[head]) { opts.push({ name: SHORT_WORDS[head], value: eq < 0 ? true : valueOf(t.slice(eq + 1), dyn, w.raw) }); continue; }
    for (let k = 0; k < head.length; k++) {
      const ch = head[k];
      const name = SHORT_VALUE[ch] ?? (exec && ch === 'p' ? 'package' : null);
      if (name) {
        if (k < head.length - 1) opts.push({ name, value: valueOf(head.slice(k + 1), dyn, w.raw) });
        else if (eq >= 0) opts.push({ name, value: valueOf(t.slice(eq + 1), dyn, w.raw) });
        else { opts.push({ name, value: args[j + 1] ? valueOf(args[j + 1].text, args[j + 1].dynamic.length > 0, args[j + 1].raw) : null }); j++; }
        break;
      }
      if (SHORT_BOOL[ch]) opts.push({ name: SHORT_BOOL[ch], value: true });
      else { unknown(`-${ch}`, k === head.length - 1 ? args[j + 1] : null); }
    }
  }
  return { opts, positionals, ambiguous };
}

// The effective settings: npm_config_* variables, overridden option by option by the command line.
function buildConfig(opts, env) {
  const map = new Map();
  const add = (name, entry) => { if (!map.has(name)) map.set(name, []); map.get(name).push(entry); };
  for (const [key, e] of Object.entries(env)) {
    const m = /^npm_config_(.+)$/i.exec(key);
    if (m) add(m[1].toLowerCase().replace(/_/g, '-'), { value: e.value, dynamic: e.dynamic, raw: e.raw });
  }
  const seen = new Set();
  for (const o of opts) {
    if (!seen.has(o.name)) { seen.add(o.name); map.delete(o.name); }
    const v = o.value;
    add(o.name, typeof v === 'boolean' ? { value: v, dynamic: false, raw: '' } : v === null ? { value: '', dynamic: false, raw: '' } : { value: v.text, dynamic: v.dynamic, raw: v.raw });
  }
  const last = (name) => (map.get(name) ?? []).at(-1);
  return {
    entries: (name) => map.get(name) ?? [],
    names: () => [...map.keys()],
    flag(name) {
      const e = last(name);
      if (!e) return false;
      return typeof e.value === 'boolean' ? e.value : !['', 'false', '0'].includes(e.value.toLowerCase());
    },
    text: (name) => { const e = last(name); return e && typeof e.value === 'string' ? e.value : null; },
  };
}

// ----- package specifications -----

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const PATH_SOURCE = /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|file:|link:|workspace:)|^\.{1,2}$|\.(?:tgz|tar\.gz|tar)$/i;
const GIT_SOURCE = /^(?:git\+|git:|git@|ssh:|https?:|github:|gitlab:|bitbucket:|gist:)/i;
const GITHUB_SHORTHAND = /^[^@\s/:]+\/[^@\s/:]+(?:#.*)?$/;
function unsupportedSource(s) {
  if (PATH_SOURCE.test(s)) return 'a local path or tarball';
  if (GIT_SOURCE.test(s)) return 'a git repository or URL';
  if (GITHUB_SHORTHAND.test(s)) return 'a GitHub shorthand';
  return null;
}

// { ok: true, spec, name, range, alias } for a registry package, { ok: false, kind, reason } for anything else.
export function parsePackageSpec(spec) {
  const source = unsupportedSource(spec);
  if (source) return { ok: false, kind: 'unsupported-source', reason: `${spec} is ${source}, which the guardian cannot assess` };
  const at = spec.indexOf('@', 1);
  const name = at < 0 ? spec : spec.slice(0, at);
  let rest = at < 0 ? null : spec.slice(at + 1);
  if (!PACKAGE_NAME.test(name)) return { ok: false, kind: 'invalid-package', reason: `${spec} is not a package name the guardian recognises` };
  if (rest === null || rest === '') return { ok: true, spec, name, range: null, alias: null };
  if (rest.startsWith('npm:')) {
    const inner = parsePackageSpec(rest.slice(4));
    return inner.ok ? { ok: true, spec, name: inner.name, range: inner.range, alias: name } : inner;
  }
  const restSource = unsupportedSource(rest);
  if (restSource) return { ok: false, kind: 'unsupported-source', reason: `${spec} installs from ${restSource}, which the guardian cannot assess` };
  return { ok: true, spec, name, range: rest, alias: null };
}

// npm init <initializer> runs the package `create-<initializer>`: `@scope` becomes `@scope/create`, `@scope/x` `@scope/create-x`.
function initializerPackage(spec) {
  const m = /^(@[^/@]+)(?:@([^/]*))?(?:\/([^@]*)(?:@(.*))?)?$/.exec(spec);
  if (m) {
    const [, scope, scopeVersion, pkg, pkgVersion] = m;
    const version = pkg === undefined ? scopeVersion : pkgVersion;
    return `${scope}/${pkg ? `create-${pkg}` : 'create'}${version ? `@${version}` : ''}`;
  }
  return `create-${spec}`;
}

// ----- the parser -----

const unj = (ctx, kind, reason, text) => ctx.unjudgeable.push({ kind, reason, text });
const commandName = (text) => text.replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe|ps1|bat)$/i, '');
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const dynamicNote = (w) => `${w.raw} is expanded by the shell at run time (${w.dynamic.join(', ')})`;
const copyState = (s) => ({ cwd: s.cwd, env: { ...s.env } });
const mergeState = (a, b) => ({ cwd: a.cwd === b.cwd ? a.cwd : null, env: { ...a.env, ...b.env } });

function applyAssignment(env, word) {
  const m = ASSIGNMENT.exec(word.text);
  if (m && /^npm_config_/i.test(m[1])) env[m[1].toLowerCase()] = { value: word.text.slice(m[0].length), dynamic: word.dynamic.length > 0, raw: word.raw };
}

export function parseCommandLine(line, { cwd } = {}) {
  if (typeof line !== 'string') throw new TypeError('parseCommandLine needs the command line as a string');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('parseCommandLine needs the absolute working directory as cwd');
  const ctx = { line, actions: [], unjudgeable: [], payload: 0 };
  runList(line, { cwd: path.resolve(cwd), env: {} }, ctx, 0);
  const unique = (list) => [...new Map(list.map((x) => [JSON.stringify(x), x])).values()];
  return { actions: unique(ctx.actions), unjudgeable: unique(ctx.unjudgeable) };
}

const SEGMENT_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}']);
const SKIPPED_SEGMENTS = new Set(['for', 'select', 'case', 'function', 'in', 'esac', 'fi', 'done']);
const TERMINATING = /^(?:exit|return|continue|break)$/;

// Runs a command list. Returns the state at its end, which only `eval` carries on.
function runList(src, state, ctx, depth) {
  const st0 = copyState(state);
  if (depth > MAX_NESTING) { unj(ctx, 'unparseable', 'command substitutions are nested too deeply to inspect', src); return st0; }
  let tokens;
  try { tokens = tokenize(src); } catch (e) {
    if (!(e instanceof Unparseable)) throw e;
    unj(ctx, 'unparseable', `the command line cannot be parsed (${e.message})`, src);
    return st0;
  }
  let st = st0;
  const groups = [];
  let seg = [];
  let listStart = copyState(st);
  let pipeBase = null;
  let orLeft = null;

  const finish = (nextOp) => {
    const tokensOfSegment = seg;
    seg = [];
    const first = tokensOfSegment.find((t) => t.t === 'word');
    if (!first && !tokensOfSegment.length) return;
    const start = copyState(st);
    if (!pipeBase) pipeBase = start;
    runSegment(tokensOfSegment, st, ctx, depth);
    if (orLeft) {
      const left = orLeft;
      orLeft = null;
      st = TERMINATING.test(first?.text ?? '') ? left : mergeState(left, st);
    }
    if (nextOp === '|' || nextOp === '|&') st = copyState(pipeBase);
    else {
      if (pipeBase !== start) st = copyState(pipeBase);
      else if (nextOp === '&') st = copyState(start);
      pipeBase = null;
    }
  };

  for (const tok of tokens) {
    if (tok.t !== 'op') { seg.push(tok); continue; }
    const op = tok.op;
    finish(op);
    if (op === '(') { groups.push(copyState(st)); listStart = copyState(st); } else if (op === ')') {
      if (groups.length) st = groups.pop();
      listStart = copyState(st);
    } else if (op === ';' || op === '\n' || op === ';;') listStart = copyState(st);
    else if (op === '||') { orLeft = copyState(st); st = mergeState(listStart, st); }
  }
  finish(null);
  return st;
}

function runSegment(tokens, st, ctx, depth) {
  const words = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'redir') { if (tokens[k + 1]?.t === 'word') { runSubs(tokens[k + 1], st, ctx, depth); k++; } continue; }
    runSubs(t, st, ctx, depth);
    words.push(t);
  }
  let k = 0;
  const env = {};
  for (; k < words.length; k++) {
    const w = words[k];
    if (!w.quoted && !w.dynamic.length && SKIPPED_SEGMENTS.has(w.text)) return;
    if (!w.quoted && !w.dynamic.length && SEGMENT_KEYWORDS.has(w.text)) continue;
    if (ASSIGNMENT.test(w.text)) { applyAssignment(env, w); continue; }
    break;
  }
  if (k >= words.length) { Object.assign(st.env, env); return; }
  execute(words.slice(k), env, st, ctx, depth, {});
}

function runSubs(word, st, ctx, depth) {
  for (const sub of word.subs ?? []) runList(sub, st, ctx, depth + 1);
}

// A wrapper's leading options. Anything it does not know makes the command behind it unreadable.
const WRAPPERS = {
  env: { valued: ['-u', '--unset', '-C', '--chdir', '-P'], chdir: ['-C', '--chdir'], known: ['-i', '-0', '-v', '--ignore-environment', '--null', '--debug'], assigns: true },
  sudo: { valued: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--host', '--prompt', '--chdir'], chdir: ['-D', '--chdir'], known: ['-E', '-H', '-n', '-S', '-b', '-k', '-K', '-A', '-B', '-P', '-i', '-s', '--preserve-env', '--non-interactive', '--login', '--shell'], assigns: true },
  doas: { valued: ['-u', '-C'], known: ['-n', '-s'] },
  time: { valued: ['-o', '-f', '--output', '--format'], known: ['-p', '-v', '-a', '--portability', '--verbose', '--append'] },
  command: { known: ['-p'] },
  builtin: {},
  nohup: {},
  corepack: {},
  exec: { valued: ['-a'], known: ['-c', '-l'] },
  setsid: { known: ['-f', '-w', '-c', '--fork', '--wait', '--ctty'] },
  nice: { valued: ['-n', '--adjustment'], numeric: true },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], known: ['--foreground', '--preserve-status', '-v', '--verbose'], positionals: 1 },
  stdbuf: { valued: ['-i', '-o', '-e'] },
  xargs: { valued: ['-n', '-L', '-P', '-I', '-d', '-a', '-E', '-s', '-l', '--max-args', '--max-procs', '--replace', '--delimiter', '--arg-file', '--eof', '--max-lines', '--max-chars'], known: ['-0', '-r', '-t', '-p', '-x', '-o', '-i', '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty'], stdin: true },
};
const OPAQUE = Symbol('opaque');

function unwrap(name, words) {
  const spec = WRAPPERS[name];
  const env = {};
  let chdir;
  let k = 1;
  for (; k < words.length; k++) {
    const w = words[k];
    const t = w.text;
    if (t === '--') { k++; break; }
    if (spec.assigns && ASSIGNMENT.test(t)) { applyAssignment(env, w); continue; }
    if (!t.startsWith('-') || t === '-' || (w.dynamic.length && !t.startsWith('-'))) break;
    const eq = t.indexOf('=');
    const head = t.startsWith('--') && eq > 0 ? t.slice(0, eq) : t;
    if (spec.valued?.includes(head) || spec.known?.includes(head)) {
      if (eq > 0 && t.startsWith('--')) { if (spec.chdir?.includes(head)) chdir = valueOf(t.slice(eq + 1), w.dynamic.length > 0, w.raw); continue; }
      if (spec.valued?.includes(head)) { if (spec.chdir?.includes(head)) chdir = words[k + 1]; k++; }
      continue;
    }
    const short = t.slice(0, 2);
    if (!t.startsWith('--') && t.length > 2 && spec.valued?.includes(short)) { if (spec.chdir?.includes(short)) chdir = valueOf(t.slice(2), w.dynamic.length > 0, w.raw); continue; }
    if (spec.numeric && /^-\d+$/.test(t)) continue;
    return OPAQUE;
  }
  k += spec.positionals ?? 0;
  return { rest: words.slice(k), env, chdir, stdin: !!spec.stdin };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const mentionsNpm = (ctx) => /\b(?:npm|npx)\b/.test(ctx.line);

function execute(words, env, st, ctx, depth, over) {
  let cwd = over.cwd === undefined ? st.cwd : over.cwd;
  let stdin = false;
  for (;;) {
    const head = words[0];
    if (!head) return;
    if (head.dynamic.length && /[$`)}]|^$/.test(head.text.slice(head.text.lastIndexOf('/') + 1))) return dynamicCommand(words, ctx);
    const name = commandName(head.text);
    if (name === 'command' && ['-v', '-V'].includes(words[1]?.text)) return;
    if (!WRAPPERS[name]) break;
    const r = unwrap(name, words);
    if (r === OPAQUE) {
      if (words.slice(1).some((w) => ['npm', 'npx'].includes(commandName(w.text)))) {
        unj(ctx, 'opaque-command', `${name} is run with an option the parser does not know, so the command behind it cannot be identified`, words.map((w) => w.raw).join(' '));
      }
      return;
    }
    if (r.chdir) cwd = resolveDir(cwd, r.chdir);
    Object.assign(env, r.env);
    stdin ||= r.stdin;
    words = r.rest;
  }
  const name = commandName(words[0].text);
  const args = words.slice(1);
  switch (name) {
    case 'cd': st.cwd = cdTarget(args, st.cwd); break;
    case 'pushd': st.cwd = cdTarget(args, st.cwd); break;
    case 'popd': st.cwd = null; break;
    case 'export': case 'declare': case 'typeset': case 'readonly': case 'local': for (const a of args) applyAssignment(st.env, a); break;
    case 'unset': for (const a of args) delete st.env[a.text.toLowerCase()]; break;
    case 'eval': {
      const payload = args[0]?.text === '--' ? args.slice(1) : args;
      if (!payload.length) break;
      const next = runPayload(payload.map((w) => w.text).join(' '), st, ctx, depth);
      st.cwd = next.cwd;
      st.env = next.env;
      break;
    }
    case 'npm': case 'npx': {
      const extra = stdin ? [{ t: 'word', text: '<stdin>', raw: '<stdin>', quoted: false, dynamic: ['standard input'], subs: [] }] : [];
      runNpm(name, [...args, ...extra], { ...st.env, ...env }, cwd, ctx, words.map((w) => w.raw).join(' '));
      break;
    }
    default:
      if (SHELLS.has(name)) shellPayload(args, st, ctx, depth);
  }
}

function resolveDir(base, word) {
  if (word.dynamic.length) return null;
  if (path.isAbsolute(word.text)) return path.resolve(word.text);
  return base ? path.resolve(base, word.text) : null;
}
function cdTarget(args, cwd) {
  let k = 0;
  while (args[k] && !args[k].dynamic.length && /^-[PLe@]+$/.test(args[k].text)) k++;
  if (args[k]?.text === '--') k++;
  const target = args[k];
  if (!target || target.text === '-') return null;
  return resolveDir(cwd, target);
}

function shellPayload(args, st, ctx, depth) {
  let payload = null;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (['-o', '-O', '+o', '+O'].includes(t)) { k++; continue; }
    if (/^-[A-Za-z]+$/.test(t) && !args[k].dynamic.length) {
      if (t.includes('c')) { payload = args[k + 1]; break; }
      continue;
    }
    if (t.startsWith('--') || /^\+[A-Za-z]+$/.test(t)) continue;
    break;
  }
  if (payload) runPayload(payload.text, copyState(st), ctx, depth);
}

// A string the shell is told to run: parsed like a command line. Returns its end state.
function runPayload(text, st, ctx, depth) {
  ctx.payload++;
  try { return runList(text, st, ctx, depth + 1); } finally { ctx.payload--; }
}

function dynamicCommand(words, ctx) {
  const text = words.map((w) => w.raw).join(' ');
  const verb = words.slice(1).some((w) => !w.dynamic.length && isDependencyCommand(canonicalNpmCommand(w.text) ?? ''));
  if (verb || (ctx.payload && mentionsNpm(ctx))) {
    unj(ctx, 'dynamic-command', `the command name is ${dynamicNote(words[0])}, so the command cannot be identified`, text);
  }
}

// ----- npm and npx -----

function runNpm(tool, args, env, cwd, ctx, text) {
  let parsed = readOptions(args, tool === 'npx' ? { exec: true, stopAfter: 1 } : {});
  let sub = null;
  if (tool === 'npm') {
    const first = parsed.positionals[0];
    if (!first) return;
    if (first.dynamic.length) { unj(ctx, 'dynamic-command', `the npm subcommand ${dynamicNote(first)}`, text); return; }
    sub = canonicalNpmCommand(first.text);
    if (!sub || !isDependencyCommand(sub)) return;
    if (sub === 'exec') parsed = readOptions(args, { exec: true, stopAfter: 2 });
  } else sub = 'exec';

  const { opts, positionals, ambiguous } = parsed;
  const offset = tool === 'npm' ? 1 : 0;
  let command;
  if (sub === 'install' || sub === 'install-test') command = 'install';
  else if (sub === 'ci' || sub === 'install-ci-test') command = 'ci';
  else if (sub === 'update') command = 'update';
  else if (sub === 'exec') command = 'exec';
  else if (sub === 'init') command = positionals[1] ? 'exec' : null;
  else if (sub === 'audit') {
    const verb = positionals[1];
    if (!verb) return;
    if (verb.dynamic.length) { unj(ctx, 'dynamic-command', `the npm audit subcommand ${dynamicNote(verb)}`, text); return; }
    command = verb.text === 'fix' ? 'audit-fix' : null;
  }
  if (!command) return;

  const before = ctx.unjudgeable.length;
  for (const a of ambiguous) unj(ctx, 'ambiguous-option', `option ${a.name} may take a value, so the guardian cannot tell whether ${a.next} is that value or a package`, text);

  const cfg = buildConfig(opts, env);
  let dynamicResolution = false;
  for (const name of cfg.names().filter((n) => RESOLUTION_OPTIONS.includes(n) || /^@[^:\s]+:registry$/.test(n))) {
    for (const e of cfg.entries(name)) {
      if (!e.dynamic) continue;
      dynamicResolution = true;
      unj(ctx, 'dynamic-option', `the value of ${name} is ${e.raw}, which the shell expands at run time, so the guardian cannot tell where or from which registry npm installs`, text);
    }
  }

  const global = cfg.flag('global') || cfg.text('location') === 'global';
  const prefix = cfg.text('prefix');
  let dir = null;
  if (!global && !dynamicResolution) {
    if (prefix) dir = path.isAbsolute(prefix) ? path.resolve(prefix) : cwd ? path.resolve(cwd, prefix) : null;
    else dir = cwd;
    if (!dir) unj(ctx, 'unknown-directory', 'a cd to a directory the parser cannot work out (a variable, ~, - or none) comes before this command, so it is unknown where npm runs', text);
  }

  const packages = [];
  const addSpec = (word, spec) => {
    if (word?.dynamic?.length) { unj(ctx, 'dynamic-package', `the package ${dynamicNote(word)}, so what is installed cannot be known`, text); return; }
    if (!spec) return;
    const r = parsePackageSpec(spec);
    if (r.ok) packages.push({ spec: r.spec, name: r.name, range: r.range, alias: r.alias });
    else unj(ctx, r.kind, r.reason, text);
  };
  if (command === 'install' || command === 'update') for (const w of positionals.slice(offset)) addSpec(w, w.text);
  else if (command === 'exec') {
    const downloads = !cfg.flag('no') && !(cfg.entries('yes').length && !cfg.flag('yes'));
    if (!downloads) return;
    if (sub === 'init') { const w = positionals[1]; if (w.dynamic.length) addSpec(w, null); else { const unsupported = unsupportedSource(w.text); addSpec(w, unsupported ? w.text : initializerPackage(w.text)); } }
    else {
      const named = cfg.entries('package');
      if (named.length) for (const e of named) addSpec({ dynamic: e.dynamic ? [1] : [], raw: e.raw }, e.value);
      else if (!cfg.entries('call').length) addSpec(positionals[offset], positionals[offset]?.text);
    }
  }

  if (dynamicResolution || (!dir && !global)) return;
  if (command === 'exec' && !packages.length) return;
  const workspaces = cfg.entries('workspace').filter((e) => !e.dynamic && e.value).map((e) => e.value);
  ctx.actions.push({
    tool, command, via: sub === 'init' ? 'init' : null, raw: text, dir, global,
    workspaces: [...new Set(workspaces)], allWorkspaces: cfg.flag('workspaces'), includeWorkspaceRoot: cfg.flag('include-workspace-root'),
    force: cfg.flag('force'), packages,
  });
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
