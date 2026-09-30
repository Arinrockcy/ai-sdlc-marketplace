#!/usr/bin/env node
// aisdlc.mjs — deterministic helper for the aisdlc workflow skills.
// Zero dependencies. All state lives in <project>/.aisdlc as markdown frontmatter + JSON.
// Output is JSON on stdout (except `hooks run` and `task verify`, which stream command output); errors exit 1 with a message on stderr.

import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(PLUGIN_ROOT, 'templates');
const DEFAULT_HOOKS = path.join(PLUGIN_ROOT, 'defaults', 'hooks.json');

const GOAL_STATES = ['pending', 'in-progress', 'blocked', 'completed', 'cancelled'];
// Allowed `state move` targets per status. A goal is pending only while none of its tasks has started, so a
// started goal never goes back to pending: it can't be re-challenged or merged into. Completed is final; a
// cancelled goal reopens as pending, or as blocked when its work had started. Gates and task checks still apply.
const GOAL_MOVES = {
  pending: ['in-progress', 'cancelled'],
  'in-progress': ['pending', 'blocked', 'completed', 'cancelled'],
  blocked: ['in-progress', 'cancelled'],
  completed: [],
  cancelled: ['pending', 'blocked'],
};
const TASK_STATES = ['pending', 'in-progress', 'done', 'blocked', 'skipped'];
const TASK_SATISFIED = new Set(['done', 'skipped']);
const RISK_RANK = { high: 0, medium: 1, low: 2 };
const ADR_SETTLED = new Set(['accepted', 'superseded']);
const RULE_SEVERITIES = ['must', 'should', 'retired'];
// A rule's stage says which review checks it: `plan` gates implementation, `final` gates completion.
const RULE_STAGES = ['plan', 'final'];
const REVIEW_FILE = { plan: 'governance-review.md', final: 'governance-final.md' };
const STEPS = ['init', 'create_goal', 'challenge', 'adr', 'govern', 'implement'];
export const HOOK_POINTS = [
  'before_goal', 'after_goal', 'before_task', 'after_task', 'on_block',
  ...STEPS.flatMap((s) => [`pre_${s}`, `post_${s}`]),
];

