#!/usr/bin/env node
// aisdlc.mjs — deterministic helper for the aisdlc workflow skills.
// Zero dependencies. All state lives in <project>/.aisdlc as markdown frontmatter + JSON.
// Output is JSON on stdout (except `hooks run` and `task verify`, which stream command output); errors exit 1 with a message on stderr.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(PLUGIN_ROOT, 'templates');
const DEFAULT_HOOKS = path.join(PLUGIN_ROOT, 'defaults', 'hooks.json');

const GOAL_STATES = ['pending', 'in-progress', 'blocked', 'completed'];
const TASK_STATES = ['pending', 'in-progress', 'done', 'blocked', 'skipped'];
const TASK_SATISFIED = new Set(['done', 'skipped']);
const RISK_RANK = { high: 0, medium: 1, low: 2 };
const STEPS = ['init', 'create_goal', 'challenge', 'adr', 'govern', 'implement'];
const HOOK_POINTS = [
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

// Options that always take a value, even one that starts with "--" (e.g. --verify "--version").
const VALUE_OPTS = new Set(['depends', 'risk', 'verify', 'reason', 'evidence', 'goal', 'task', 'status', 'stack', 'graph', 'base-branch', 'dir']);

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (VALUE_OPTS.has(key)) {
        if (next === undefined) fail(`--${key} needs a value`);
        opts[key] = next; i++;
      } else if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
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

function registrySync(root) {
  const base = aisdlcDir(root);
  const rel = (f) => path.relative(base, f);
  const cell = (v) => (Array.isArray(v) ? v.join(', ') : formatScalar(v)).replace(/\|/g, '\\|') || '-';
  const rows = [];
  for (const g of listGoals(root)) {
    const p = goalProgress(listTasks(g));
    const status = p.total ? `${g.status} (${p.done}/${p.total})` : g.status;
    const links = g.data.adrs === 'none' ? 'adr: none' : cell(g.data.adrs);
    rows.push(`| ${g.id} | goal | ${cell(g.title)} | ${status} | ${rel(g.file)} | ${links} | ${cell(g.data.updated)} |`);
  }
  for (const a of listAdrs(root)) {
    rows.push(`| ${a.id} | adr | ${cell(a.title)} | ${cell(a.status)} | ${rel(a.file)} | ${cell(a.goals)} | ${cell(a.date)} |`);
  }
  const header = fs.readFileSync(path.join(TEMPLATES, 'registry.md'), 'utf8').trimEnd();
  fs.writeFileSync(path.join(base, 'registry.md'), `${header}\n${rows.join('\n')}${rows.length ? '\n' : ''}`);
  return rows.length;
}

// ---------- gates ----------

function requireStep(goal, step) {
  const d = goal.data;
  const problems = [];
  if (step === 'challenge') {
    if (!['pending', 'blocked'].includes(goal.status)) problems.push(`goal is ${goal.status}; challenge only runs on pending or blocked goals`);
  } else if (step === 'adr') {
    if (d.gate_challenge !== 'done') problems.push('run /aisdlc:challenge first (gate_challenge != done)');
  } else if (step === 'govern') {
    if (d.gate_challenge !== 'done') problems.push('run /aisdlc:challenge first (gate_challenge != done)');
    if (d.gate_adr !== 'done') problems.push('run /aisdlc:adr first (gate_adr != done)');
  } else if (step === 'implement') {
    if (goal.status === 'completed') problems.push('goal is already completed');
    if (d.gate_govern !== 'passed') problems.push(`run /aisdlc:govern ${goal.id} first (gate_govern = ${d.gate_govern || 'pending'})`);
    const p = goalProgress(listTasks(goal));
    if (!p.dag_ok) problems.push(`task DAG invalid: ${p.dag_errors.join('; ')}`);
    if (p.total === 0) problems.push('goal has no tasks');
  } else fail(`Unknown step "${step}". Valid: challenge, adr, govern, implement`);
  return problems;
}

// Markdown table rows as arrays of trimmed cells, skipping |---| separator rows.
function tableRows(body) {
  return body.split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s|:-]+\|?$/.test(l.trim()))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