// Marker file -> stack name. First match order matters only for reporting.
const STACK_MARKERS = [
  ['package.json', 'nodejs'],
  ['pyproject.toml', 'python'], ['requirements.txt', 'python'], ['setup.py', 'python'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['pom.xml', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
  ['pubspec.yaml', 'dart'],
];

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// ---------- frontmatter ----------

// Only these keys hold lists, so a title like "[WIP]" stays a string.
const ARRAY_KEYS = new Set(['adrs', 'depends_on', 'goals']);

function parseScalar(raw, key) {
  const v = raw.trim();
  if (v === '') return '';
  if (ARRAY_KEYS.has(key) && v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function formatScalar(v) {
  if (Array.isArray(v)) return `[${v.map(formatScalar).join(', ')}]`;
  if (v === null || v === undefined) return '';
  const s = String(v);
  // A newline would let a value inject its own frontmatter keys (e.g. "x\nstatus: done").
  if (/[\r\n]/.test(s)) fail(`Frontmatter values must be a single line: ${JSON.stringify(s)}`);
  return s;
}

export function parseDoc(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    data[key] = parseScalar(line.slice(i + 1), key);
  }
  return { data, body: m[2] };
}

export function formatDoc({ data, body }) {
  const lines = Object.entries(data).map(([k, v]) => {
    const s = formatScalar(v);
    return s === '' ? `${k}:` : `${k}: ${s}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

const readDoc = (file) => parseDoc(fs.readFileSync(file, 'utf8'));
const writeDoc = (file, doc) => fs.writeFileSync(file, formatDoc(doc));

function updateDoc(file, patch) {
  const doc = readDoc(file);
  Object.assign(doc.data, patch);
  if ('updated' in doc.data) doc.data.updated = today();
  writeDoc(file, doc);
  return doc;
}

// ---------- helpers ----------

const today = () => new Date().toISOString().slice(0, 10);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
const pad = (n, w) => String(n).padStart(w, '0');
const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

function render(templateName, vars) {
  const text = fs.readFileSync(path.join(TEMPLATES, templateName), 'utf8');
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => formatScalar(vars[k]));
}

function writeIfMissing(file, content, created) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  created.push(file);
}

function findRoot(start = process.cwd(), required = true) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.aisdlc'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      if (!required) return null;
      fail('No .aisdlc/ found in this directory or any parent. Run /aisdlc:init first.');
    }
    dir = parent;
  }
}

const aisdlcDir = (root) => path.join(root, '.aisdlc');

function loadConfig(root) {
  const file = path.join(aisdlcDir(root), 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function saveConfig(root, cfg) {
  fs.writeFileSync(path.join(aisdlcDir(root), 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

// Every option takes a value, even one that starts with "--" (e.g. --verify "--version").
// Unknown options fail, so a typo in a skill can't be silently ignored.
export const OPTIONS = new Set(['depends', 'risk', 'verify', 'reason', 'evidence', 'goal', 'task', 'status', 'stack', 'graph', 'base-branch', 'dir', 'severity', 'stage', 'check', 'budget']);

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!OPTIONS.has(key)) fail(`Unknown option --${key}. Valid: ${[...OPTIONS].map((o) => `--${o}`).join(', ')}`);
      if (argv[i + 1] === undefined) fail(`--${key} needs a value`);
      opts[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

// ---------- goals ----------

function listGoals(root) {
  const goals = [];
  for (const status of GOAL_STATES) {
    const dir = path.join(aisdlcDir(root), 'goals', status);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'goal.md');
      if (!fs.existsSync(file)) continue;
      const { data } = readDoc(file);
      // Fall back to the folder name so a damaged goal.md never frees its ID for reuse.
      const id = data.id || name.match(/^G-\d+/)?.[0];
      goals.push({ id, title: data.title, status, dir: path.join(dir, name), file, data });
    }
  }
  return goals;
}

function getGoal(root, id) {
  const g = listGoals(root).find((x) => x.id === id);
  if (!g) fail(`Goal ${id} not found.`);
  return g;
}

function nextId(prefix, existing, width) {
  const nums = existing.map((id) => Number(String(id).replace(`${prefix}-`, ''))).filter(Number.isFinite);
  return `${prefix}-${pad((nums.length ? Math.max(...nums) : 0) + 1, width)}`;
}

function listTasks(goal) {
  const dir = path.join(goal.dir, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const file = path.join(dir, f);
    const { data } = readDoc(file);
    return { ...data, depends_on: Array.isArray(data.depends_on) ? data.depends_on : [], file };
  });
}

function getTask(goal, taskId) {
  const t = listTasks(goal).find((x) => x.id === taskId);
  if (!t) fail(`Task ${taskId} not found in ${goal.id}.`);
  return t;
}

// ---------- DAG ----------

export function analyzeDag(tasks) {
  const errors = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (!byId.has(d)) errors.push(`${t.id} depends on unknown task ${d}`);
      if (d === t.id) errors.push(`${t.id} depends on itself`);
    }
    if (t.risk && !(t.risk in RISK_RANK)) errors.push(`${t.id} has invalid risk "${t.risk}" (use high|medium|low)`);
  }
  if (errors.length) return { ok: false, errors, waves: [] };

  // Kahn's algorithm, grouped into waves; tasks within a wave have no dependency on each other.
  const indeg = new Map(tasks.map((t) => [t.id, t.depends_on.length]));
  const dependents = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.depends_on) dependents.get(d).push(t.id);
  const byRisk = (a, b) => (RISK_RANK[byId.get(a).risk] ?? 1) - (RISK_RANK[byId.get(b).risk] ?? 1) || a.localeCompare(b);

  const waves = [];
  let frontier = tasks.filter((t) => t.depends_on.length === 0).map((t) => t.id);
  let seen = 0;
  while (frontier.length) {
    frontier.sort(byRisk);
    waves.push(frontier);
    seen += frontier.length;
    const next = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id)) {
        indeg.set(dep, indeg.get(dep) - 1);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (seen !== tasks.length) {
    const cyclic = tasks.filter((t) => indeg.get(t.id) > 0).map((t) => t.id);
    return { ok: false, errors: [`Dependency cycle among: ${cyclic.join(', ')}`], waves: [] };
  }
  return { ok: true, errors: [], waves };
}

export function goalProgress(tasks) {
  const dag = analyzeDag(tasks);
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const waveOf = new Map(dag.waves.flatMap((w, i) => w.map((id) => [id, i])));
  const blocked = tasks.filter((t) => t.status === 'blocked').map((t) => t.id);

  // Transitive dependents of blocked tasks cannot run until the blocker is resolved.
  const waiting = new Set();
  const stack = [...blocked];
  while (stack.length) {
    const id = stack.pop();
    for (const t of tasks) {
      if (t.depends_on.includes(id) && !waiting.has(t.id) && t.status !== 'blocked') {
        waiting.add(t.id);
        stack.push(t.id);
      }
    }
  }

  const ready = dag.ok
    ? tasks
      .filter((t) => t.status === 'pending' && t.depends_on.every((d) => TASK_SATISFIED.has(status.get(d))))
      .map((t) => t.id)
      .sort((a, b) => waveOf.get(a) - waveOf.get(b) || dag.waves[waveOf.get(a)].indexOf(a) - dag.waves[waveOf.get(b)].indexOf(b))
    : [];
  const inProgress = tasks.filter((t) => t.status === 'in-progress').map((t) => t.id);
  const done = tasks.filter((t) => TASK_SATISFIED.has(t.status)).map((t) => t.id);
  return {
    dag_ok: dag.ok,
    dag_errors: dag.errors,
    total: tasks.length,
    done: done.length,
    ready,
    in_progress: inProgress,
    blocked,
    waiting_on_blocked: [...waiting].filter((id) => !TASK_SATISFIED.has(status.get(id))).sort(),
    complete: tasks.length > 0 && done.length === tasks.length,
    stuck: tasks.length > 0 && done.length < tasks.length && ready.length === 0 && inProgress.length === 0,
  };
}

function writeTasksMd(goal) {
  const tasks = listTasks(goal);
  const dag = analyzeDag(tasks);
  if (!dag.ok) fail(`Invalid task DAG for ${goal.id}:\n- ${dag.errors.join('\n- ')}`);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = dag.waves.flatMap((w, i) => w.map((id) => {
    const t = byId.get(id);
    return `| ${i + 1} | ${t.id} | ${t.title} | ${t.risk || 'medium'} | ${t.depends_on.join(', ') || '-'} | ${t.status} |`;
  }));
  const text = [
    `# ${goal.id} Tasks`,
    '',
    '> Generated by `aisdlc.mjs dag write`. Tasks in the same wave are independent of each other.',
    '> Within a wave, higher-risk tasks come first.',
    '',
    '| Wave | ID | Title | Risk | Depends on | Status |',
    '|------|----|-------|------|------------|--------|',
    ...rows,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(goal.dir, 'tasks.md'), text);
  return dag;
}

// ---------- stack ----------

function detectStacks(root) {
  const found = [];
  for (const [marker, stack] of STACK_MARKERS) {
    if (fs.existsSync(path.join(root, marker)) && !found.includes(stack)) found.push(stack);
  }
  if (fs.readdirSync(root).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) found.push('dotnet');
  return found;
}

function activeStack(root, cfg = loadConfig(root)) {
  if (cfg.stack && cfg.stack !== 'auto') return cfg.stack;
  const found = detectStacks(root);
  return found.length === 1 ? found[0] : null;
}

function loadStackManifest(root, stack) {
  if (!stack) return null;
  const file = path.join(aisdlcDir(root), 'stacks', `${stack}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// ---------- hooks ----------

function envHook(point) {
  const raw = process.env[`AISDLC_HOOK_${point.toUpperCase()}`];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === '' || v === 'none') return null;
  if (v === 'use:stack') return { use: 'stack' };
  if (v === 'use:default') return { use: 'default' };
  return { run: v };
}

export function resolveHook(point, layers) {
  // layers: { env, config, stack, default } — each a map point -> value (undefined = not defined in that layer).
  const order = ['env', 'config', 'stack', 'default'];
  const has = (layer, p) => layers[layer] && Object.prototype.hasOwnProperty.call(layers[layer], p);

  const follow = (layer, visited) => {
    const key = `${layer}`;
    if (visited.has(key)) return { source: layer, commands: [], note: 'circular use: reference' };
    visited.add(key);
    const v = layers[layer][point];
    if (v === null) return { source: layer, commands: [] };
    if (v.run !== undefined) return { source: layer, commands: [].concat(v.run) };
    if (v.use === 'stack') return has('stack', point) ? follow('stack', visited) : { source: 'stack', commands: [], note: 'no stack hook defined' };
    if (v.use === 'default') return has('default', point) ? follow('default', visited) : { source: 'default', commands: [] };
    fail(`Invalid hook value for ${point} in ${layer}: ${JSON.stringify(v)}`);
  };

  for (const layer of order) if (has(layer, point)) return follow(layer, new Set());
  return { source: 'none', commands: [] };
}

function hookContext(root, cfg, opts) {
  const vars = {
    base_branch: cfg.git?.base_branch || 'develop',
    branch_prefix: cfg.git?.branch_prefix ?? 'feature/',
    goal_id: '', goal_slug: '', goal_branch: '', task_id: opts.task || '',
  };
  if (opts.goal) {
    const g = getGoal(root, opts.goal);
    vars.goal_id = g.id;
    vars.goal_slug = path.basename(g.dir);
    vars.goal_branch = g.data.branch || `${vars.branch_prefix}${vars.goal_slug}`;
  }
  return vars;
}

function resolveHookFor(root, point, opts) {
  if (!HOOK_POINTS.includes(point)) fail(`Unknown hook point "${point}". Valid: ${HOOK_POINTS.join(', ')}`);
  const cfg = loadConfig(root);
  const stack = activeStack(root, cfg);
  const env = {};
  const e = envHook(point);
  if (e !== undefined) env[point] = e;
  const layers = {
    env,
    config: cfg.hooks || {},
    stack: loadStackManifest(root, stack)?.hooks || {},
    default: JSON.parse(fs.readFileSync(DEFAULT_HOOKS, 'utf8')),
  };
  const r = resolveHook(point, layers);
  const vars = hookContext(root, cfg, opts);
  const commands = r.commands.map((c) => c.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
  return { point, stack, ...r, commands };
}

// ---------- registry ----------

function listAdrs(root) {
  const dir = path.join(aisdlcDir(root), 'adr');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^ADR-\d+.*\.md$/.test(f)).sort().map((f) => {
    const file = path.join(dir, f);
    return { ...readDoc(file).data, file };
  });
}

const ARCHIVED_STATES = ['completed', 'cancelled'];

// registry.md indexes unfinished goals and every ADR; finished goals go to registry-archive.md.
// Skills read registry.md whole, so it only grows with open work; the archive is searched, not read.
function registrySync(root) {
  const base = aisdlcDir(root);
  const cell = (v) => (Array.isArray(v) ? v.join(', ') : formatScalar(v)).replace(/\|/g, '\\|') || '-';
  const open = [];
  const archived = [];
  for (const g of listGoals(root)) {
    const p = goalProgress(listTasks(g));
    const status = p.total ? `${g.status} (${p.done}/${p.total})` : g.status;
    const links = g.data.adrs === 'none' ? 'adr: none' : cell(g.data.adrs);
    (ARCHIVED_STATES.includes(g.status) ? archived : open).push(`| ${g.id} | goal | ${cell(g.title)} | ${status} | ${links} | ${cell(g.data.updated)} |`);
  }
  for (const a of listAdrs(root)) {
    open.push(`| ${a.id} | adr | ${cell(a.title)} | ${cell(a.status)} | ${cell(a.goals)} | ${cell(a.date)} |`);
  }
  const write = (name, rows) => {
    const header = fs.readFileSync(path.join(TEMPLATES, name), 'utf8').trimEnd();
    fs.writeFileSync(path.join(base, name), `${header}\n${rows.join('\n')}${rows.length ? '\n' : ''}`);
  };
  write('registry.md', open);
  write('registry-archive.md', archived);
  return { rows: open.length, archived: archived.length };
}

// `--status a,b` matches any of the listed states. `allowed` rejects typos, which would otherwise match nothing.
function statusFilter(value, allowed) {
  if (value === undefined) return () => true;
  const wanted = value.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = allowed ? wanted.filter((x) => !allowed.includes(x)) : [];
  if (!wanted.length || bad.length) fail(`Unknown status "${bad.join(', ') || value}". Valid: ${(allowed || []).join(', ') || 'any status name'}, comma-separated.`);
  return (status) => wanted.includes(status);
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'add', 'from', 'into', 'that', 'this', 'use', 'new', 'when', 'all']);

// Rows of registry.md and the archive that mention any keyword, best match first. A keyword matches a word it
// starts, so "limit" finds "limiting". Saves reading the archive, which keeps every finished goal.
function registrySearch(root, words) {
  const terms = [...new Set(words.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)))];
  if (!terms.length) fail('Usage: registry search <keywords> (words of 3 or more letters)');
  const rows = [];
  for (const name of ['registry.md', 'registry-archive.md']) {
    const file = path.join(aisdlcDir(root), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!/^\| [A-Z]+-\d+ \|/.test(line)) continue;
      const lineWords = line.toLowerCase().split(/[^a-z0-9]+/);
      const score = terms.filter((t) => lineWords.some((w) => w.startsWith(t))).length;
      if (score) rows.push({ line, score });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return { terms, matches: rows.slice(0, 10).map((r) => r.line), more: Math.max(0, rows.length - 10) };
}

// ---------- graph ----------

// Graphify is only here to cut the tokens the workflow spends finding code. It runs code-only (local parsing, no
// model calls, no API key) and always writes graphify-out/ in the project root. `.aisdlc/` is kept out of the graph
// through .graphifyignore, so workflow state never makes it stale.
const GRAPH_DIR = 'graphify-out';
const GRAPH_STAMP = path.join(GRAPH_DIR, '.aisdlc-stamp');
const GRAPH_WARNINGS = path.join(GRAPH_DIR, '.aisdlc-warnings');
const GRAPH_IGNORED = ['.aisdlc/', `${GRAPH_DIR}/`];
const GRAPH_FEATURES = { update: /^\s*update <path>/m, query: /^\s*query "<question>"/m, budget: /--budget N/ };
const GRAPH_INSTALL = 'Install Graphify 0.9 or later (Python 3.10+) so `graphify` is on PATH, for example `pipx install graphifyy`. The workflow only needs the CLI, not `graphify install`.';
const DEFAULT_BUDGET = 1500;

const graphBin = () => process.env.AISDLC_GRAPHIFY || 'graphify';
const graphify = (root, args) => execFileSync(graphBin(), args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function git(root, args, input) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); } catch { return null; }
}

function graphConfig(root) {
  const g = loadConfig(root).graph || {};
  // Graphify's update has no output option, so the graph can only live in graphify-out/.
  if (g.path && g.path !== GRAPH_DIR) fail(`graph.path "${g.path}" is not supported: Graphify always writes ${GRAPH_DIR}/ in the project root. Remove graph.path from .aisdlc/config.json.`);
  return { provider: g.provider || 'none' };
}

// Whether graphify is on PATH and has the commands the workflow uses.
function graphTool(root) {
  let help;
  try { help = graphify(root, ['--help']); } catch { return { installed: false, install: GRAPH_INSTALL }; }
  let version = null;
  try { version = graphify(root, ['--version']).trim().replace(/^graphify\s+/, ''); } catch { /* older releases have no --version */ }
  const missing = Object.keys(GRAPH_FEATURES).filter((f) => !GRAPH_FEATURES[f].test(help));
  return { installed: true, version, supported: !missing.length, ...(missing.length && { missing, install: GRAPH_INSTALL }) };
}

// Graphify's warnings from the last build, for example files it left out because an optional grammar is missing.
const graphWarnings = (root) => {
  const file = path.join(root, GRAPH_WARNINGS);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

const graphIgnoreOk = (root) => {
  const file = path.join(root, '.graphifyignore');
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/).some((l) => /^\/?\.aisdlc\/?$/.test(l.trim()));
};

// A fingerprint of the code in the working tree: the blob hash of every file git tracks or would track, without
// workflow files. It depends on content only, so committing code the graph already has never forces a rebuild.
function codeStamp(root) {
  const list = (...args) => git(root, ['ls-files', '-z', ...args])?.split('\0').filter(Boolean);
  const staged = list('-s');
  if (!staged) return null;
  const keep = (f) => !GRAPH_IGNORED.some((d) => f.startsWith(d));
  const blobs = new Map(staged.map((l) => { const [meta, f] = l.split('\t'); return [f, meta.split(' ')[1]]; }));
  for (const f of list('-d')) blobs.delete(f);
  const changed = [...new Set([...list('-m'), ...list('-o', '--exclude-standard')])].filter((f) => keep(f) && fs.existsSync(path.join(root, f)));
  const hashes = changed.length ? git(root, ['hash-object', '--stdin-paths'], changed.join('\n')).trim().split('\n') : [];
  changed.forEach((f, i) => blobs.set(f, hashes[i]));
  const entries = [...blobs].filter(([f]) => keep(f)).sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

function graphFreshness(root) {
  const graphFile = path.join(root, GRAPH_DIR, 'graph.json');
  if (!fs.existsSync(graphFile)) return { built: false, stale: true, reason: 'no graph built yet' };
  const built = { built: true, built_at: new Date(fs.statSync(graphFile).mtimeMs).toISOString() };
  const now = codeStamp(root);
  if (now === null) return { ...built, stale: true, reason: 'not a git repository, so changes cannot be tracked' };
  const stampFile = path.join(root, GRAPH_STAMP);
  const was = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : null;
  if (was === now) return { ...built, stale: false };
  return { ...built, stale: true, reason: was ? 'code changed since the graph was built' : 'graph was not built by aisdlc' };
}

// Rebuilds the graph if the code changed, or always with `force`. Incremental and model-free, but it still takes
// seconds on a large repo.
function graphUpdate(root, force = false) {
  const fresh = graphFreshness(root);
  if (!fresh.stale && !force) return { updated: false };
  const started = Date.now();
  const graphFile = path.join(root, GRAPH_DIR, 'graph.json');
  const before = fs.existsSync(graphFile) ? fs.statSync(graphFile).mtimeMs : null;
  const r = spawnSync(graphBin(), ['update', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) {
    fail(`graphify update failed: ${String(r.error?.message || r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  }
  const warnings = [...r.stderr.matchAll(/^\s*warning:\s*(.+)$/gm)].map((m) => m[1].trim());
  const reported = warnings.length ? { warnings } : {};
  // An edit that changes no symbol or edge (a comment, a function body) leaves graph.json untouched but current.
  const current = /No code-graph topology changes detected/.test(r.stdout);
  // Graphify can also decline to overwrite a graph (for example one that shrank); never mark such a graph fresh.
  if (!current && (!fs.existsSync(graphFile) || fs.statSync(graphFile).mtimeMs === before)) {
    return { updated: false, warning: `graphify update left ${GRAPH_DIR}/graph.json unchanged, so it may be out of date. Run \`graphify update . --force\` to rebuild it.`, ...reported };
  }
  const stamp = codeStamp(root);
  if (stamp) fs.writeFileSync(path.join(root, GRAPH_STAMP), `${stamp}\n`);
  const warningsFile = path.join(root, GRAPH_WARNINGS);
  if (warnings.length) fs.writeFileSync(warningsFile, `${warnings.join('\n')}\n`);
  else fs.rmSync(warningsFile, { force: true });
  return { updated: true, reason: fresh.stale ? fresh.reason : 'rebuild requested', ms: Date.now() - started, ...reported };
}

// ---------- governance ----------

// Markdown table rows as arrays of trimmed cells, skipping |---| separator rows. `\|` is a literal pipe inside a cell.
function tableRows(body) {
  return body.split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s|:-]+\|?$/.test(l.trim()))
    .map((l) => l.trim().replace(/^\||(?<!\\)\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')));
}

const RULE_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const GOVERNANCE_COLUMNS = ['ID', 'Rule', 'Severity', 'Stage', 'Check'];

function ruleErrors(r) {
  const errors = [];
  if (!r.rule) errors.push(`${r.id} has no rule text`);
  if (/[\r\n]/.test(r.rule)) errors.push(`${r.id} rule text must be a single line`);
  if (!RULE_SEVERITIES.includes(r.severity)) errors.push(`${r.id} has severity "${r.severity}" (use ${RULE_SEVERITIES.join(', ')})`);
  if (!RULE_STAGES.includes(r.stage)) errors.push(`${r.id} has stage "${r.stage}" (use ${RULE_STAGES.join(', ')})`);
  if (r.check && !(r.check in CHECKS)) errors.push(`${r.id} has unknown check "${r.check}" (use ${Object.keys(CHECKS).join(', ')} or -)`);
  return errors;
}

// Every rule in governance.md, retired ones included. Fails on duplicate IDs or invalid values,
// so a typo never turns a must rule into one that silently does not block.
function readGovernance(root) {
  const file = path.join(aisdlcDir(root), 'governance.md');
  if (!fs.existsSync(file)) return { file, text: null, rules: [] };
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const rows = tableRows(text);
  const header = rows.find((r) => r.some((c) => c.toLowerCase() === 'severity'))?.map((c) => c.toLowerCase()) || [];
  // Older files have no Stage or Check column: their rules are plan-stage with no automatic check.
  const col = (name, fallback = -1) => (header.includes(name) ? header.indexOf(name) : fallback);
  const cols = { rule: col('rule', 1), severity: col('severity', 2), stage: col('stage'), check: col('check') };
  const cell = (r, i) => (i >= 0 ? r[i] || '' : '');
  const rules = [];
  const errors = [];
  for (const r of rows.filter((x) => RULE_ID.test(x[0]))) {
    const rule = {
      id: r[0],
      rule: cell(r, cols.rule),
      severity: cell(r, cols.severity).toLowerCase(),
      stage: cell(r, cols.stage).toLowerCase() || 'plan',
      check: cell(r, cols.check).replace(/^-$/, ''),
    };
    if (rules.some((x) => x.id === rule.id)) errors.push(`${rule.id} appears more than once`);
    errors.push(...ruleErrors(rule));
    rules.push(rule);
  }
  if (errors.length) fail(`governance.md has problems:\n- ${errors.join('\n- ')}`);
  return { file, text, rules };
}

const activeRules = (root, stage) => readGovernance(root).rules.filter((r) => r.severity !== 'retired' && (!stage || r.stage === stage));

// Rewrites the rules table in place, keeping the text around it.
function writeGovernance(gov, rules) {
  const esc = (v) => String(v).replace(/\|/g, '\\|');
  const table = [
    `| ${GOVERNANCE_COLUMNS.join(' | ')} |`,
    `|${GOVERNANCE_COLUMNS.map(() => '----').join('|')}|`,
    ...rules.map((r) => `| ${r.id} | ${esc(r.rule)} | ${r.severity} | ${r.stage} | ${r.check || '-'} |`),
  ];
  const lines = gov.text.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|') && /\|\s*severity\s*\|/i.test(l));
  if (start < 0) fail('governance.md has no rules table (a header row with a Severity column).');
  let end = start;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  lines.splice(start, end - start, ...table);
  fs.writeFileSync(gov.file, lines.join('\n'));
}

// ---------- automatic checks ----------

const bodyLines = (body) => body.replace(/\r\n?/g, '\n').split('\n');

// [start, end) of the `## ` section whose heading matches `re`, or null.
function sectionRange(lines, re) {
  const start = lines.findIndex((l) => /^##\s/.test(l) && re.test(l.replace(/^##\s+/, '')));
  if (start < 0) return null;
  const n = lines.slice(start + 1).findIndex((l) => /^#{1,2}\s/.test(l));
  return [start, n < 0 ? lines.length : start + 1 + n];
}

function section(body, re) {
  const lines = bodyLines(body);
  const r = sectionRange(lines, re);
  return r ? lines.slice(r[0] + 1, r[1]).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim() : null;
}

// Adds a line at the end of a `## ` section, creating the section at the end of the body if it is missing.
function appendToSection(body, re, heading, line) {
  const lines = bodyLines(body);
  const r = sectionRange(lines, re);
  if (r) {
    let end = r[1];
    while (end > r[0] + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, line);
  } else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push('', `## ${heading}`, '', line, '');
  }
  return lines.join('\n');
}

// The goal's cancel and reopen log. The script writes it; it is history, not plan.
const CANCELLATIONS = /^cancellations\b/i;

function withoutSection(body, re) {
  const lines = bodyLines(body);
  const r = sectionRange(lines, re);
  if (r) lines.splice(r[0], r[1] - r[0]);
  return lines.join('\n');
}

// Non-empty bullet items, with or without a checkbox.
const listItems = (text) => (text || '').split('\n')
  .map((l) => l.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.*)$/)?.[1].trim())
  .filter(Boolean);

// Acceptance criteria still written as `- [ ] …`.
const unticked = (body) => (section(body, /acceptance criteria/i) || '').split('\n')
  .map((l) => l.match(/^\s*[-*]\s+\[ \]\s*(.+)$/)?.[1].trim())
  .filter(Boolean);

function adrProblems(root, d) {
  const linked = Array.isArray(d.adrs) && d.adrs.length > 0;
  if (!linked) return d.adrs === 'none' && d.adr_reason ? [] : ['link an ADR (adr new/link) or record `adr none --reason`'];
  const status = new Map(listAdrs(root).map((a) => [a.id, a.status]));
  return d.adrs.filter((id) => !ADR_SETTLED.has(status.get(id))).map((id) => `${id} (${status.get(id) || 'missing'}) not accepted yet`);
}

// Checks a rule can name in its Check column. Each returns problems; an empty list means the rule holds.
// They only test what is mechanical (presence, structure); whether content is good stays with the review.
const CHECKS = {
  'goal-defined': ({ goal }) => {
    const { body } = readDoc(goal.file);
    return [
      ...(section(body, /^problem\b/i) ? [] : ['goal has no Problem statement']),
      ...(listItems(section(body, /acceptance criteria/i)).length ? [] : ['goal has no acceptance criteria']),
    ];
  },
  'tasks-verifiable': ({ tasks }) => (tasks.length ? tasks.flatMap((t) => {
    const verify = String(t.verify ?? '').trim();
    return [
      ...(verify && !/^manual:\s*$/i.test(verify) ? [] : [`${t.id} has no verify command or manual check`]),
      ...(listItems(section(readDoc(t.file).body, /acceptance criteria/i)).length ? [] : [`${t.id} has no acceptance criteria`]),
    ];
  }) : ['goal has no tasks']),
  'dag-valid': ({ tasks }) => analyzeDag(tasks).errors,
  'adr-recorded': ({ root, goal }) => adrProblems(root, readDoc(goal.file).data),
  // Unresolved questions are recorded under Risks & Unknowns as `- **Open:** <question>`.
  'questions-resolved': ({ goal }) => listItems(section(readDoc(goal.file).body, /^risks\b/i))
    .filter((item) => /^open:/i.test(item.replace(/\*/g, '')))
    .map((item) => `open question: ${item.replace(/\*/g, '').replace(/^open:\s*/i, '')}`),
  // Every acceptance criterion of the goal and of each done task is ticked. Skipped tasks don't count.
  'criteria-met': ({ goal, tasks }) => [
    ...unticked(readDoc(goal.file).body).map((c) => `goal criterion not met: ${c}`),
    ...tasks.filter((t) => t.status !== 'skipped').flatMap((t) => unticked(readDoc(t.file).body).map((c) => `${t.id} criterion not met: ${c}`)),
  ],
};

function runChecks(root, goal, rules) {
  const ctx = { root, goal, tasks: listTasks(goal) };
  return rules.filter((r) => r.check).map((r) => {
    const problems = CHECKS[r.check](ctx);
    return { rule: r.id, check: r.check, ok: problems.length === 0, problems };
  });
}

// Hash of what the plan review judged: goal text, planned task fields and text, linked ADR statuses and plan rules.
// Progress (status, verify results, ticked boxes, task Notes) and the goal's Cancellations log are left out, so doing
// the work, or pausing it, never invalidates it.
function planFingerprint(root, goal) {
  const norm = (body) => bodyLines(body).map((l) => l.replace(/\[[xX]\]/g, '[ ]').trimEnd()).join('\n').trim();
  const g = readDoc(goal.file);
  const adrStatus = new Map(listAdrs(root).map((a) => [a.id, a.status]));
  const plan = {
    goal: [g.data.title, g.data.adrs, g.data.adr_reason, norm(withoutSection(g.body, CANCELLATIONS))],
    tasks: listTasks(goal).map((t) => [t.id, t.title, t.depends_on, t.risk, String(t.verify ?? ''), norm(withoutSection(readDoc(t.file).body, /^notes\b/i))]),
    adrs: (Array.isArray(g.data.adrs) ? g.data.adrs : []).map((id) => [id, adrStatus.get(id)]),
    rules: activeRules(root, 'plan').map((r) => [r.id, r.rule, r.severity, r.check]),
  };
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

// ---------- gates ----------

function requireStep(root, goal, step) {
  const d = goal.data;
  const problems = [];
  if (goal.status === 'cancelled') problems.push(`goal is cancelled; reopen it with \`state move ${goal.id} pending\` first`);
  if (step === 'challenge') {
    if (!['pending', 'cancelled'].includes(goal.status)) problems.push(`goal is ${goal.status}; challenge only runs on pending goals`);
  } else if (step === 'adr') {
    if (goal.status === 'completed') problems.push('goal is already completed');
    if (d.gate_challenge !== 'done') problems.push('run /aisdlc:challenge first (gate_challenge != done)');
  } else if (step === 'govern') {
    if (goal.status === 'completed') problems.push('goal is already completed');
    if (d.gate_challenge !== 'done') problems.push('run /aisdlc:challenge first (gate_challenge != done)');
    if (d.gate_adr !== 'done') problems.push('run /aisdlc:adr first (gate_adr != done)');
  } else if (step === 'implement' || step === 'final') {
    if (goal.status === 'completed') problems.push('goal is already completed');
    if (d.gate_govern !== 'passed') problems.push(`run /aisdlc:govern ${goal.id} first (gate_govern = ${d.gate_govern || 'pending'})`);
    else if (!d.govern_fingerprint) problems.push(`governance passed before aisdlc 0.2.0, which records what it reviewed; re-run /aisdlc:govern ${goal.id}`);
    else if (d.govern_fingerprint !== planFingerprint(root, goal)) {
      problems.push(`the plan (goal, tasks, linked ADRs or plan rules) changed after governance passed; re-run /aisdlc:govern ${goal.id}`);
    }
    const p = goalProgress(listTasks(goal));
    if (!p.dag_ok) problems.push(`task DAG invalid: ${p.dag_errors.join('; ')}`);
    if (p.total === 0) problems.push('goal has no tasks');
    if (step === 'final') {
      if (!p.complete) problems.push('not every task is done or skipped yet');
      if (!activeRules(root, 'final').length) problems.push('governance.md has no active final-stage rules, so there is nothing to review');
    }
  } else fail(`Unknown step "${step}". Valid: challenge, adr, govern, implement, final`);
  return problems;
}

function readReview(file) {
  const doc = readDoc(file);
  const results = new Map();
  for (const r of tableRows(doc.body)) {
    const id = r[0].match(/[A-Z][A-Z0-9]*-\d+/)?.[0];
    if (id) results.set(id, { result: (r[1] || '').toLowerCase().replace(/[^a-z/]/g, ''), notes: r[2] || '' });
  }
  return { data: doc.data, results };
}

// Problems that stop a governance review from counting as a pass.
function reviewProblems(root, goal, stage) {
  const name = REVIEW_FILE[stage];
  const file = path.join(goal.dir, name);
  if (!fs.existsSync(file)) return [`${name} is required`];
  const review = readReview(file);
  const problems = [];
  if (review.data.result !== 'pass') problems.push(`${name}: \`result\` is not \`pass\``);
  if (review.data.goal && review.data.goal !== goal.id) problems.push(`${name}: review is for ${review.data.goal}, not ${goal.id}`);
  if (review.data.stage && review.data.stage !== stage) problems.push(`${name}: review is for stage ${review.data.stage}, not ${stage}`);
  const rules = activeRules(root, stage);
  const checks = new Map(runChecks(root, goal, rules).map((c) => [c.rule, c]));
  for (const rule of rules) {
    const r = review.results.get(rule.id);
    const check = checks.get(rule.id);
    if (!r) problems.push(`${rule.id} is missing from the review table`);
    else if (!['pass', 'fail', 'n/a'].includes(r.result)) problems.push(`${rule.id} has result "${r.result}" (use pass, fail or n/a)`);
    else if (check && !check.ok && r.result !== 'fail') problems.push(`${rule.id} is ${r.result} but its automatic check "${check.check}" failed: ${check.problems.join('; ')}`);
    else if (r.result === 'fail' && rule.severity === 'must') problems.push(`${rule.id} is a must rule and failed`);
    // A pass needs its evidence as much as a fail needs its reason.
    else if (!r.notes) problems.push(`${rule.id} is ${r.result} without a note (cite the evidence)`);
  }
  return problems;
}

// Moves a review aside as <name>.stale-N.md, never overwriting an earlier one. Returns the new name, or null.
function archiveReview(goal, stage) {
  const file = path.join(goal.dir, REVIEW_FILE[stage]);
  if (!fs.existsSync(file)) return null;
  const base = REVIEW_FILE[stage].replace(/\.md$/, '');
  let n = 1;
  while (fs.existsSync(path.join(goal.dir, `${base}.stale-${n}.md`))) n++;
  const name = `${base}.stale-${n}.md`;
  fs.renameSync(file, path.join(goal.dir, name));
  return name;
}

const GATE_ORDER = ['adr', 'govern', 'final'];

// Refuses changes to a completed or cancelled goal.
function assertOpen(goal) {
  if (goal.status === 'completed') fail(`${goal.id} is completed; it can no longer change.`);
  if (goal.status === 'cancelled') fail(`${goal.id} is cancelled; reopen it with \`state move ${goal.id} pending\` first.`);
}

// Resets `from` and every later gate to pending, and archives the reviews that no longer count.
function invalidate(goal, from) {
  const d = readDoc(goal.file).data;
  const rerun = { adr: `/aisdlc:adr ${goal.id}`, govern: `/aisdlc:govern ${goal.id}`, final: `/aisdlc:govern ${goal.id} --final` };
  const patch = {};
  const notes = [];
  for (const gate of GATE_ORDER.slice(GATE_ORDER.indexOf(from))) {
    if (d[`gate_${gate}`] && d[`gate_${gate}`] !== 'pending') {
      patch[`gate_${gate}`] = 'pending';
      notes.push(`gate_${gate} reset to pending; re-run ${rerun[gate]}`);
    }
    if (gate === 'govern' && d.govern_fingerprint) patch.govern_fingerprint = '';
    const stage = { govern: 'plan', final: 'final' }[gate];
    const archived = stage && archiveReview(goal, stage);
    if (archived) notes.push(`${REVIEW_FILE[stage]} is now stale (moved to ${archived})`);
  }
  if (Object.keys(patch).length) updateDoc(goal.file, patch);
  return notes;
}

function setGate(root, goal, gate, value) {
  const allowed = { challenge: ['pending', 'done'], adr: ['pending', 'done'], govern: ['pending', 'passed', 'failed'], final: ['pending', 'passed', 'failed'] };
  if (!allowed[gate]) fail(`Unknown gate "${gate}". Valid: ${Object.keys(allowed).join(', ')}`);
  if (!allowed[gate].includes(value)) fail(`Invalid value for gate ${gate}: ${value}. Valid: ${allowed[gate].join(', ')}`);
  assertOpen(goal);
  if (gate === 'adr' && value === 'done') {
    const problems = adrProblems(root, goal.data);
    if (problems.length) fail(`Cannot mark adr done: ${problems.join(', ')}.`);
  }
  const stage = { govern: 'plan', final: 'final' }[gate];
  if (stage && value === 'passed') {
    const problems = [...(gate === 'final' ? requireStep(root, goal, 'final') : []), ...reviewProblems(root, goal, stage)];
    if (problems.length) fail(`Cannot mark ${gate} passed:\n- ${problems.join('\n- ')}`);
  }
  // A new answer at one gate invalidates everything after it. Setting a review gate to pending starts a
  // fresh review, so the current one is archived.
  let notes = [];
  if (gate === 'challenge' || gate === 'adr') notes = invalidate(goal, 'govern');
  else if (value === 'pending') notes = invalidate(goal, gate);
  else if (gate === 'govern') notes = invalidate(goal, 'final');
  const patch = { [`gate_${gate}`]: value };
  if (gate === 'govern') patch.govern_fingerprint = value === 'passed' ? planFingerprint(root, goal) : '';
  updateDoc(goal.file, patch);
  return notes;
}

function reviewSummary(root, goal, stage) {
  const file = path.join(goal.dir, REVIEW_FILE[stage]);
  if (!fs.existsSync(file)) return null;
  const r = readReview(file);
  // Failed rules in a passing review are the `should` rules that did not block; keep them visible.
  const failed = [...r.results].filter(([, v]) => v.result === 'fail').map(([rule, v]) => ({ rule, notes: v.notes }));
  return { file: path.relative(root, file), result: r.data.result || null, failed };
}

// ---------- commands ----------

const commands = {
  init(_pos, opts) {
    const root = path.resolve(opts.dir || process.cwd());
    const base = aisdlcDir(root);
    const created = [];
    for (const d of [...GOAL_STATES.map((s) => path.join('goals', s)), 'adr', 'stacks', 'cache']) {
      const full = path.join(base, d);
      if (!fs.existsSync(full)) { fs.mkdirSync(full, { recursive: true }); created.push(full); }
      const keep = path.join(full, '.gitkeep');
      if (!fs.existsSync(keep) && d !== 'cache') fs.writeFileSync(keep, '');
    }
    writeIfMissing(path.join(base, 'config.json'), fs.readFileSync(path.join(TEMPLATES, 'config.json'), 'utf8'), created);
    writeIfMissing(path.join(base, 'governance.md'), fs.readFileSync(path.join(TEMPLATES, 'governance.md'), 'utf8'), created);
    writeIfMissing(path.join(base, 'cache', '.gitignore'), '*\n!.gitignore\n', created);
    const cfg = loadConfig(root);
    if (opts.stack) cfg.stack = opts.stack;
    if (opts.graph) cfg.graph = { ...cfg.graph, provider: opts.graph };
    if (opts['base-branch']) cfg.git = { ...cfg.git, base_branch: opts['base-branch'] };
    saveConfig(root, cfg);
    registrySync(root);
    out({ root, created: created.map((f) => path.relative(root, f)), config: cfg, detected_stacks: detectStacks(root) });
  },

  'detect-stack'() {
    const root = findRoot();
    const cfg = loadConfig(root);
    const stack = activeStack(root, cfg);
    out({ configured: cfg.stack || 'auto', detected: detectStacks(root), active: stack, manifest_installed: !!loadStackManifest(root, stack), standards_skill: loadStackManifest(root, stack)?.standards_skill || null });
  },

  config([action, key, value]) {
    const root = findRoot();
    const cfg = loadConfig(root);
    if (action === 'get') return out(key ? getPath(cfg, key) ?? null : cfg);
    if (action === 'set') {
      if (!key || value === undefined) fail('Usage: config set <dot.path> <value>');
      let v;
      try { v = JSON.parse(value); } catch { v = value; }
      setPath(cfg, key, v);
      saveConfig(root, cfg);
      return out({ [key]: v });
    }
    fail('Usage: config get [dot.path] | config set <dot.path> <value>');
  },

  goal([action, ...rest], opts) {
    const root = findRoot();
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: goal new <title>');
      const id = nextId('G', listGoals(root).map((g) => g.id), 3);
      const dir = path.join(aisdlcDir(root), 'goals', 'pending', `${id}-${slugify(title)}`);
      const content = render('goal.md', { id, title, date: today() });
      fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'goal.md'), content);
      registrySync(root);
      return out({ id, dir: path.relative(root, dir), file: path.relative(root, path.join(dir, 'goal.md')) });
    }
    if (action === 'list') {
      const match = statusFilter(opts.status, GOAL_STATES);
      return out(listGoals(root).filter((g) => match(g.status)).map((g) => ({
        id: g.id, title: g.title, status: g.status, dir: path.relative(root, g.dir),
        gates: gatesOf(g), next: nextStep(root, g),
      })));
    }
    if (action === 'preflight') {
      const g = getGoal(root, rest[0]);
      const base = loadConfig(root).git?.base_branch || 'develop';
      const commands = resolveHookFor(root, 'before_goal', { goal: g.id }).commands;
      const switches = commands.some((c) => /\bgit\s+(checkout|switch)\b/.test(c));
      const others = listGoals(root).filter((x) => x.status === 'in-progress' && x.id !== g.id).map((x) => x.id);
      const warnings = [];
      if (switches) {
        const goalFile = path.relative(root, g.file).split(path.sep).join('/');
        const baseRef = [base, `origin/${base}`].find((r) => git(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]) !== null);
        const committed = !!git(root, ['ls-files', '--', goalFile])?.trim();
        if (others.length) warnings.push(`${others.join(', ')} ${others.length > 1 ? 'are' : 'is'} in progress. Switching branches moves the working tree away from that work, unless it lives in another worktree.`);
        if (!baseRef) warnings.push(`The base branch ${base} exists neither locally nor as origin/${base}, so the before_goal hook may fail.`);
        else if (committed && !git(root, ['ls-tree', '--name-only', baseRef, '--', goalFile])?.trim()) {
          warnings.push(`The goal's planning files are committed on the current branch but not on ${baseRef}, so the checkout leaves them behind. Bring .aisdlc/ onto ${base} first, or disable the before_goal hook.`);
        }
      }
      return out({ goal: g.id, before_goal: commands, switches_branch: switches, base_branch: base, other_in_progress: others, warnings });
    }
    if (action === 'show') {
      const g = getGoal(root, rest[0]);
      const tasks = listTasks(g);
      return out({
        id: g.id, title: g.title, status: g.status, dir: path.relative(root, g.dir),
        gates: gatesOf(g), next: nextStep(root, g),
        final_review_required: activeRules(root, 'final').length > 0,
        governance: { plan: reviewSummary(root, g, 'plan'), final: reviewSummary(root, g, 'final') },
        ...(g.status === 'cancelled' && { cancel_reason: g.data.cancel_reason || null }),
        cancellations: listItems(section(readDoc(g.file).body, CANCELLATIONS)),
        adrs: g.data.adrs, auto_commit: g.data.auto_commit, branch: g.data.branch,
        suggested_branch: hookContext(root, loadConfig(root), { goal: g.id }).goal_branch,
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk, depends_on: t.depends_on, verify: t.verify, file: path.relative(root, t.file) })),
        progress: goalProgress(tasks),
      });
    }
    if (action === 'set') {
      const [id, key, value] = rest;
      if (!id || !key || value === undefined) fail('Usage: goal set <G-id> <key> <value>');
      if (['id', 'status', 'adrs', 'adr_reason', 'govern_fingerprint'].includes(key) || key.startsWith('gate_')) fail('Use `state move`, `gate set` or `adr link|none` for status, gates and ADR links.');
      // The branch is substituted into hook commands, so keep it to git-ref-safe characters.
      if (key === 'branch' && !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value)) fail(`Invalid branch name "${value}".`);
      if (key === 'cancel_reason') fail('Use `state move <G-id> cancelled --reason "<why>"` to cancel a goal.');
      const g = getGoal(root, id);
      assertOpen(g);
      updateDoc(g.file, { [key]: parseScalar(value, key) });
      return out({ id, [key]: parseScalar(value, key) });
    }
    fail('Usage: goal new|list|show|set');
  },

  state([action, id, status], opts) {
    if (action !== 'move' || !id || !status) fail('Usage: state move <G-id> <pending|in-progress|blocked|completed|cancelled> [--reason "<why>"]');
    if (!GOAL_STATES.includes(status)) fail(`Invalid goal status "${status}". Valid: ${GOAL_STATES.join(', ')}`);
    const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
    if (status === 'cancelled' && !reason) fail('--reason is required when cancelling a goal');
    if (status !== 'cancelled' && typeof opts.reason === 'string') fail('--reason is only used when cancelling a goal');
    const root = findRoot();
    const g = getGoal(root, id);
    if (g.status === 'completed') fail(`${id} is completed; it can no longer move.`);
    if (!GOAL_MOVES[g.status].includes(status)) {
      fail(`${id} is ${g.status}; it can't move to ${status}. From ${g.status} it can move to: ${GOAL_MOVES[g.status].join(', ')}.`);
    }
    const started = listTasks(g).filter((t) => t.status !== 'pending').map((t) => t.id);
    if (status === 'pending' && started.length) {
      fail(`${id} can't go back to pending: ${started.join(', ')} already started. ${g.status === 'cancelled'
        ? `Reopen it with \`state move ${id} blocked\` and resume it with /aisdlc:implement ${id}.`
        : 'Add tasks for new scope (governance runs again), or cancel the goal and create a new one.'}`);
    }
    if (g.status === 'cancelled' && status === 'blocked' && !started.length) fail(`None of ${id}'s tasks has started; reopen it with \`state move ${id} pending\`.`);
    if (status === 'in-progress' || status === 'completed') {
      const problems = requireStep(root, g, 'implement');
      if (problems.length) fail(`Cannot move ${id} to ${status}:\n- ${problems.join('\n- ')}`);
    }
    if (status === 'completed') {
      if (!goalProgress(listTasks(g)).complete) fail(`${id} still has unfinished tasks; cannot complete.`);
      if (activeRules(root, 'final').length && g.data.gate_final !== 'passed') fail(`${id} needs a passing final governance review; run /aisdlc:govern ${id} --final.`);
    }
    const dest = path.join(aisdlcDir(root), 'goals', status, path.basename(g.dir));
    if (dest !== g.dir) {
      // Projects initialized before a state existed have no folder for it.
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(g.dir, dest);
    }
    const doc = readDoc(path.join(dest, 'goal.md'));
    Object.assign(doc.data, { status, updated: today() });
    // cancel_reason holds the current reason; the Cancellations log keeps every cancel and reopen for good.
    if (status === 'cancelled') {
      doc.data.cancel_reason = reason;
      doc.body = appendToSection(doc.body, CANCELLATIONS, 'Cancellations', `- ${today()}: cancelled while ${g.status}: ${reason}`);
    } else if (g.status === 'cancelled') {
      doc.data.cancel_reason = '';
      doc.body = appendToSection(doc.body, CANCELLATIONS, 'Cancellations', `- ${today()}: reopened as ${status}`);
    }
    writeDoc(path.join(dest, 'goal.md'), doc);
    registrySync(root);
    out({ id, from: g.status, to: status, dir: path.relative(root, dest), ...(reason && { reason }) });
  },

  task([action, goalId, ...rest], opts) {
    const root = findRoot();
    const g = getGoal(root, goalId);
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: task new <G-id> <title> [--depends T-01,T-02] [--risk high|medium|low] [--verify "<cmd>"]');
      assertOpen(g);
      const risk = opts.risk || 'medium';
      if (!(risk in RISK_RANK)) fail(`Invalid risk "${risk}"`);
      const tasks = listTasks(g);
      const id = nextId('T', tasks.map((t) => t.id), 2);
      const depends = typeof opts.depends === 'string' ? opts.depends.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const unknown = depends.filter((d) => !tasks.some((t) => t.id === d));
      if (unknown.length) fail(`Unknown dependencies: ${unknown.join(', ')} (create them first)`);
      const file = path.join(g.dir, 'tasks', `${id}-${slugify(title)}.md`);
      fs.writeFileSync(file, render('task.md', { id, goal: g.id, title, depends_on: depends, risk }));
      if (typeof opts.verify === 'string') updateDoc(file, { verify: opts.verify });
      // A task added after governance was never reviewed, so governance has to run again.
      const notes = invalidate(g, 'govern');
      return out({ id, file: path.relative(root, file), notes });
    }
    if (action === 'set') {
      const [taskId, status] = rest;
      if (!TASK_STATES.includes(status)) fail(`Invalid task status "${status}". Valid: ${TASK_STATES.join(', ')}`);
      if ((status === 'blocked' || status === 'skipped') && typeof opts.reason !== 'string') fail(`--reason is required when marking a task ${status}`);
      const tasks = listTasks(g);
      const t = getTask(g, taskId);
      assertOpen(g);
      // Resetting to pending is how a blocked goal is resumed; every other change needs a started goal.
      if (status !== 'pending' && g.status !== 'in-progress') fail(`${g.id} is ${g.status}; run \`state move ${g.id} in-progress\` first.`);
      if (status === 'in-progress' || status === 'done') {
        const problems = requireStep(root, g, 'implement');
        if (problems.length) fail(`Cannot set ${taskId} ${status}:\n- ${problems.join('\n- ')}`);
        const byId = new Map(tasks.map((x) => [x.id, x]));
        const unmet = t.depends_on.filter((d) => !TASK_SATISFIED.has(byId.get(d)?.status));
        if (unmet.length) fail(`${taskId} depends on unfinished tasks: ${unmet.join(', ')}`);
      }
      if (status === 'done') {
        if (t.status !== 'in-progress') fail(`${taskId} is ${t.status}; only an in-progress task can be marked done.`);
        if (t.verified !== 'pass') fail(`${taskId} has not passed verification; run \`task verify ${g.id} ${taskId}\` first.`);
      }
      const patch = { status, reason: typeof opts.reason === 'string' ? opts.reason : '' };
      if (status !== 'done') Object.assign(patch, { verified: '', verify_evidence: '' });
      updateDoc(t.file, patch);
      // The final review judged the finished tasks; any change to them means it has to run again.
      const notes = invalidate(g, 'final');
      writeTasksMd(g);
      registrySync(root);
      return out({ goal: g.id, task: taskId, status, progress: goalProgress(listTasks(g)), notes });
    }
    if (action === 'verify') {
      // Runs the task's verify command, then the after_task hook, and records the result `done` requires.
      const [taskId] = rest;
      const t = getTask(g, taskId);
      assertOpen(g);
      if (t.status !== 'in-progress') fail(`${taskId} is ${t.status}; only an in-progress task can be verified.`);
      const verify = t.verify === '' || t.verify == null ? '' : String(t.verify).trim();
      const manual = verify.match(/^manual:\s*(.*)$/i);
      const hook = resolveHookFor(root, 'after_task', { goal: g.id, task: taskId });
      const evidence = typeof opts.evidence === 'string' && opts.evidence.trim() ? opts.evidence : '';
      // With no verify command and no after_task hook nothing would run, so a pass needs evidence like a manual check.
      const byHand = manual || (!verify && !hook.commands.length);
      if (byHand && !evidence) {
        fail(manual
          ? `${taskId} has a manual check ("${manual[1]}"); pass --evidence "<what you checked and saw>".`
          : `${taskId} has no verify command and no after_task hook, so nothing would run; check it by hand and pass --evidence "<what you checked and saw>".`);
      }
      const steps = [];
      if (verify && !manual) steps.push([`${taskId} verify`, [verify]]);
      if (hook.commands.length) steps.push([`hook after_task (${hook.source})`, hook.commands]);
      let code = 0;
      for (const [label, cmds] of steps) if ((code = runCommands(root, label, cmds))) break;
      updateDoc(t.file, { verified: code ? 'fail' : 'pass', verify_evidence: byHand ? evidence : '' });
      process.stdout.write(`[aisdlc] verify ${taskId}: ${code ? 'fail' : 'pass'}\n`);
      if (code) process.exitCode = code;
      return;
    }
    fail('Usage: task new|set|verify');
  },

  dag([action, goalId]) {
    const root = findRoot();
    const g = getGoal(root, goalId);
    const tasks = listTasks(g);
    if (action === 'validate') {
      const r = analyzeDag(tasks);
      out(r);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (action === 'write') return out({ ...writeTasksMd(g), file: path.relative(root, path.join(g.dir, 'tasks.md')) });
    if (action === 'next') return out(goalProgress(tasks));
    fail('Usage: dag validate|write|next <G-id>');
  },

  gate([action, goalId, a, b]) {
    const root = findRoot();
    const g = getGoal(root, goalId);
    if (action === 'require') {
      const problems = requireStep(root, g, a);
      out({ goal: g.id, step: a, ok: problems.length === 0, problems });
      if (problems.length) process.exitCode = 1;
      return;
    }
    if (action === 'set') {
      const notes = setGate(root, g, a, b);
      registrySync(root);
      return out({ goal: g.id, gate: a, value: b, notes });
    }
    fail('Usage: gate require <G-id> <step> | gate set <G-id> <gate> <value>');
  },

  adr([action, ...rest], opts) {
    const root = findRoot();
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: adr new <title> [--goal G-001]');
      if (typeof opts.goal === 'string') assertOpen(getGoal(root, opts.goal));
      const id = nextId('ADR', listAdrs(root).map((a) => a.id), 3);
      const goals = typeof opts.goal === 'string' ? [opts.goal] : [];
      const file = path.join(aisdlcDir(root), 'adr', `${id}-${slugify(title)}.md`);
      fs.writeFileSync(file, render('adr.md', { id, title, goals, date: today() }));
      const notes = goals.length ? linkAdr(root, id, goals[0]) : [];
      registrySync(root);
      return out({ id, file: path.relative(root, file), notes });
    }
    if (action === 'link') {
      const [adrId, goalId] = rest;
      const notes = linkAdr(root, adrId, goalId);
      registrySync(root);
      return out({ adr: adrId, goal: goalId, notes });
    }
    if (action === 'none') {
      const [goalId] = rest;
      if (typeof opts.reason !== 'string' || !opts.reason.trim()) fail('Usage: adr none <G-id> --reason "<why no decision is needed>"');
      const g = getGoal(root, goalId);
      assertOpen(g);
      // Drop the back-links from ADRs this goal used to reference.
      const prev = Array.isArray(g.data.adrs) ? g.data.adrs : [];
      for (const a of listAdrs(root)) {
        if (prev.includes(a.id) && Array.isArray(a.goals)) updateDoc(a.file, { goals: a.goals.filter((x) => x !== goalId) });
      }
      const changed = g.data.adrs !== 'none' || g.data.adr_reason !== opts.reason;
      updateDoc(g.file, { adrs: 'none', adr_reason: opts.reason });
      const notes = changed ? invalidate(g, 'adr') : [];
      registrySync(root);
      return out({ goal: goalId, adrs: 'none', reason: opts.reason, notes });
    }
    if (action === 'list') {
      const match = statusFilter(opts.status);
      return out(listAdrs(root).filter((a) => match(a.status)).map((a) => ({
        id: a.id, title: a.title, status: a.status, goals: Array.isArray(a.goals) ? a.goals : [], file: path.relative(root, a.file),
      })));
    }
    fail('Usage: adr new|link|none|list');
  },

  hooks([action, point], opts) {
    // Before init there is no .aisdlc/ yet (pre_init); resolve from env and core defaults in cwd.
    const root = findRoot(process.cwd(), false) ?? process.cwd();
    if (action === 'list') return out(HOOK_POINTS.map((p) => resolveHookFor(root, p, opts)));
    if (!point) fail('Usage: hooks resolve|run <point> [--goal G-id] [--task T-id]');
    const r = resolveHookFor(root, point, opts);
    if (action === 'resolve') return out(r);
    if (action === 'run') {
      if (!r.commands.length) {
        process.stdout.write(`[aisdlc] hook ${point}: nothing to run (${r.source}${r.note ? `, ${r.note}` : ''})\n`);
        return;
      }
      process.exitCode = runCommands(root, `hook ${point} (${r.source})`, r.commands);
      return;
    }
    fail('Usage: hooks list | hooks resolve|run <point>');
  },

  governance([action, ...rest], opts) {
    const root = findRoot();
    const gov = readGovernance(root);
    if (action === 'list') return out(gov.rules);
    if (action === 'checks') {
      const stage = opts.stage || 'plan';
      if (!RULE_STAGES.includes(stage)) fail(`Invalid stage "${stage}". Valid: ${RULE_STAGES.join(', ')}`);
      return out(runChecks(root, getGoal(root, rest[0]), activeRules(root, stage)));
    }
    if (action === 'review') {
      const g = getGoal(root, rest[0]);
      assertOpen(g);
      const stage = opts.stage || 'plan';
      if (!RULE_STAGES.includes(stage)) fail(`Invalid stage "${stage}". Valid: ${RULE_STAGES.join(', ')}`);
      const file = path.join(g.dir, REVIEW_FILE[stage]);
      const gate = stage === 'plan' ? 'govern' : 'final';
      if (fs.existsSync(file)) fail(`${path.relative(root, file)} already exists. Run \`gate set ${g.id} ${gate} pending\` first; it archives the old review.`);
      const rules = activeRules(root, stage);
      const checks = new Map(runChecks(root, g, rules).map((c) => [c.rule, c]));
      const cell = (v) => v.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
      // A failed automatic check can only be a fail, so its row is filled in; every other row is left to the reviewer.
      const rows = rules.map((r) => {
        const c = checks.get(r.id);
        return c && !c.ok ? `| ${r.id} | fail | ${cell(`check ${c.check}: ${c.problems.join('; ')}`)} |` : `| ${r.id} |  |  |`;
      });
      const text = render('governance-review.md', { goal: g.id, stage, result: '', date: today() }).replace(/(\|-+\|-+\|-+\|\n)/, `$1${rows.map((r) => `${r}\n`).join('')}`);
      fs.writeFileSync(file, text);
      return out({
        file: path.relative(root, file),
        rules: rules.map((r) => {
          const c = checks.get(r.id);
          return { id: r.id, rule: r.rule, severity: r.severity, ...(c && { check: c.check, check_ok: c.ok, ...(!c.ok && { problems: c.problems }) }) };
        }),
      });
    }
    if (action !== 'add' && action !== 'set') fail('Usage: governance list | checks <G-id> [--stage plan|final] | review <G-id> [--stage plan|final] | add <rule> --severity must|should --stage plan|final [--check <name>] | set <rule-id> rule|severity|stage|check <value>');
    if (gov.text === null) fail('No .aisdlc/governance.md; run init first.');
    let rule;
    if (action === 'add') {
      const text = rest.join(' ').trim();
      if (!text || typeof opts.severity !== 'string' || typeof opts.stage !== 'string') {
        fail('Usage: governance add <rule> --severity must|should --stage plan|final [--check <name>]');
      }
      rule = { id: nextId('GOV', gov.rules.map((r) => r.id), 2), rule: text, severity: opts.severity.toLowerCase(), stage: opts.stage.toLowerCase(), check: typeof opts.check === 'string' ? opts.check.replace(/^-$/, '') : '' };
      gov.rules.push(rule);
    } else {
      const [id, field, ...value] = rest;
      if (!['rule', 'severity', 'stage', 'check'].includes(field) || !value.length) fail('Usage: governance set <rule-id> rule|severity|stage|check <value>');
      // IDs never change and rules are never deleted: reviews reference them. Retire with `severity retired`.
      rule = gov.rules.find((r) => r.id === id) || fail(`Rule ${id} not found.`);
      const v = value.join(' ').trim();
      rule[field] = field === 'rule' ? v : field === 'check' ? v.replace(/^-$/, '') : v.toLowerCase();
    }
    const errors = ruleErrors(rule);
    if (errors.length) fail(errors.join('\n'));
    writeGovernance(gov, gov.rules);
    return out(rule);
  },

  registry([action, ...words]) {
    const root = findRoot();
    if (action === 'search') return out(registrySearch(root, words));
    if (action !== 'sync') fail('Usage: registry sync | search <keywords>');
    const rel = (name) => path.relative(root, path.join(aisdlcDir(root), name));
    out({ ...registrySync(root), file: rel('registry.md'), archive: rel('registry-archive.md') });
  },

  graph([action, ...words], opts) {
    const root = findRoot();
    const { provider } = graphConfig(root);
    if (action === 'status') {
      const tool = graphTool(root);
      const warnings = graphWarnings(root);
      return out({ provider, dir: GRAPH_DIR, ...tool, aisdlc_ignored: graphIgnoreOk(root), ...graphFreshness(root), ...(warnings.length && { warnings }) });
    }
    if (action === 'setup') {
      const tool = graphTool(root);
      if (!tool.installed || !tool.supported) fail(`${tool.installed ? `Graphify ${tool.version || ''} lacks ${tool.missing.join(', ')}.` : 'Graphify is not installed.'} ${GRAPH_INSTALL}`);
      const ignore = path.join(root, '.graphifyignore');
      const addedIgnore = !graphIgnoreOk(root);
      if (addedIgnore) {
        const text = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
        fs.writeFileSync(ignore, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.aisdlc/\n`);
      }
      const cfg = loadConfig(root);
      cfg.graph = { provider: 'graphify' };
      saveConfig(root, cfg);
      // Setup always rebuilds, so running it again picks up file types a newly installed Graphify extra can parse.
      return out({ provider: 'graphify', version: tool.version, dir: GRAPH_DIR, ignore_added: addedIgnore, ...graphUpdate(root, true) });
    }
    if (provider !== 'graphify') {
      if (action === 'update' || action === 'query') return out({ provider, note: 'No code graph is set up; search the code directly.' });
      fail('Usage: graph status | setup | update | query "<question>" [--budget N]');
    }
    if (action === 'update') return out(graphUpdate(root));
    if (action === 'query') {
      const question = words.join(' ').trim();
      if (!question) fail('Usage: graph query "<question>" [--budget N]');
      const budget = opts.budget === undefined ? DEFAULT_BUDGET : Number(opts.budget);
      if (!Number.isInteger(budget) || budget < 100) fail('--budget must be a whole number of tokens, 100 or more');
      let refresh;
      try { refresh = graphUpdate(root); } catch (e) {
        // A missing or broken Graphify must never block the workflow: the graph is only an optimization.
        if (!(e instanceof UserError) && e.code !== 'ENOENT') throw e;
        return out({ provider, note: `Graph unavailable (${e.code === 'ENOENT' ? 'graphify is not installed' : e.message}); search the code directly.` });
      }
      let result;
      try { result = graphify(root, ['query', question, '--budget', String(budget), '--graph', path.join(GRAPH_DIR, 'graph.json')]); } catch (e) {
        return out({ provider, note: `Graph query failed (${e.code === 'ENOENT' ? 'graphify is not installed' : String(e.stderr || e.message).trim().split('\n').pop()}); search the code directly.` });
      }
      if (refresh.updated) process.stdout.write(`[aisdlc] graph refreshed in ${refresh.ms} ms (${refresh.reason})\n`);
      if (refresh.warning) process.stdout.write(`[aisdlc] ${refresh.warning}\n`);
      process.stdout.write(result);
      // The graph holds code structure (functions, classes, imports), not data fields or text, so a miss is common.
      if (/^No matching nodes found/m.test(result)) process.stdout.write('[aisdlc] Nothing in the graph matches; search the code directly.\n');
      return;
    }
    fail('Usage: graph status | setup | update | query "<question>" [--budget N]');
  },
};

// Runs commands in order with the platform's default shell; returns the first failing exit code, or 0.
function runCommands(root, label, cmds) {
  for (const cmd of cmds) {
    process.stdout.write(`[aisdlc] ${label}: ${cmd}\n`);
    try {
      execSync(cmd, { cwd: root, stdio: 'inherit' });
    } catch (e) {
      process.stderr.write(`[aisdlc] ${label} failed (exit ${e.status ?? 1}): ${cmd}\n`);
      return e.status || 1;
    }
  }
  return 0;
}

function linkAdr(root, adrId, goalId) {
  const adr = listAdrs(root).find((a) => a.id === adrId);
  if (!adr) fail(`ADR ${adrId} not found.`);
  const g = getGoal(root, goalId);
  assertOpen(g);
  const goals = Array.isArray(adr.goals) ? adr.goals : [];
  if (!goals.includes(goalId)) updateDoc(adr.file, { goals: [...goals, goalId] });
  const adrs = Array.isArray(g.data.adrs) ? g.data.adrs : [];
  if (adrs.includes(adrId)) return [];
  updateDoc(g.file, { adrs: [...adrs, adrId], adr_reason: '' });
  // The ADR gate judged the old set of decisions; a new link has to be settled again.
  return invalidate(g, 'adr');
}

// The workflow step that moves a goal on: challenge, adr, govern, implement, reopen, or null once completed.
function nextStep(root, g) {
  const d = g.data;
  if (g.status === 'completed') return null;
  if (g.status === 'cancelled') return 'reopen';
  if (g.status === 'pending' && d.gate_challenge !== 'done') return 'challenge';
  if (d.gate_adr !== 'done') return 'adr';
  if (d.gate_govern !== 'passed' || d.govern_fingerprint !== planFingerprint(root, g)) return 'govern';
  return 'implement';
}

const gatesOf = (g) => ({ challenge: g.data.gate_challenge, adr: g.data.gate_adr, govern: g.data.gate_govern, final: g.data.gate_final || 'pending' });

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || !commands[cmd]) {
    process.stderr.write(`Usage: aisdlc.mjs <${Object.keys(commands).join('|')}> ...\n`);
    process.exit(cmd ? 1 : 0);
  }
  try {
    const { pos, opts } = parseArgs(argv);
    commands[cmd](pos, opts);
  } catch (e) {
    if (e instanceof UserError) {
      process.stderr.write(`aisdlc: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