const RULE_ID = /^[A-Z][A-Z0-9]*-\d+$/;

// Active rules from governance.md: [{ id, severity }], excluding rules whose severity is `retired`.
function governanceRules(root) {
  const file = path.join(aisdlcDir(root), 'governance.md');
  if (!fs.existsSync(file)) return [];
  const rows = tableRows(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'));
  const header = rows.find((r) => r.some((c) => c.toLowerCase() === 'severity'));
  const col = header ? header.findIndex((c) => c.toLowerCase() === 'severity') : -1;
  return rows
    .filter((r) => RULE_ID.test(r[0]))
    .map((r) => ({ id: r[0], severity: (col >= 0 ? r[col] : r.at(-1) || '').toLowerCase() }))
    .filter((r) => r.severity !== 'retired');
}

// Problems that stop a governance review from counting as a pass.
function reviewProblems(root, goal, review) {
  const doc = readDoc(review);
  const problems = [];
  if (doc.data.result !== 'pass') problems.push('`result` is not `pass`');
  if (doc.data.goal && doc.data.goal !== goal.id) problems.push(`review is for ${doc.data.goal}, not ${goal.id}`);
  const results = new Map();
  for (const r of tableRows(doc.body)) {
    const id = r[0].match(/[A-Z][A-Z0-9]*-\d+/)?.[0];
    if (id) results.set(id, { result: (r[1] || '').toLowerCase().replace(/[^a-z/]/g, ''), notes: r[2] || '' });
  }
  for (const rule of governanceRules(root)) {
    const r = results.get(rule.id);
    if (!r) problems.push(`${rule.id} is missing from the review table`);
    else if (!['pass', 'fail', 'n/a'].includes(r.result)) problems.push(`${rule.id} has result "${r.result}" (use pass, fail or n/a)`);
    else if (r.result === 'fail' && rule.severity === 'must') problems.push(`${rule.id} is a must rule and failed`);
    else if (r.result !== 'pass' && !r.notes) problems.push(`${rule.id} is ${r.result} without a note`);
  }
  return problems;
}

function setGate(root, goal, gate, value) {
  const allowed = { challenge: ['pending', 'done'], adr: ['pending', 'done'], govern: ['pending', 'passed', 'failed'] };
  if (!allowed[gate]) fail(`Unknown gate "${gate}". Valid: ${Object.keys(allowed).join(', ')}`);
  if (!allowed[gate].includes(value)) fail(`Invalid value for gate ${gate}: ${value}. Valid: ${allowed[gate].join(', ')}`);
  const d = goal.data;
  if (gate === 'adr' && value === 'done') {
    const linked = Array.isArray(d.adrs) && d.adrs.length > 0;
    const none = d.adrs === 'none' && d.adr_reason;
    if (!linked && !none) fail('Cannot mark adr done: link an ADR (adr new/link) or record `adr none --reason`.');
    if (linked) {
      const status = new Map(listAdrs(root).map((a) => [a.id, a.status]));
      const open = d.adrs.filter((id) => !['accepted', 'superseded'].includes(status.get(id)));
      if (open.length) fail(`Cannot mark adr done: ${open.map((id) => `${id} (${status.get(id) || 'missing'})`).join(', ')} not accepted yet.`);
    }
  }
  const review = path.join(goal.dir, 'governance-review.md');
  if (gate === 'govern' && value === 'passed') {
    if (!fs.existsSync(review)) fail('Cannot mark govern passed: governance-review.md is required.');
    const problems = reviewProblems(root, goal, review);
    if (problems.length) fail(`Cannot mark govern passed: governance-review.md has problems:\n- ${problems.join('\n- ')}`);
  }
  const patch = { [`gate_${gate}`]: value };
  const notes = [];
  // Changing clarifications or decisions invalidates an earlier governance pass, and its review.
  if (gate === 'challenge' || gate === 'adr') {
    if (d.gate_govern && d.gate_govern !== 'pending') {
      patch.gate_govern = 'pending';
      notes.push('gate_govern reset to pending; re-run /aisdlc:govern');
    }
    if (fs.existsSync(review)) {
      fs.renameSync(review, path.join(goal.dir, 'governance-review.stale.md'));
      notes.push('governance-review.md is now stale (moved to governance-review.stale.md)');
    }
  }
  updateDoc(goal.file, patch);
  return notes;
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
      return out(listGoals(root).filter((g) => !opts.status || g.status === opts.status).map((g) => ({
        id: g.id, title: g.title, status: g.status, dir: path.relative(root, g.dir),
        gates: { challenge: g.data.gate_challenge, adr: g.data.gate_adr, govern: g.data.gate_govern },
      })));
    }
    if (action === 'show') {
      const g = getGoal(root, rest[0]);
      const tasks = listTasks(g);
      return out({
        id: g.id, title: g.title, status: g.status, dir: path.relative(root, g.dir),
        gates: { challenge: g.data.gate_challenge, adr: g.data.gate_adr, govern: g.data.gate_govern },
        adrs: g.data.adrs, auto_commit: g.data.auto_commit, branch: g.data.branch,
        suggested_branch: hookContext(root, loadConfig(root), { goal: g.id }).goal_branch,
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk, depends_on: t.depends_on, verify: t.verify, file: path.relative(root, t.file) })),
        progress: goalProgress(tasks),
      });
    }
    if (action === 'set') {
      const [id, key, value] = rest;
      if (!id || !key || value === undefined) fail('Usage: goal set <G-id> <key> <value>');
      if (['id', 'status', 'adrs', 'adr_reason'].includes(key) || key.startsWith('gate_')) fail('Use `state move`, `gate set` or `adr link|none` for status, gates and ADR links.');
      // The branch is substituted into hook commands, so keep it to git-ref-safe characters.
      if (key === 'branch' && !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value)) fail(`Invalid branch name "${value}".`);
      const g = getGoal(root, id);
      updateDoc(g.file, { [key]: parseScalar(value, key) });
      return out({ id, [key]: parseScalar(value, key) });
    }
    fail('Usage: goal new|list|show|set');
  },

  state([action, id, status]) {
    if (action !== 'move' || !id || !status) fail('Usage: state move <G-id> <pending|in-progress|blocked|completed>');
    if (!GOAL_STATES.includes(status)) fail(`Invalid goal status "${status}". Valid: ${GOAL_STATES.join(', ')}`);
    const root = findRoot();
    const g = getGoal(root, id);
    if (status === 'in-progress' || status === 'completed') {
      const problems = requireStep(g, 'implement');
      if (problems.length) fail(`Cannot move ${id} to ${status}:\n- ${problems.join('\n- ')}`);
    }
    if (status === 'completed' && !goalProgress(listTasks(g)).complete) fail(`${id} still has unfinished tasks; cannot complete.`);
    const dest = path.join(aisdlcDir(root), 'goals', status, path.basename(g.dir));
    if (dest !== g.dir) fs.renameSync(g.dir, dest);
    updateDoc(path.join(dest, 'goal.md'), { status });
    registrySync(root);
    out({ id, from: g.status, to: status, dir: path.relative(root, dest) });
  },

  task([action, goalId, ...rest], opts) {
    const root = findRoot();
    const g = getGoal(root, goalId);
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: task new <G-id> <title> [--depends T-01,T-02] [--risk high|medium|low] [--verify "<cmd>"]');
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
      return out({ id, file: path.relative(root, file) });
    }
    if (action === 'set') {
      const [taskId, status] = rest;
      if (!TASK_STATES.includes(status)) fail(`Invalid task status "${status}". Valid: ${TASK_STATES.join(', ')}`);
      if ((status === 'blocked' || status === 'skipped') && typeof opts.reason !== 'string') fail(`--reason is required when marking a task ${status}`);
      const tasks = listTasks(g);
      const t = getTask(g, taskId);
      if (g.status === 'completed') fail(`${g.id} is completed; its tasks can no longer change.`);
      // Resetting to pending is how a blocked goal is resumed; every other change needs a started goal.
      if (status !== 'pending' && g.status !== 'in-progress') fail(`${g.id} is ${g.status}; run \`state move ${g.id} in-progress\` first.`);
      if (status === 'in-progress' || status === 'done') {
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
      writeTasksMd(g);
      registrySync(root);
      return out({ goal: g.id, task: taskId, status, progress: goalProgress(listTasks(g)) });
    }
    if (action === 'verify') {
      // Runs the task's verify command, then the after_task hook, and records the result `done` requires.
      const [taskId] = rest;
      const t = getTask(g, taskId);
      if (t.status !== 'in-progress') fail(`${taskId} is ${t.status}; only an in-progress task can be verified.`);
      const verify = t.verify === '' || t.verify == null ? '' : String(t.verify).trim();
      const manual = verify.match(/^manual:\s*(.*)$/i);
      if (manual && !(typeof opts.evidence === 'string' && opts.evidence.trim())) {
        fail(`${taskId} has a manual check ("${manual[1]}"); pass --evidence "<what you checked and saw>".`);
      }
      const steps = [];
      if (verify && !manual) steps.push([`${taskId} verify`, [verify]]);
      const hook = resolveHookFor(root, 'after_task', { goal: g.id, task: taskId });
      if (hook.commands.length) steps.push([`hook after_task (${hook.source})`, hook.commands]);
      let code = 0;
      for (const [label, cmds] of steps) if ((code = runCommands(root, label, cmds))) break;
      updateDoc(t.file, { verified: code ? 'fail' : 'pass', verify_evidence: manual ? opts.evidence : '' });
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
      const problems = requireStep(g, a);
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
      const id = nextId('ADR', listAdrs(root).map((a) => a.id), 3);
      const goals = typeof opts.goal === 'string' ? [opts.goal] : [];
      const file = path.join(aisdlcDir(root), 'adr', `${id}-${slugify(title)}.md`);
      fs.writeFileSync(file, render('adr.md', { id, title, goals, date: today() }));
      if (goals.length) linkAdr(root, id, goals[0]);
      registrySync(root);
      return out({ id, file: path.relative(root, file) });
    }
    if (action === 'link') {
      const [adrId, goalId] = rest;
      linkAdr(root, adrId, goalId);
      registrySync(root);
      return out({ adr: adrId, goal: goalId });
    }
    if (action === 'none') {
      const [goalId] = rest;
      if (typeof opts.reason !== 'string' || !opts.reason.trim()) fail('Usage: adr none <G-id> --reason "<why no decision is needed>"');
      const g = getGoal(root, goalId);
      // Drop the back-links from ADRs this goal used to reference.
      const prev = Array.isArray(g.data.adrs) ? g.data.adrs : [];
      for (const a of listAdrs(root)) {
        if (prev.includes(a.id) && Array.isArray(a.goals)) updateDoc(a.file, { goals: a.goals.filter((x) => x !== goalId) });
      }
      updateDoc(g.file, { adrs: 'none', adr_reason: opts.reason });
      registrySync(root);
      return out({ goal: goalId, adrs: 'none', reason: opts.reason });
    }
    fail('Usage: adr new|link|none');
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

  registry([action]) {
    if (action !== 'sync') fail('Usage: registry sync');
    const root = findRoot();
    out({ rows: registrySync(root), file: path.relative(root, path.join(aisdlcDir(root), 'registry.md')) });
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
  const goals = Array.isArray(adr.goals) ? adr.goals : [];
  if (!goals.includes(goalId)) updateDoc(adr.file, { goals: [...goals, goalId] });
  const adrs = Array.isArray(g.data.adrs) ? g.data.adrs : [];
  if (!adrs.includes(adrId)) updateDoc(g.file, { adrs: [...adrs, adrId], adr_reason: '' });
}

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
