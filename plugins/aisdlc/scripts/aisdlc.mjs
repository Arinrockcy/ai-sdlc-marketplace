#!/usr/bin/env node
// aisdlc.mjs — deterministic helper for the aisdlc workflow skills.
// Zero dependencies. All state lives in <project>/.aisdlc as markdown frontmatter + JSON.
// Output is JSON on stdout (except `hooks run`, `task verify` and `goal push`, which stream command output); errors exit 1 with a message on stderr.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIN_NODE_MAJOR = 24;
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');
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
// What `adr status` accepts. `proposed` waits on the user; the rest settle the ADR one way or the other.
const ADR_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded'];
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

// Frontmatter holds one short line; the full text goes in the body.
const clip = (text) => (text.length > 400 ? `${text.slice(0, 399)}…` : text);

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

// ---------- who, and the decision log ----------

// Who is acting: AISDLC_ACTOR, else the project's `git config user.name`. Only a name is kept, never an email, because
// it goes into committed files. A change that records who made it refuses without one.
let actorCache;
function actorName(root, required = true) {
  if (actorCache === undefined) {
    const name = (process.env.AISDLC_ACTOR || '').trim() || (git(root, ['config', 'user.name']) || '').trim();
    actorCache = name.replace(/\s+/g, ' ') || null;
  }
  if (!actorCache && required) fail('aisdlc records who makes each change, and no name is set. Run `git config user.name "<your name>"` in this project, or set AISDLC_ACTOR.');
  return actorCache;
}

// The agent running the script, if any: AISDLC_AGENT (empty for none), else Claude when Claude Code runs it.
function agentName() {
  if ('AISDLC_AGENT' in process.env) return process.env.AISDLC_AGENT.trim();
  return process.env.CLAUDECODE ? 'Claude' : '';
}

// How a decision is signed. `--by user` attests that the person decided it in this session, so it carries their name
// alone; a change an agent makes on its own reads `<agent> for <name>`. Run by hand, with no agent, it is the name.
function signature(root, opts) {
  const name = actorName(root);
  const agent = agentName();
  return opts?.by === 'user' || !agent ? name : `${agent} for ${name}`;
}

const DECISIONS = 'decisions.md';
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shortText = (s, n = 200) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// The gates an `invalidate` reset, for the decision line of the change that caused it.
const resets = (notes) => {
  const gates = (notes || []).map((n) => n.match(/^gate_(\w+) reset/)?.[1]).filter(Boolean);
  return gates.length ? ` (reset: ${gates.join(', ')})` : '';
};

// Appends one line to a goal's decisions.md (or, with no goal, the project's .aisdlc/decisions.md): the time in UTC,
// who, and what was decided. Append-only and outside the plan fingerprint, so logging never forces re-governance.
function logDecision(root, goal, what, by) {
  const file = goal ? path.join(goal.dir, DECISIONS) : path.join(aisdlcDir(root), DECISIONS);
  if (!fs.existsSync(file)) {
    const subject = goal ? `this goal` : 'this project (governance rules, configuration, ADRs)';
    fs.writeFileSync(file, `# Decisions: ${goal ? goal.id : 'project'}\n\nWritten by \`aisdlc.mjs\`: every decision on ${subject}, oldest first. Each line is the time (UTC), who, and what was decided. A name alone means that person decided; \`<agent> for <name>\` means an agent acted in that person's session. Don't edit it by hand.\n\n`);
  } else if (!fs.readFileSync(file, 'utf8').endsWith('\n')) fs.appendFileSync(file, '\n');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(file, `- ${stamp} | ${by} | ${oneLine(what)}\n`);
}

const DECISION_LINE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| (.+?) \| (.*)$/;
function readDecisions(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(DECISION_LINE)).filter(Boolean).map((m) => ({ at: `${m[1]} UTC`, by: m[2], decision: m[3] }));
}

// Puts keys into a goal's frontmatter just before `created`, where the template has them.
function withKeys(data, add) {
  const result = {};
  let placed = false;
  for (const [k, v] of Object.entries(data)) {
    if (k in add) continue;
    if (!placed && k === 'created') { Object.assign(result, add); placed = true; }
    result[k] = v;
  }
  if (!placed) Object.assign(result, add);
  return result;
}

// Every option takes a value, even one that starts with "--" (e.g. --verify "--version").
// Unknown options fail, so a typo in a skill can't be silently ignored.
export const OPTIONS = new Set(['depends', 'risk', 'verify', 'reason', 'evidence', 'goal', 'task', 'status', 'stack', 'graph', 'base-branch', 'dir', 'severity', 'stage', 'check', 'budget', 'answer', 'by', 'owner']);

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

// The goal's log of removed tasks. The script writes it, and it keeps removed IDs from being allocated again.
const REMOVED_TASKS = /^removed tasks\b/i;
// What the agent writes while it works; the plan review never judged it.
const TASK_PROGRESS_SECTIONS = /^(notes|work log|review|explored)\b/i;
const TASK_REVIEW = /^review\b/i;
// The task-explorer's list of files to change, written by `task explore`. A hint for the implementer, never plan.
const TASK_EXPLORED = /^explored\b/i;
const EXPLORE_MODES = ['never', 'risk', 'always'];
const CODE_REVIEW = 'code-review.md';

const removedTaskIds = (goal) => listItems(section(readDoc(goal.file).body, REMOVED_TASKS))
  .map((item) => item.match(/\bT-\d+\b/)?.[0]).filter(Boolean);

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

// Paths a task lists under `## Files`: the backticked spans of each item, or else its first word.
function taskFiles(task) {
  return listItems(section(readDoc(task.file).body, /^files\b/i)).flatMap((item) => {
    const quoted = [...item.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return (quoted.length ? quoted : [item.split(/\s+/)[0]])
      .map((f) => f.trim().replace(/^\.\//, '').replace(/[,;:.)]+$/, ''))
      .filter((f) => f.includes('/') || /\.\w+$/.test(f));
  });
}

// Tasks the DAG calls independent (same wave) that expect to change the same file.
function sharedFiles(tasks, waves) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return waves.flatMap((wave, i) => {
    const owners = new Map();
    for (const id of wave) for (const f of new Set(taskFiles(byId.get(id)))) owners.set(f, [...(owners.get(f) || []), id]);
    const pairs = new Map();
    for (const [f, ids] of owners) if (ids.length > 1) pairs.set(ids.join(', '), [...(pairs.get(ids.join(', ')) || []), f]);
    return [...pairs].map(([ids, files]) => {
      const n = ids.split(', ').length;
      return `${n > 2 ? ids : ids.replace(', ', ' and ')} are in wave ${i + 1} as independent tasks, but ${n > 2 ? 'all' : 'both'} list ${files.join(', ')} under Files. Add a dependency if one has to go first, or confirm the changes don't conflict.`;
    });
  });
}

// Unfinished goals whose tasks expect to change files this goal's tasks also list. Task changes and merged scope all
// end in `dag write`, so this re-checks the overlap each time the plan changes, not only at create-goal and govern.
function otherGoalFileWarnings(goal, tasks) {
  const root = findRoot(goal.dir, false);
  const mine = [...new Set(tasks.flatMap(taskFiles))];
  if (!root || !mine.length) return [];
  return goalOverlap(root, [], goal.id, mine).filter((o) => o.shared_files.length).map((o) =>
    `${o.id} (${o.status}) also lists ${o.shared_files.join(', ')} under Files. Ask the user whether to merge, sequence or separate the two goals (\`goal overlap ${goal.id}\`).`);
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
  const warnings = [...sharedFiles(tasks, dag.waves), ...otherGoalFileWarnings(goal, tasks)];
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
    ...(warnings.length ? ['## Warnings', '', ...warnings.map((w) => `- ${w}`), ''] : []),
  ].join('\n');
  fs.writeFileSync(path.join(goal.dir, 'tasks.md'), text);
  return { ...dag, warnings };
}

// ---------- stack ----------

// Stack plugins on this machine: folders with a stack.json. The script reads their stack.json and plugin manifest
// only (never runs their code), so a plugin can declare the marker files of its language. Whether the agent can use
// a plugin's skills is still for the skill to check; a plugin found here may be installed for another agent.
// AISDLC_STACK_PLUGINS (folders separated by the path delimiter) replaces the search, for tests and unusual layouts.
function stackPluginDirs() {
  const env = process.env.AISDLC_STACK_PLUGINS;
  if (env !== undefined) return env.split(path.delimiter).filter(Boolean);
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; } };
  const home = os.homedir();
  // Plugins next to this one: this repository, a marketplace clone (VS Code), Copilot CLI's installed-plugins/<marketplace>/.
  const dirs = subdirs(path.dirname(PLUGIN_ROOT));
  // Claude Code keeps every downloaded version in its cache; installed_plugins.json names the installed one.
  const claude = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json'));
  for (const entries of Object.values(claude?.plugins || {})) for (const e of [].concat(entries)) if (e?.installPath) dirs.push(e.installPath);
  // GitHub Copilot CLI records its plugins in config.json and keeps them in installed-plugins/<marketplace>/<plugin>/.
  const copilotHome = process.env.COPILOT_HOME || path.join(home, '.copilot');
  for (const p of readJson(path.join(copilotHome, 'config.json'))?.installedPlugins || []) if (p?.cache_path && p.enabled !== false) dirs.push(p.cache_path);
  for (const marketplace of subdirs(path.join(copilotHome, 'installed-plugins'))) dirs.push(...subdirs(marketplace));
  return dirs;
}

// One entry per stack, the first plugin found for it: { stack, plugin, version, markers, register_skill, dir }.
function stackPlugins() {
  const plugins = [];
  const seen = new Set();
  for (const dir of stackPluginDirs()) {
    const real = (() => { try { return fs.realpathSync(dir); } catch { return null; } })();
    if (!real || seen.has(real)) continue;
    seen.add(real);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(real, 'stack.json'), 'utf8')); } catch { continue; }
    if (typeof manifest?.name !== 'string' || plugins.some((p) => p.stack === manifest.name)) continue;
    const meta = [path.join(real, '.claude-plugin', 'plugin.json'), path.join(real, 'plugin.json')]
      .map((file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }).find(Boolean) || {};
    const plugin = meta.name || path.basename(real);
    // The register skill is `<stack>-register`; stack plugins written before aisdlc 0.10.0 call it `register`.
    const skill = [`${manifest.name}-register`, 'register'].find((s) => fs.existsSync(path.join(real, 'skills', s, 'SKILL.md')));
    const markers = Array.isArray(manifest.markers) ? manifest.markers.filter((m) => typeof m === 'string' && m) : [];
    plugins.push({ stack: manifest.name, plugin, version: meta.version || null, markers, register_skill: skill ? `${plugin}:${skill}` : null, dir: real });
  }
  return plugins;
}

// A marker is a file name in the project root, or `*.ext` for any root file with that extension.
function hasMarker(root, entries, marker) {
  return marker.startsWith('*.') ? entries.some((f) => f.endsWith(marker.slice(1))) : fs.existsSync(path.join(root, marker));
}

// Stacks whose marker files are in the project root: the built-in STACK_MARKERS, then the markers stack plugins declare.
function detectStacks(root, plugins = stackPlugins()) {
  const entries = fs.readdirSync(root);
  const markers = [...STACK_MARKERS, ['*.csproj', 'dotnet'], ['*.sln', 'dotnet'], ...plugins.flatMap((p) => p.markers.map((m) => [m, p.stack]))];
  const found = [];
  for (const [marker, stack] of markers) if (!found.includes(stack) && hasMarker(root, entries, marker)) found.push(stack);
  return found;
}

function installedManifests(root) {
  const dir = path.join(aisdlcDir(root), 'stacks');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
}

// `stack` in config is `auto`, a stack name, or a list of names.
function configuredStacks(cfg) {
  const v = cfg.stack;
  if (!v || v === 'auto') return [];
  return [].concat(v).filter((s) => typeof s === 'string' && s && s !== 'auto');
}

// Every stack that applies at once: the configured ones, then each detected stack with an installed manifest.
// Registering a stack installs its manifest, so a stack registered later becomes active without a config change.
// With nothing configured or registered, a single detected stack is active (its hooks fall through to the defaults).
function activeStacks(root, cfg = loadConfig(root), detected = detectStacks(root)) {
  const installed = installedManifests(root);
  const active = [...configuredStacks(cfg)];
  for (const s of detected) if (installed.includes(s) && !active.includes(s)) active.push(s);
  if (!active.length && detected.length === 1) active.push(detected[0]);
  return active;
}

function loadStackManifest(root, stack) {
  if (!stack) return null;
  const file = path.join(aisdlcDir(root), 'stacks', `${stack}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// Until aisdlc 0.10.0 the contract named a stack's standards skill `standards`. GitHub Copilot keeps only one of two
// plugin skills with the same name, so it is now `<stack>-standards`. A manifest registered before the rename still
// names the old skill; read it as the new one, so projects keep working without registering the stack again.
function standardsSkill(manifest, stack) {
  const name = manifest?.standards_skill || null;
  return name === `aisdlc-${stack}:standards` ? `aisdlc-${stack}:${stack}-standards` : name;
}

// What the skills need to apply every stack: the active ones with their standards skills, and the detected or
// configured stacks still to register, with the plugin that registers them (or none installed).
function stackReport(root, cfg = loadConfig(root)) {
  const plugins = stackPlugins();
  const detected = detectStacks(root, plugins);
  const active = activeStacks(root, cfg, detected);
  const plugin = (s) => plugins.find((p) => p.stack === s) || null;
  const stacks = [...new Set([...active, ...detected])].map((s) => {
    const manifest = loadStackManifest(root, s);
    const p = plugin(s);
    return { stack: s, detected: detected.includes(s), active: active.includes(s), manifest_installed: !!manifest, standards_skill: standardsSkill(manifest, s), plugin: p?.plugin || null, plugin_version: p?.version || null, register_skill: p?.register_skill || null };
  });
  const unregistered = stacks.filter((s) => !s.manifest_installed);
  return {
    configured: cfg.stack || 'auto',
    detected,
    active,
    standards_skills: stacks.filter((s) => s.active && s.standards_skill).map((s) => s.standards_skill),
    to_register: unregistered.filter((s) => s.register_skill).map((s) => ({ stack: s.stack, plugin: s.plugin, register_skill: s.register_skill })),
    without_plugin: unregistered.filter((s) => !s.register_skill).map((s) => s.stack),
    stacks,
  };
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
    // Lets a hook call this script, e.g. the default after_goal's coverage check. Same Node as the caller.
    aisdlc: `"${process.execPath}" "${SCRIPT_FILE}"`,
  };
  if (opts.goal) {
    const g = getGoal(root, opts.goal);
    vars.goal_id = g.id;
    vars.goal_slug = path.basename(g.dir);
    vars.goal_branch = g.data.branch || `${vars.branch_prefix}${vars.goal_slug}`;
  }
  return vars;
}

// With several active stacks, a point is a stack hook when any of them sets it: their commands run one stack after
// another, in the order of `active`. A stack whose value is `{"use":"default"}` contributes the default's commands,
// and `null` contributes none. A command two stacks share runs once.
export function mergeStackHooks(manifests, defaults) {
  const merged = {};
  for (const point of new Set(manifests.flatMap((m) => Object.keys(m?.hooks || {})))) {
    const values = manifests.map((m) => m?.hooks?.[point]).filter((v) => v !== undefined);
    if (values.length === 1) { merged[point] = values[0]; continue; }
    const commands = values.flatMap((v) => resolveHook(point, { stack: { [point]: v }, default: defaults }).commands);
    merged[point] = values.every((v) => v === null) ? null : { run: [...new Set(commands)] };
  }
  return merged;
}

function resolveHookFor(root, point, opts) {
  if (!HOOK_POINTS.includes(point)) fail(`Unknown hook point "${point}". Valid: ${HOOK_POINTS.join(', ')}`);
  const cfg = loadConfig(root);
  const stacks = activeStacks(root, cfg);
  const env = {};
  const e = envHook(point);
  if (e !== undefined) env[point] = e;
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_HOOKS, 'utf8'));
  const layers = {
    env,
    config: cfg.hooks || {},
    stack: mergeStackHooks(stacks.map((s) => loadStackManifest(root, s)), defaults),
    default: defaults,
  };
  const r = resolveHook(point, layers);
  const vars = hookContext(root, cfg, opts);
  const commands = r.commands.map((c) => c.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
  return { point, stacks, ...r, commands };
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
    (ARCHIVED_STATES.includes(g.status) ? archived : open).push(`| ${g.id} | goal | ${cell(g.title)} | ${status} | ${links} | ${cell(g.data.owner)} | ${cell(g.data.updated)} |`);
  }
  for (const a of listAdrs(root)) {
    open.push(`| ${a.id} | adr | ${cell(a.title)} | ${cell(a.status)} | ${cell(a.goals)} | ${cell(a.decided_by)} | ${cell(a.date)} |`);
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

// Words that carry a goal's meaning: its title, Problem, Outcome, Scope and task titles. Template labels and
// Clarifications are left out, so two unrelated goals don't match on boilerplate.
const OVERLAP_STOPWORDS = new Set([...STOPWORDS, 'not', 'are', 'can', 'will', 'should', 'must', 'has', 'have', 'its', 'any', 'out', 'than', 'then', 'only', 'each', 'one', 'user', 'users']);
const OVERLAP_SECTIONS = [/^problem\b/i, /^outcome\b/i, /^scope\b/i];
const wordsOf = (text) => [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !OVERLAP_STOPWORDS.has(w)))];

// Files a goal's tasks expect to change (`## Files`), for overlap by file rather than by wording.
const goalFiles = (goal) => [...new Set(listTasks(goal).flatMap(taskFiles))];

function goalWords(goal) {
  const body = readDoc(goal.file).body;
  const parts = [goal.title, ...OVERLAP_SECTIONS.map((re) => section(body, re)), ...listTasks(goal).map((t) => t.title)];
  return wordsOf(parts.filter(Boolean).join(' '));
}

// The unfinished goals whose text shares words with `subject` (a goal's words, or typed keywords), best first.
// `likely` marks a real overlap: at least 3 shared words covering a third of the smaller side. A word matches by
// prefix, so "limit" finds "limiting". The script only measures wording; the skill asks the user what to do.
function goalOverlap(root, words, selfId, files = []) {
  const OPEN = ['pending', 'in-progress', 'blocked'];
  const matches = [];
  for (const g of listGoals(root)) {
    if (g.id === selfId || !OPEN.includes(g.status)) continue;
    const theirs = goalWords(g);
    const shared = words.filter((w) => theirs.some((t) => t.startsWith(w) || w.startsWith(t)));
    const theirFiles = files.length ? goalFiles(g) : [];
    const sharedFiles = files.filter((f) => theirFiles.includes(f));
    if (!shared.length && !sharedFiles.length) continue;
    const ratio = shared.length / Math.max(1, Math.min(words.length, theirs.length));
    matches.push({ id: g.id, title: g.title, status: g.status, shared, shared_files: sharedFiles, score: Number(ratio.toFixed(2)), likely: sharedFiles.length > 0 || (shared.length >= 3 && ratio >= 0.34) });
  }
  matches.sort((a, b) => b.shared_files.length - a.shared_files.length || b.score - a.score || b.shared.length - a.shared.length);
  return matches;
}

// The same `likely` test `goal overlap` uses: at least 3 shared words covering a third of the smaller side.
function wordOverlap(words, theirs) {
  const shared = words.filter((w) => theirs.some((t) => t.startsWith(w) || w.startsWith(t)));
  const ratio = shared.length / Math.max(1, Math.min(words.length, theirs.length));
  return { shared, likely: shared.length >= 3 && ratio >= 0.34 };
}

// ---------- parallel work on other branches ----------

// Whether anyone started similar work on another branch: every local, remote-tracking and pull-request branch that
// has commits this checkout doesn't. A branch counts when it changes this goal's own folder or carries its ID in its
// name (same goal), changes a file the goal's tasks list (same files), or adds or changes another goal whose wording
// overlaps this one (similar goal planned). Only files whose content on that branch differs from this checkout count,
// so work already brought over by a cherry-pick doesn't. Paths are limited to this project (`git diff --relative`).
// The goal's own recorded branch is its home, not parallel work. Branches with no history in common are listed as not
// compared. The user acknowledges a branch at its current commit with `goal parallel ack`; new commits on it undo that.
const PARALLEL_ACKS = 'parallel.md';
const PARALLEL_REFS = ['refs/heads', 'refs/remotes', 'refs/pull'];
const parallelCache = new Map();

function fetchEveryMinutes(root) {
  const v = loadConfig(root).parallel?.fetch_every_minutes ?? 10;
  if (typeof v !== 'number' || !(v >= 0)) fail(`parallel.fetch_every_minutes "${v}" is not valid. Use a number of minutes, 0 or more: \`config set parallel.fetch_every_minutes 10\`.`);
  return v;
}

// Fetches every remote first, so branches others pushed are seen, unless a fetch ran in the last
// `parallel.fetch_every_minutes` (default 10). A failed fetch is reported, and the refs already fetched are used.
function fetchRemotes(root) {
  const remotes = (git(root, ['remote']) || '').trim().split('\n').filter(Boolean);
  const fetchHead = path.resolve(root, (git(root, ['rev-parse', '--git-path', 'FETCH_HEAD']) || 'FETCH_HEAD').trim());
  const age = () => (fs.existsSync(fetchHead) ? Math.round((Date.now() - fs.statSync(fetchHead).mtimeMs) / 60000) : null);
  if (!remotes.length) return { remotes: 0, ran: false, note: 'no remotes' };
  const before = age();
  if (before !== null && before < fetchEveryMinutes(root)) return { remotes: remotes.length, ran: false, last_fetch_minutes_ago: before };
  const r = spawnSync('git', ['fetch', '--all', '--prune', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) return { remotes: remotes.length, ran: true, ok: true, last_fetch_minutes_ago: 0 };
  const error = oneLine(r.error?.message || r.stderr || `exit ${r.status}`).slice(0, 300);
  process.stderr.write(`[aisdlc] git fetch failed (${error}); comparing the branches fetched ${before === null ? 'before (never fetched)' : `${before} minutes ago`}\n`);
  return { remotes: remotes.length, ran: true, ok: false, error, last_fetch_minutes_ago: before };
}

function readParallelAcks(goal) {
  const file = path.join(goal.dir, PARALLEL_ACKS);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^- (\S+) @ ([0-9a-f]{40}) \| (.+?) \| (\d{4}-\d{2}-\d{2}) \| (.*)$/)).filter(Boolean)
    .map((m) => ({ branch: m[1], sha: m[2], by: m[3], date: m[4], reason: m[5] }));
}

function parallelWork(root, goal, { fetch = true } = {}) {
  const key = `${goal.dir}|${fetch}`;
  if (parallelCache.has(key)) return parallelCache.get(key);
  if (git(root, ['rev-parse', '--git-dir']) === null) return { git: false, findings: [], not_compared: [] };
  const fetched = fetch ? fetchRemotes(root) : { ran: false };
  const head = (git(root, ['rev-parse', 'HEAD']) || '').trim();
  const prefix = (git(root, ['rev-parse', '--show-prefix']) || '').trim();
  const lines = (s) => (s || '').trim().split('\n').filter(Boolean);
  const folder = path.basename(goal.dir);
  const idRe = new RegExp(`(^|[^A-Za-z0-9])${goal.id}(?![0-9])`, 'i');
  const home = String(goal.data.branch || '');
  // The base branch is where finished work lands, not a parallel effort; it is compared by rebasing, not here.
  const baseBranch = loadConfig(root).git?.base_branch || 'develop';
  const files = new Set(goalFiles(goal));
  const words = goalWords(goal);
  // One entry per commit: a local branch and its remote copy at the same commit are one piece of work.
  const bySha = new Map();
  for (const line of lines(git(root, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(objectname)', ...PARALLEL_REFS]))) {
    const [ref, short, sha] = line.split('\t');
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref) || !head || sha === head) continue;
    const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/pull/') ? 'pull request' : `remote ${ref.split('/')[2]}`;
    const name = ref.startsWith('refs/remotes/') ? short.slice(short.indexOf('/') + 1) : ref.replace(/^refs\/heads\//, '');
    if ((home && name === home) || name === baseBranch) continue;
    if (!bySha.has(sha)) bySha.set(sha, { sha, branches: [], kinds: new Set() });
    bySha.get(sha).branches.push(short);
    bySha.get(sha).kinds.add(kind);
  }
  const acks = readParallelAcks(goal);
  const findings = [];
  const notCompared = [];
  for (const { sha, branches, kinds } of bySha.values()) {
    // Already part of this checkout: nothing new on it.
    if (spawnSync('git', ['merge-base', '--is-ancestor', sha, head], { cwd: root }).status === 0) continue;
    const base = (git(root, ['merge-base', head, sha]) || '').trim();
    if (!base) { notCompared.push(...branches); continue; }
    const differs = new Set(lines(git(root, ['diff', '--name-only', '--relative', head, sha])));
    const changed = lines(git(root, ['diff', '--name-only', '--relative', base, sha])).filter((f) => differs.has(f));
    const signals = [];
    const named = branches.filter((b) => idRe.test(b));
    if (changed.some((f) => f.split('/').includes(folder) && f.includes('.aisdlc/goals/')) || named.length) {
      signals.push({ type: 'same goal', detail: named.length ? `branch name carries ${goal.id}` : `changes ${goal.id}'s goal folder` });
    }
    const sameFiles = changed.filter((f) => files.has(f));
    if (sameFiles.length) signals.push({ type: 'same files', detail: sameFiles.slice(0, 10).join(', ') + (sameFiles.length > 10 ? ` and ${sameFiles.length - 10} more` : '') });
    for (const f of changed.filter((x) => /(^|\/)\.aisdlc\/goals\/[^/]+\/[^/]+\/goal\.md$/.test(x) && !x.split('/').includes(folder))) {
      const text = git(root, ['show', `${sha}:${prefix}${f}`]);
      if (text === null) continue;
      const doc = parseDoc(text);
      const theirs = wordsOf([doc.data.title, ...OVERLAP_SECTIONS.map((re) => section(doc.body, re))].filter(Boolean).join(' '));
      const o = wordOverlap(words, theirs);
      if (o.likely) signals.push({ type: 'similar goal planned', detail: `${doc.data.id || path.basename(path.dirname(f))} "${doc.data.title || ''}" shares ${o.shared.slice(0, 8).join(', ')}` });
    }
    if (!signals.length) continue;
    const ack = acks.filter((a) => branches.includes(a.branch)).at(-1);
    findings.push({
      branches, kind: [...kinds].join(', '), sha,
      started_by: [...new Set(lines(git(root, ['log', '--format=%an', `${base}..${sha}`])))],
      last_commit: (git(root, ['log', '-1', '--format=%cI', sha]) || '').trim(),
      signals,
      acknowledged: !!ack && ack.sha === sha,
      ...(ack && { ack: { by: ack.by, date: ack.date, reason: ack.reason, ...(ack.sha !== sha && { stale: `new commits since it was acknowledged at ${ack.sha.slice(0, 10)}` }) } }),
    });
  }
  const result = { git: true, fetch: fetched, base_branch: baseBranch, home_branch: home || null, compared: bySha.size, findings, not_compared: notCompared };
  parallelCache.set(key, result);
  return result;
}

const parallelProblem = (goal, f) => `${f.branches.join(', ')} (${f.kind}; started by ${f.started_by.join(', ') || 'unknown'}; last commit ${f.last_commit.slice(0, 10)}): ${f.signals.map((s) => `${s.type}: ${s.detail}`).join('; ')}${f.ack?.stale ? `; ${f.ack.stale}` : ''}. Coordinate with them, or have the user acknowledge it: \`goal parallel ack ${goal.id} ${f.branches[0]} --reason "<why>" --by user\``;

// ---------- docs ----------

// A third index, for the project's own Markdown documentation and the bodies of ADRs: one entry per heading
// section, built by local parsing with no model. It lives in .aisdlc/cache/ and is searched, never read whole.
// `docs.paths` in config lists the documentation: project-relative files and folders (folders are searched
// recursively for *.md, no globs). Unset, only the ADRs are indexed.
const DOCS_INDEX = path.join('cache', 'docs-index.json');
const DOCS_SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const toPosix = (p) => p.split(path.sep).join('/');

// The configured entries, normalised, or null when `docs.paths` is unset. A wrong type or a bad entry is an error that names it.
function docsPaths(root) {
  const raw = loadConfig(root).docs?.paths;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) fail(`docs.paths in .aisdlc/config.json must be a list of project paths, found ${typeof raw}. Set it with \`docs paths <path>...\`.`);
  return [...new Set(raw.map((entry) => normalizeDocsEntry(root, entry)))];
}

function normalizeDocsEntry(root, entry) {
  if (typeof entry !== 'string' || !entry.trim()) fail(`docs.paths entry ${JSON.stringify(entry)} must be a project path.`);
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) fail(`docs.paths entry "${entry}" must be relative to the project root and inside it.`);
  const rel = toPosix(path.normalize(entry.trim())).replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) fail(`docs.paths entry "${entry}" does not exist. Fix the list with \`docs paths <path>...\`.`);
  if (fs.statSync(full).isFile() && !/\.md$/i.test(rel)) fail(`docs.paths entry "${entry}" is a file but not Markdown (.md).`);
  const inState = rel === '.aisdlc' || rel.startsWith('.aisdlc/');
  if (inState && rel !== '.aisdlc' && rel !== '.aisdlc/adr' && !rel.startsWith('.aisdlc/adr/')) fail(`docs.paths entry "${entry}" is workflow state, not documentation. ADRs are indexed already.`);
  return rel;
}

// Markdown files under a folder, in a stable order. A configured entry may itself be a symlink (it is followed,
// as the check that accepted it did), but symlinks found while walking are not, so a loop cannot hang the walk.
function markdownUnder(root, rel, entry = true) {
  const full = path.join(root, rel);
  const stat = entry ? fs.statSync(full) : fs.lstatSync(full);
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((d) => {
    const child = rel === '.' ? d.name : `${rel}/${d.name}`;
    // Under .aisdlc/ only the ADRs are documentation; goals, the registry and the cache are workflow state.
    if (child.startsWith('.aisdlc/') && child !== '.aisdlc/adr' && !child.startsWith('.aisdlc/adr/')) return [];
    if (d.isDirectory()) return DOCS_SKIPPED_DIRS.has(d.name) ? [] : markdownUnder(root, child, false);
    return d.isFile() && /\.md$/i.test(d.name) ? [child] : [];
  });
}

// Every file the index covers: ADRs (always) and documentation (when configured). A file is listed once, and an
// ADR reached through a documentation entry stays an ADR. Only names are listed here; an ADR's ID and status are
// read when the index is rebuilt, so checking freshness reads no file.
function docsFiles(root, entries) {
  const dir = path.join(aisdlcDir(root), 'adr');
  const adrs = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^ADR-\d+.*\.md$/.test(f)).sort().map((f) => toPosix(path.relative(root, path.join(dir, f)))) : []);
  const docs = [];
  for (const entry of entries || []) for (const f of markdownUnder(root, entry)) if (!adrs.has(f) && !docs.includes(f)) docs.push(f);
  return [...[...adrs].map((f) => ({ file: f, adr: true })), ...docs.map((f) => ({ file: f }))];
}

// Index of the line after a leading front-matter block, or 0 when there is none. A leading `---` counts only when
// a closing `---` follows and everything between reads as `key: value`, list items or indented lines, so a
// horizontal rule at the top of a document is not mistaken for front matter.
function frontMatterEnd(lines) {
  if (lines[0]?.trimEnd() !== '---') return 0;
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (close < 0) return 0;
  return lines.slice(1, close).every((l) => !l.trim() || /^[A-Za-z_][\w-]*\s*:/.test(l) || /^\s/.test(l) || /^- /.test(l)) ? close + 1 : 0;
}

// Heading sections of a Markdown text: `{ heading, trail, start, end }` with 1-based inclusive line numbers. Headings
// inside fenced code (``` or ~~~) are not headings, and an indented line is code, not a heading. Text before the
// first heading is a section of its own with no heading, kept only when it has content. `from` skips front matter.
function markdownSections(text, from = 0) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const stack = [];
  let fence = null;
  let cur = { heading: '', trail: '', start: from + 1, words: [] };
  const close = (end) => {
    while (end > cur.start && !lines[end - 1].trim()) end -= 1;
    if (cur.heading || lines.slice(cur.start - 1, end).some((l) => l.trim())) sections.push({ heading: cur.heading, trail: cur.trail, start: cur.start, end, body: cur.words.join(' ') });
  };
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = { ch: f[1][0], n: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.n && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
    }
    const h = !fence && !f ? line.match(/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/) : null;
    if (h) {
      close(i);
      stack.length = Math.min(stack.length, h[1].length - 1);
      stack[h[1].length - 1] = h[2];
      cur = { heading: h[2], trail: stack.filter(Boolean).join(' > '), start: i + 1, words: [] };
    } else cur.words.push(line);
  }
  close(lines.length);
  return sections;
}

const docWords = (text) => [...new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOPWORDS.has(w)))];

// What decides whether the index is fresh: the configured entries and each file's size and modification time.
// No file is read to check it. An edit that keeps the size within one file-system clock tick is not seen.
function docsStamp(root, entries, files) {
  return { paths: entries || [], files: files.map((f) => { const st = fs.statSync(path.join(root, f.file)); return [f.file, st.size, Math.floor(st.mtimeMs)]; }) };
}

function docsIndexRead(root) {
  const file = path.join(aisdlcDir(root), DOCS_INDEX);
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data?.version === 1 ? data : null; } catch { return null; }
}

function docsState(root) {
  const entries = docsPaths(root);
  const files = docsFiles(root, entries);
  const stamp = docsStamp(root, entries, files);
  const index = docsIndexRead(root);
  return { entries, files, stamp, index, stale: !index || JSON.stringify(index.stamp) !== JSON.stringify(stamp) };
}

// Rebuilds the index when it is stale (or `force`). Returns the state afterwards and whether it was rebuilt.
function docsSync(root, force = false) {
  const state = docsState(root);
  if (!state.stale && !force) return { ...state, rebuilt: false };
  const sections = state.files.flatMap(({ file, adr }) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const front = frontMatterEnd(text.split(/\r?\n/));
    const meta = adr ? readDoc(path.join(root, file)).data : null;
    return markdownSections(text, front).map((s) => ({
      path: file, heading: s.heading, trail: s.trail, start: s.start, end: s.end,
      ...(meta ? { adr: meta.id, status: meta.status ?? '' } : {}),
      heading_words: docWords(s.heading), words: docWords(s.body),
    }));
  });
  const index = { version: 1, stamp: state.stamp, sections };
  const file = path.join(aisdlcDir(root), DOCS_INDEX);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
  return { ...state, index, stale: false, rebuilt: true };
}

// Sections that match the keywords, best first, within a token budget. A keyword matches a word it starts, as in
// `registry search`. A heading match counts 2 and a body match 1, so a section named for the keyword outranks one
// that only mentions it; ties go to the section matching more keywords, then to file order. Bodies are never printed.
function docsSearch(root, words, budget) {
  const terms = [...new Set(docWords(words.join(' ')))];
  if (!terms.length) fail(`Usage: docs search <keywords> [--budget N]. A keyword needs 3 or more letters and is not one of these common words: ${[...STOPWORDS].join(', ')}.`);
  const synced = docsSync(root);
  const hit = (list, t) => list.some((w) => w.startsWith(t));
  const ranked = synced.index.sections.map((sec, order) => {
    const inHeading = terms.filter((t) => hit(sec.heading_words, t));
    const inBody = terms.filter((t) => !inHeading.includes(t) && hit(sec.words, t));
    return { sec, order, score: inHeading.length * 2 + inBody.length, matched: inHeading.length + inBody.length };
  }).filter((r) => r.matched).sort((a, b) => b.score - a.score || b.matched - a.matched || a.order - b.order);
  const note = synced.entries ? {} : { note: 'Project documentation is not configured, so only ADR bodies were searched. Search the documentation files directly, or set `docs paths <path>...`.' };
  // The budget counts what is printed: the fixed fields first (with room for the counts), then each match as it is
  // indented inside the list, so the output stays within it.
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v, null, 2));
  let used = Math.ceil((bytes({ terms, matches: [], more: 99999, tokens: 99999, refreshed: false, ...note })) / 4);
  const matches = [];
  for (const { sec } of ranked) {
    const m = { path: sec.path, lines: `${sec.start}-${sec.end}`, heading: sec.trail || sec.heading || '(no heading)', ...(sec.adr ? { adr: sec.adr, status: sec.status } : {}) };
    const cost = Math.ceil((bytes(m) + 4 * (Object.keys(m).length + 2) + 1) / 4);
    if (matches.length && used + cost > budget) break;
    matches.push(m);
    used += cost;
  }
  return { terms, matches, more: ranked.length - matches.length, tokens: used, refreshed: synced.rebuilt, ...note };
}

// ---------- graph ----------

// Graphify is only here to cut the tokens the workflow spends finding code. It runs code-only (local parsing, no
// model calls, no API key) and always writes graphify-out/ in the project root. `.aisdlc/` is kept out of the graph
// through .graphifyignore, so workflow state never makes it stale.
const GRAPH_DIR = 'graphify-out';
const GRAPH_STAMP = path.join(GRAPH_DIR, '.aisdlc-stamp');
const GRAPH_WARNINGS = path.join(GRAPH_DIR, '.aisdlc-warnings');
const GRAPH_IGNORED = ['.aisdlc/', `${GRAPH_DIR}/`];
// Git settings files hold no code. A .gitignore change that matters still shows, as files entering or leaving the list.
const GRAPH_IGNORED_FILES = new Set(['.gitignore', '.gitattributes', '.editorconfig']);
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
  const keep = (f) => !GRAPH_IGNORED.some((d) => f.startsWith(d)) && !GRAPH_IGNORED_FILES.has(path.posix.basename(f));
  const blobs = new Map(staged.map((l) => { const [meta, f] = l.split('\t'); return [f, meta.split(' ')[1]]; }));
  for (const f of list('-d')) blobs.delete(f);
  const changed = [...new Set([...list('-m'), ...list('-o', '--exclude-standard')])].filter((f) => keep(f) && fs.existsSync(path.join(root, f)));
  const hashes = changed.length ? git(root, ['hash-object', '--stdin-paths'], changed.map((f) => path.join(root, f)).join('\n')).trim().split('\n') : [];
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

// Source files the graph should hold: what git tracks or would track, minus workflow files, with an extension
// Graphify parses. Null outside a git repository.
const GRAPH_CODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'cc', 'swift', 'scala', 'sql']);
const GRAPH_MIN_COVERAGE = 0.5;

const isGraphCode = (f) => GRAPH_CODE_EXTENSIONS.has(path.extname(f).slice(1).toLowerCase());

// The source files the graph holds, relative to the project root. Null when graph.json is missing or unreadable.
function graphIndexedFiles(root) {
  let nodes;
  try { nodes = JSON.parse(fs.readFileSync(path.join(root, GRAPH_DIR, 'graph.json'), 'utf8')).nodes; } catch { return null; }
  if (!Array.isArray(nodes) || !nodes.length) return null;
  return { nodes: nodes.length, files: new Set(nodes.map((n) => n.source_file && path.relative(root, path.resolve(root, n.source_file))).filter(Boolean)) };
}

function graphCodeFiles(root) {
  const list = (...args) => git(root, ['ls-files', '-z', ...args])?.split('\0').filter(Boolean);
  const tracked = list();
  if (!tracked) return null;
  const files = new Set([...tracked, ...list('-o', '--exclude-standard')]);
  for (const f of list('-d')) files.delete(f);
  return [...files].filter((f) => !GRAPH_IGNORED.some((d) => f.startsWith(d)) && isGraphCode(f)).sort();
}

// Whether the graph can be trusted to find code: `ok`, `degraded` (usable, with the listed problems) or `unusable`
// (skills should search the code directly). A stale graph is refreshed first, as a query would.
function graphCheck(root, provider) {
  if (provider !== 'graphify') return { provider, status: 'none', note: 'No code graph is set up; search the code directly.' };
  const tool = graphTool(root);
  const problems = [];
  const unusable = (reason) => ({ provider, status: 'unusable', problems: [reason, ...problems], ...(tool.install && { install: tool.install }) });
  if (!tool.installed) return unusable('Graphify is not installed');
  if (!tool.supported) return unusable(`Graphify ${tool.version || ''} lacks ${tool.missing.join(', ')}`);
  const graphFile = path.join(root, GRAPH_DIR, 'graph.json');
  // Like a query, check on the graph as it is now, so files added since the last build don't count as missing.
  try { graphUpdate(root); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    problems.push(`could not refresh the graph: ${e.message}`);
  }
  const graph = graphIndexedFiles(root);
  if (!graph) return unusable(fs.existsSync(graphFile) ? `${GRAPH_DIR}/graph.json is not valid JSON or has no nodes; run \`graph setup\`` : 'no graph built yet; run `graph setup`');
  if (!graphIgnoreOk(root)) problems.push('.graphifyignore does not list .aisdlc/, so workflow state makes the graph stale; run `graph setup`');
  for (const w of graphWarnings(root)) problems.push(`graphify: ${w}`);
  const indexed = graph.files;
  const files = graphCodeFiles(root);
  let coverage = null;
  if (files) {
    const missing = files.filter((f) => !indexed.has(f));
    coverage = { files: files.length, indexed: files.length - missing.length, ratio: files.length ? Number(((files.length - missing.length) / files.length).toFixed(2)) : 1, ...(missing.length && { missing: missing.slice(0, 10), more_missing: Math.max(0, missing.length - 10) }) };
    if (files.length && !coverage.indexed) return unusable('none of the project\'s source files are in the graph');
    if (coverage.ratio < GRAPH_MIN_COVERAGE) problems.push(`only ${coverage.indexed} of ${coverage.files} source files are in the graph`);
  }
  const fresh = graphFreshness(root);
  return { provider, status: problems.length ? 'degraded' : 'ok', version: tool.version, nodes: graph.nodes, stale: fresh.stale, ...(coverage && { coverage }), ...(problems.length && { problems }) };
}

// ---------- goal changes ----------

// What a goal changed: `committed` on its branch since the base, plus `uncommitted` and `untracked` files in the
// working tree. Workflow state and the code graph are not the goal's changes. Null outside a git repository.
function goalChanges(root, g) {
  if (git(root, ['rev-parse', '--git-dir']) === null) return null;
  const base = loadConfig(root).git?.base_branch || 'develop';
  const branch = g.data.branch || null;
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || null;
  const exists = (ref) => git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
  const files = (text) => (text || '').split('\n').filter((f) => f && !GRAPH_IGNORED.some((d) => f.startsWith(d)));
  const baseRef = [base, `origin/${base}`].find(exists);
  const warnings = [];
  let range = null;
  let committed = [];
  if (!branch) warnings.push(`${g.id} has no branch recorded, so its commits can't be told apart from other work. Ask the user which commits belong to it.`);
  else if (!exists(branch)) warnings.push(`The goal's branch ${branch} doesn't exist.`);
  else if (!baseRef) warnings.push(`The base branch ${base} exists neither locally nor as origin/${base}.`);
  else if (branch === base) warnings.push(`The goal was built on the base branch ${base}, so its commits can't be told apart from other work. Ask the user which commits belong to it.`);
  else {
    range = `${baseRef}...${branch}`;
    committed = files(git(root, ['diff', '--name-only', range]));
  }
  if (branch && current !== branch) warnings.push(`The current branch is ${current}, not ${branch}, so uncommitted and untracked files come from ${current}'s working tree.`);
  return {
    base_branch: base, branch, current_branch: current, range, committed,
    uncommitted: files(git(root, ['diff', '--name-only', 'HEAD'])),
    untracked: files(git(root, ['ls-files', '-o', '--exclude-standard'])),
    warnings,
  };
}

// ---------- coverage ----------

// A metric with nothing to cover counts as fully covered.
const percent = (hit, total) => (total ? Math.round((hit / total) * 10000) / 100 : 100);

// Report format -> parser returning { metric: percent } for the metrics the report measures.
const COVERAGE_FORMATS = {
  // Istanbul's json-summary, written by Jest, Vitest, c8 and nyc (coverage/coverage-summary.json).
  'json-summary': (text) => {
    const { total } = JSON.parse(text);
    if (!total) throw new Error('it has no "total" entry');
    return Object.fromEntries(['lines', 'statements', 'functions', 'branches'].filter((m) => total[m])
      .map((m) => [m, typeof total[m].pct === 'number' ? total[m].pct : percent(total[m].covered, total[m].total)]));
  },
  // An LCOV tracefile, written by node:test, c8, pytest-cov and most other runners. It has no statement figures.
  lcov: (text) => {
    const sum = {};
    for (const m of text.matchAll(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)\s*$/gm)) sum[m[1]] = (sum[m[1]] || 0) + Number(m[2]);
    if (!('LF' in sum)) throw new Error('it has no LF: line counts');
    const metrics = { lines: percent(sum.LH || 0, sum.LF) };
    if ('BRF' in sum) metrics.branches = percent(sum.BRH || 0, sum.BRF);
    if ('FNF' in sum) metrics.functions = percent(sum.FNH || 0, sum.FNF);
    return metrics;
  },
};

// Checks the report each active stack's manifest declares as quality_gate.coverage_report: it exists and parses, it is
// newer than every file the goal changed (so it covers the finished code), and it meets quality_gate.coverage_thresholds.
// The after_task hook runs every active stack's commands, so each task rewrites every report.
function coverageCheck(root, g) {
  const stacks = activeStacks(root);
  const reports = stacks.map((s) => stackCoverage(root, g, s));
  const notes = reports.flatMap((r) => r.notes);
  if (!stacks.length) notes.push('No stack is active, so no coverage report is declared.');
  const problems = reports.flatMap((r) => r.problems);
  if (reports.some((r) => r.checked_changes)) {
    const changes = goalChanges(root, g);
    if (changes) notes.push(...changes.warnings);
  }
  return { goal: g.id, stacks, reports: reports.map(({ checked_changes, ...r }) => r), ok: problems.length === 0, problems, notes: [...new Set(notes)] };
}

function stackCoverage(root, g, stack) {
  const manifest = loadStackManifest(root, stack);
  const problems = [];
  const notes = [];
  let report = {};
  let checked = false;
  const result = () => ({ stack, ...report, ok: problems.length === 0, problems, notes, checked_changes: checked });
  if (!manifest) {
    notes.push(`No .aisdlc/stacks/${stack}.json is installed, so no coverage report is declared.`);
    return result();
  }
  const file = `.aisdlc/stacks/${stack}.json`;
  const decl = manifest.quality_gate?.coverage_report;
  const thresholds = manifest.quality_gate?.coverage_thresholds || {};
  if (!decl?.path || !decl?.format) {
    problems.push(`${file} declares no quality_gate.coverage_report ({"path": "…", "format": "…"}). Re-register the stack, so it names the report its coverage command writes.`);
    return result();
  }
  const parse = COVERAGE_FORMATS[decl.format];
  if (!parse) {
    problems.push(`${file} names an unknown coverage report format "${decl.format}". Valid: ${Object.keys(COVERAGE_FORMATS).join(', ')}.`);
    return result();
  }
  report = { report: decl.path, format: decl.format, metrics: null, thresholds };
  const full = path.resolve(root, decl.path);
  if (!fs.existsSync(full)) {
    problems.push(`${decl.path} doesn't exist. The stack's coverage command writes it: run \`hooks run after_task --goal ${g.id}\`, and check that the command writes this file.`);
    return result();
  }
  try { report.metrics = parse(fs.readFileSync(full, 'utf8')); } catch (e) {
    problems.push(`${decl.path} isn't a valid ${decl.format} report: ${e.message}.`);
    return result();
  }
  for (const [metric, min] of Object.entries(thresholds)) {
    const pct = report.metrics[metric];
    if (typeof min !== 'number') problems.push(`${file} has a non-numeric ${metric} threshold: ${JSON.stringify(min)}.`);
    else if (pct === undefined) problems.push(`${decl.path} has no ${metric} figure, but ${file} sets a ${metric} threshold of ${min}%.`);
    else if (pct < min) problems.push(`${metric} coverage is ${pct}%, below the ${min}% threshold.`);
  }
  const changes = goalChanges(root, g);
  if (!changes) {
    notes.push(`This isn't a git repository, so ${decl.path} wasn't checked against the goal's changes.`);
    return result();
  }
  const rel = path.relative(root, full).split(path.sep).join('/');
  const dir = path.posix.dirname(rel);
  const since = fs.statSync(full).mtimeMs;
  const newer = [...new Set([...changes.committed, ...changes.uncommitted, ...changes.untracked])]
    .filter((f) => f !== rel && (dir === '.' || !f.startsWith(`${dir}/`)))
    .filter((f) => { try { return fs.statSync(path.join(root, f)).mtimeMs > since; } catch { return false; } });
  if (newer.length) {
    const shown = newer.slice(0, 3).join(', ') + (newer.length > 3 ? ` and ${newer.length - 3} more` : '');
    problems.push(`${decl.path} is older than ${shown}, which the goal changed, so it may not cover the finished code. Run \`hooks run after_task --goal ${g.id}\` to write it again.`);
  }
  checked = true;
  return result();
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
  for (let r = sectionRange(lines, re); r; r = sectionRange(lines, re)) lines.splice(r[0], r[1] - r[0]);
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
// The text under `**In:**` and `**Out:**` in a goal's Scope section; an empty string when a side has nothing.
function scopeSides(body) {
  const text = section(body, /^scope\b/i) || '';
  const side = (label) => (text.match(new RegExp(`\\*\\*${label}:?\\*\\*:?([\\s\\S]*?)(?=\\*\\*(?:In|Out):?\\*\\*|$)`, 'i'))?.[1] || '').trim();
  return { in: side('In'), out: side('Out') };
}

// A verify command that cannot fail proves nothing. Trivial are: `true`, `echo ok`, a listing or a clock
// (`ls`, `date`), only asking for a version or help (`node --version`), a constant test (`test 1`), inline code with
// no body (`node -e 0`), and a real command whose failure is swallowed with `|| true`. A chain is trivial only when
// every part is. It stops the obvious ones; the reviewer judges whether a command exercises the task's criteria.
const TRIVIAL_VERIFY = new RegExp([
  String.raw`true|:|exit\s+0|(?:\/usr)?\/bin\/true`,
  String.raw`(?:echo|printf|ls|pwd|date|whoami|hostname|sleep|cd|env)\b.*`,
  String.raw`\S+\s+(?:--version|-v|-V|--help|-h)`,
  String.raw`test\s+1|\[\s+1\s+\]|\[\s+1\s*=\s*1\s+\]`,
  String.raw`(?:node\s+(?:-e|--eval)|python3?\s+-c|ruby\s+-e|perl\s+-e)\s+(['"]?)(?:0|1|pass|process\.exit\(0\)|sys\.exit\(0\)|exit\(0\)|exit 0)?\1`,
].map((x) => `(?:${x})`).join('|').replace(/^/, '^(?:').replace(/$/, ')$'));
const SWALLOWED_FAILURE = /\|\|\s*(?:true|:|exit\s+0)\s*$/;
export function trivialVerify(command) {
  const c = String(command ?? '').trim();
  if (!c || /^manual:/i.test(c)) return false;
  return SWALLOWED_FAILURE.test(c) || c.split(/&&|;/).map((x) => x.trim()).filter(Boolean).every((x) => TRIVIAL_VERIFY.test(x));
}

// The blocklist above only stops commands known to be empty. This one checks that the command points at something
// real, and runs at `task verify` because a task's files may not exist when the plan is written. Inline code
// (`node -e`, `python -c`, …) has to name a file or folder of the project, and a test runner's explicit target has
// to exist. Returns the problem, or null.
const INLINE_CODE = /^(?:node\s+(?:-e|--eval|-p|--print)|python3?\s+-c|ruby\s+-e|perl\s+-e|(?:ba|z)?sh\s+-c)\b/;
const TEST_RUNNER = /^(?:node\s+--test|(?:npx\s+)?(?:jest|vitest(?:\s+run)?|mocha)|(?:python3?\s+-m\s+)?pytest|go\s+test|cargo\s+test)\b/;
const pathTokens = (text) => (text.match(/[\w@.\/-]*[\w.\/-]/g) || []).filter((tok) => /[\/.]/.test(tok) && !/^\.+$/.test(tok) && !/^-/.test(tok));
export function unanchoredVerify(root, command) {
  const c = String(command ?? '').trim();
  if (!c || /^manual:/i.test(c)) return null;
  const exists = (tok) => fs.existsSync(path.join(root, tok.replace(/^\.\//, '')));
  const parts = c.split(/&&|;|\|\|/).map((x) => x.trim()).filter(Boolean);
  for (const part of parts) {
    if (!TEST_RUNNER.test(part)) continue;
    const missing = pathTokens(part.replace(TEST_RUNNER, '')).filter((tok) => !/[*?{}\[\]]/.test(tok) && /\.\w+$|\//.test(tok) && !exists(tok));
    if (missing.length) return `test target ${missing[0]} does not exist; fix the path in \`verify\``;
  }
  if (parts.every((x) => INLINE_CODE.test(x)) && !pathTokens(c).some(exists)) {
    return 'inline code that names no file or folder of the project proves nothing about the work; run the project\'s test command, or have the code check a file the task changes';
  }
  return null;
}

const trivialVerifyProblem = (id, verify) => `${id} verify command \`${verify}\` cannot fail; use a command that checks the work, or \`manual: <check>\``;

// Every place an unanswered question can hide: `- **Open:**` items in the goal's Risks & Unknowns (the tracked
// list) or anywhere else in the goal or a task, list items in Risks & Unknowns that end in `?` without the marker,
// and TBD-style placeholders in the planned text. `line` is the index in the file's body lines.
const OPEN_LINE = /^(\s*[-*]\s+)(?:\*\*)?Open:(?:\*\*)?\s*(?:(Q-\d+):\s*)?(.*)$/i;
const PLACEHOLDER = /\b(?:TBD|TODO)\b|\?\?\?|\bto be (?:decided|determined)\b/i;
function questionScan(goal, root) {
  const found = { open: [], stray: [], unmarked: [], placeholders: [], adrs: [] };
  const sources = [{ where: goal.id, file: goal.file, isGoal: true }, ...listTasks(goal).map((t) => ({ where: t.id, file: t.file }))];
  for (const src of sources) {
    // Comments hold template instructions; blanking them keeps the line numbers.
    const lines = bodyLines(readDoc(src.file).body.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')));
    let heading = '';
    lines.forEach((line, i) => {
      if (/^##\s/.test(line)) heading = line.replace(/^##\s+/, '').trim();
      const inRisks = src.isGoal && /^risks\b/i.test(heading);
      const m = line.match(OPEN_LINE);
      if (m) { (inRisks ? found.open : found.stray).push({ id: m[2] || null, text: m[3].trim(), where: src.where, file: src.file, line: i, prefix: m[1] }); return; }
      if (inRisks && /^\s*[-*]\s+\S/.test(line) && /\?\s*$/.test(line)) {
        found.unmarked.push({ text: line.replace(/^\s*[-*]\s+/, '').trim(), where: src.where, file: src.file, line: i, prefix: line.match(/^(\s*[-*]\s+)/)[1] });
      }
      const planned = src.isGoal ? /^(problem|outcome|scope)\b/i.test(heading) : !TASK_PROGRESS_SECTIONS.test(heading);
      // A placeholder written as code (`TODO`) is something the work talks about, not a gap in the plan.
      if (planned && PLACEHOLDER.test(line.replace(/`[^`]*`/g, ''))) found.placeholders.push({ text: line.trim(), where: src.where });
    });
  }
  // An accepted ADR can't carry an open question either. Linked ADRs are scanned whole, since an ADR has no fixed
  // place for questions; they are answered by editing the ADR, so `question` leaves them alone.
  if (root && Array.isArray(goal.data.adrs)) {
    for (const adr of listAdrs(root).filter((a) => goal.data.adrs.includes(a.id))) {
      const body = readDoc(adr.file).body.replace(/<!--[\s\S]*?-->/g, '');
      for (const line of bodyLines(body)) {
        if (/^#/.test(line)) continue;
        const m = line.match(OPEN_LINE);
        if (m) found.adrs.push({ where: adr.id, text: m[3].trim() });
        else if (PLACEHOLDER.test(line)) found.adrs.push({ where: adr.id, text: line.trim() });
      }
    }
  }
  return found;
}

const CHECKS = {
  'goal-defined': ({ goal }) => {
    const { body } = readDoc(goal.file);
    const scope = scopeSides(body);
    return [
      ...(section(body, /^problem\b/i) ? [] : ['goal has no Problem statement']),
      ...(listItems(section(body, /acceptance criteria/i)).length ? [] : ['goal has no acceptance criteria']),
      ...(scope.in ? [] : ['goal has no Scope (In): say what the goal covers']),
      ...(scope.out ? [] : ['goal has no Scope (Out): say what it leaves out, or write "None" if nothing']),
    ];
  },
  'tasks-verifiable': ({ tasks }) => (tasks.length ? tasks.flatMap((t) => {
    const verify = String(t.verify ?? '').trim();
    return [
      ...(verify && !/^manual:\s*$/i.test(verify) ? [] : [`${t.id} has no verify command or manual check`]),
      ...(trivialVerify(verify) ? [trivialVerifyProblem(t.id, verify)] : []),
      ...(unisolatedNameFilter(verify) ? [`${t.id} verify filters \`node --test\` by test name without \`--test-isolation=none\`, so a filter that matches no test still passes; add \`--test-isolation=none\``] : []),
      ...(listItems(section(readDoc(t.file).body, /acceptance criteria/i)).length ? [] : [`${t.id} has no acceptance criteria`]),
    ];
  }) : ['goal has no tasks']),
  'dag-valid': ({ tasks }) => analyzeDag(tasks).errors,
  'adr-recorded': ({ root, goal }) => adrProblems(root, readDoc(goal.file).data),
  // Unresolved questions are recorded under Risks & Unknowns as `- **Open:** Q-n: <question>` (`question add`). Open
  // items elsewhere, unmarked questions and TBD-style placeholders count too, so a question can't hide by its wording.
  'questions-resolved': ({ root, goal }) => {
    const scan = questionScan(goal, root);
    return [
      ...scan.open.map((q) => `open question: ${q.id ? `${q.id}: ` : ''}${q.text}; ask the user, then \`question resolve\``),
      ...scan.stray.map((q) => `open question in ${q.where}: ${q.text}; \`question number\` moves it to Risks & Unknowns`),
      ...scan.unmarked.map((q) => `unmarked question in Risks & Unknowns: ${q.text}; \`question number\` tracks it`),
      ...scan.placeholders.map((p) => `placeholder in ${p.where}: ${p.text}; ask the user what it should say, or put the word in backticks if the work is about it`),
      ...scan.adrs.map((q) => `open question in ${q.where}: ${q.text}; ask the user, then edit the ADR to state the answer`),
    ];
  },
  // No one started similar work on another branch, unless the user acknowledged that branch at its current commit.
  'no-parallel-work': ({ root, goal }) => parallelWork(root, goal).findings.filter((f) => !f.acknowledged).map((f) => parallelProblem(goal, f)),
  // Every acceptance criterion of the goal and of each done task is ticked. Skipped tasks don't count.
  'criteria-met': ({ goal, tasks }) => [
    ...unticked(readDoc(goal.file).body).map((c) => `goal criterion not met: ${c}`),
    ...tasks.filter((t) => t.status !== 'skipped').flatMap((t) => unticked(readDoc(t.file).body).map((c) => `${t.id} criterion not met: ${c}`)),
  ],
};

// Checks that the review's own work makes pass, each with a summary of what is left to review.
const REVIEWER_CHECKS = {
  'criteria-met': (problems) => {
    const goal = problems.filter((p) => p.startsWith('goal ')).length;
    return `${goal} goal and ${problems.length - goal} task criteria to check`;
  },
};

// `task precheck all`: the precheck of every pending task of every pending goal, the sweep for plans written before
// the precheck existed. Only the tasks that need attention are listed: verifies that already pass, and failures that
// came from a missing tool, service or setting, which say nothing about the criteria until the precheck runs with it.
function precheckAll(root, rest) {
  if (rest.length) fail('Usage: task precheck all (it checks every pending goal; name a goal to check some of its tasks)');
  const patterns = environmentPatterns(root);
  const goals = listGoals(root).filter((g) => g.status === 'pending');
  const passes = {}; const environment = {}; let tasks = 0;
  for (const g of goals) {
    process.stderr.write(`[aisdlc] precheck ${g.id}\n`);
    for (const t of listTasks(g).filter((x) => x.status === 'pending')) {
      tasks++;
      const r = precheckTask(root, t, patterns);
      if (r.result === 'passes') (passes[g.id] ??= []).push(t.id);
      if (r.cause === 'environment') (environment[g.id] ??= []).push({ task: t.id, clause: r.clause, tail: r.tail });
    }
  }
  return { checked: { goals: goals.length, tasks }, passes_now: passes, environment };
}

// The plan review's per-criterion table: one row per acceptance criterion of every unfinished task, where the reviewer
// names what fails while that criterion is unmet. It makes the review of verify commands cover every criterion instead
// of a sample, so a weak verify is found in the first review. It is part of the review only while an active plan rule
// uses the `tasks-verifiable` check.
const VERIFY_COVERAGE = /^verify coverage\b/i;
const COVERAGE_ID = /^T-\d+\.\d+$/;
const UNCOVERED = /^none\b/i;
const tableCell = (v) => v.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const someOf = (ids, max = 8) => (ids.length > max ? `${ids.slice(0, max).join(', ')} and ${ids.length - max} more` : ids.join(', '));

function criteriaToCover(goal) {
  return listTasks(goal).filter((t) => !TASK_SATISFIED.has(t.status))
    .flatMap((t) => listItems(section(readDoc(t.file).body, /acceptance criteria/i)).map((text, i) => ({ id: `${t.id}.${i + 1}`, text })));
}

function coverageSection(goal) {
  const rows = criteriaToCover(goal).map((c) => `| ${c.id} | ${tableCell(c.text.length > 160 ? `${c.text.slice(0, 159)}…` : c.text)} |  |`);
  return [
    '## Verify coverage', '',
    '<!-- One row per acceptance criterion of every unfinished task (T-01.2 is T-01\'s second criterion). Checked by: the part of the task\'s `verify`, or of the `after_task` hook, that fails while the criterion is unmet. Write `none` when nothing does. -->', '',
    '| Criterion | Text | Checked by |', '|-----------|------|------------|', ...rows, '',
  ].join('\n');
}

// What the Verify coverage table of a plan review still lacks. `uncovered` are the criteria it says nothing checks.
function coverageProblems(goal, review, rule, name) {
  const expected = criteriaToCover(goal);
  if (!expected.length) return { invalid: [], uncovered: [] };
  const again = `run \`gate set ${goal.id} govern pending\`, then \`governance review ${goal.id}\``;
  if (!review.hasCoverage) return { invalid: [`${name} has no \`## Verify coverage\` section (a review started before aisdlc 0.25.0 lacks it); ${again}`], uncovered: [] };
  const by = (c) => (review.coverage.get(c.id) || '').replace(/^[`*_\s]+/, '');
  const missing = expected.filter((c) => !review.coverage.has(c.id)).map((c) => c.id);
  const empty = expected.filter((c) => review.coverage.has(c.id) && !by(c)).map((c) => c.id);
  const uncovered = expected.filter((c) => UNCOVERED.test(by(c))).map((c) => c.id);
  const invalid = [];
  if (missing.length) invalid.push(`Verify coverage has no row for ${someOf(missing)}: the tasks changed after the review was written; ${again}`);
  if (empty.length) invalid.push(`Verify coverage: ${someOf(empty)} ${empty.length > 1 ? 'have' : 'has'} no "Checked by"; name the part of the verify that fails while the criterion is unmet, or write none`);
  const r = review.results.get(rule.id);
  if (uncovered.length && r && ['pass', 'n/a'].includes(r.result)) invalid.push(`${rule.id} is ${r.result} but Verify coverage says nothing checks ${someOf(uncovered)}`);
  return { invalid, uncovered };
}

// The clauses of a verify command joined by `&&` at the top level, so the precheck can say which one failed. Quotes,
// `$(…)`, `(…)` and `{…}` are respected. A command that also uses `||`, `;`, `&` or a newline at the top level, or a
// clause that changes the shell (`cd`, `export`, a bare assignment), is run whole as one clause, since splitting it
// would change what it does.
export function verifyClauses(command) {
  const c = String(command ?? '').trim();
  const parts = [];
  let depth = 0; let quote = ''; let start = 0; let whole = false;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('({'.includes(ch)) { depth++; continue; }
    if (')}'.includes(ch)) { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (ch === '&' && c[i + 1] === '&') { parts.push(c.slice(start, i)); start = i + 2; i++; continue; }
    if (ch === ';' || ch === '\n' || (ch === '|' && c[i + 1] === '|') || (ch === '&' && c[i - 1] !== '>' && c[i + 1] !== '>')) whole = true;
  }
  parts.push(c.slice(start));
  const clauses = parts.map((p) => p.trim()).filter(Boolean);
  if (whole || clauses.some((p) => /^(?:cd|pushd|export|set|source|\.)\s|^[A-Za-z_]\w*=\S*$/.test(p))) return c ? [c] : [];
  return clauses;
}

// Output that shows a command failed because something it needs is missing (a tool, a service, settings), not because
// of what it checks. `precheck.environment_patterns` in config.json adds the project's own (regular expressions).
const ENVIRONMENT_FAILURE = /command not found|is not recognized as an internal or external command|\bENOENT\b.*\bspawn\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bETIMEDOUT\b|connection refused|could not connect|failed to connect|Cannot find module '(?![./])/i;
function environmentPatterns(root) {
  const extra = loadConfig(root).precheck?.environment_patterns ?? [];
  if (!Array.isArray(extra) || extra.some((p) => typeof p !== 'string')) fail('precheck.environment_patterns must be a list of regular expressions written as strings: `config set precheck.environment_patterns \'["<pattern>"]\'`.');
  return [ENVIRONMENT_FAILURE, ...extra.map((p) => {
    try { return new RegExp(p, 'i'); } catch (e) { return fail(`precheck.environment_patterns has an invalid pattern "${p}": ${e.message}`); }
  })];
}

// Runs one command with its output captured; returns its exit code and output. A command that passes without running
// a test, or whose test-name filter matched no test, counts as failing, as in `task verify`.
function runCaptured(root, cmd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-run-'));
  const log = path.join(tmp, 'out');
  const fd = fs.openSync(log, 'w');
  let code;
  try {
    const r = spawnSync(cmd, { cwd: root, shell: true, stdio: ['ignore', fd, fd] });
    code = r.error ? 1 : r.status ?? 1;
  } finally { fs.closeSync(fd); }
  const output = fs.readFileSync(log, 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  const empty = !code && ranNoTests(output) ? 'the command passed but ran no tests' : !code && nameFilterMatchedNothing(cmd, output) ? 'the test-name filter matched no test' : '';
  return { code: empty ? 1 : code, output, empty };
}

const clipLine = (l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l);
const outputTail = (output) => output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-5).map(clipLine).join(' / ');

// Runs a pending task's verify command on the code as it is now, before the task's work, and records nothing. A
// command that already passes proves nothing about that work. The clauses run in order, as the shell would run them,
// so the result names the clause that failed and whether it failed for what it checks (`cause: check`) or for a
// missing tool, service or setting (`cause: environment`), which says nothing about the task's criteria.
function precheckTask(root, t, patterns = environmentPatterns(root)) {
  const verify = String(t.verify ?? '').trim();
  if (!verify) return { task: t.id, result: 'none' };
  if (/^manual:/i.test(verify)) return { task: t.id, result: 'manual' };
  const clauses = verifyClauses(verify);
  for (const [i, clause] of clauses.entries()) {
    process.stderr.write(`[aisdlc] precheck ${t.id} (${i + 1}/${clauses.length}): ${clause}\n`);
    const r = runCaptured(root, clause);
    if (!r.code) continue;
    const cause = r.code === 127 || (!r.empty && patterns.some((p) => p.test(r.output))) ? 'environment' : 'check';
    return { task: t.id, result: 'fails', exit: r.code, clause: i + 1, of: clauses.length, failed: clipLine(clause), cause, tail: r.empty || outputTail(r.output) };
  }
  return { task: t.id, result: 'passes', exit: 0 };
}

// What a plan review's Verify coverage section exempts from the precheck: `- T-03: <why>` items, for a task whose every
// criterion is about something that must stay as it is, so its verify passes before the work.
function precheckExemptions(review) {
  return new Map(listItems(review.coverageText || '').map((l) => l.match(/^(T-\d+):\s*(\S.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

// The pending tasks whose verify already passes and that the review doesn't exempt. Run when govern is set passed.
function precheckProblems(root, goal, review) {
  const exempt = precheckExemptions(review);
  const tasks = listTasks(goal).filter((t) => t.status === 'pending');
  const patterns = environmentPatterns(root);
  const passing = tasks.filter((t) => !exempt.has(t.id)).map((t) => precheckTask(root, t, patterns)).filter((r) => r.result === 'passes').map((r) => r.task);
  return {
    problems: passing.map((id) => `${id}'s verify already passes on today's code (\`task precheck ${goal.id} ${id}\`), so it proves nothing about the task's work: strengthen it, or, if every criterion of ${id} is about something that must stay as it is, exempt it under Verify coverage with "- ${id}: <why>"`),
    prechecked: { tasks: tasks.length, exempt: [...exempt.keys()].filter((id) => tasks.some((t) => t.id === id)) },
  };
}

// A test command filtered by test name (`jest -t`, `vitest -t`, `--testNamePattern`, `pytest -k`) whose filter
// matched nothing still exits 0, with every test skipped. So it can't show that the named test exists and passes.
const TEST_NAME_FILTER = /(?:^|\s)(?:-t|--testNamePattern|--test-name-pattern|-k)(?:=|\s+)\S/;
export function nameFilterMatchedNothing(cmd, output) {
  if (!TEST_NAME_FILTER.test(String(cmd))) return false;
  const plain = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const summary = plain.split('\n').reverse().find((l) => /^\s*Tests:?\s+\d/.test(l));
  if (summary) return !/\b[1-9]\d* passed\b/.test(summary);
  return /\b\d+ deselected\b/.test(plain) && !/\b[1-9]\d* passed\b/.test(plain);
}

// node --test runs each file in its own process and counts a file whose tests the name filter skipped as one passing
// test, so a filter that matches nothing still reports a pass. Without process isolation it reports 0 tests.
const NODE_TEST_NAME_FILTER = /\bnode\s[^&|;]*--test\b[^&|;]*--test-name-pattern|\bnode\s[^&|;]*--test-name-pattern[^&|;]*--test\b/;
export function unisolatedNameFilter(command) {
  return String(command ?? '').split(/&&|\|\||;/).some((part) => NODE_TEST_NAME_FILTER.test(part) && !/--test-isolation(?:=|\s+)none\b/.test(part));
}

function runChecks(root, goal, rules) {
  const ctx = { root, goal, tasks: listTasks(goal) };
  return rules.filter((r) => r.check).map((r) => {
    const problems = CHECKS[r.check](ctx);
    return { rule: r.id, check: r.check, ok: problems.length === 0, problems };
  });
}

// Hash of what the plan review judged: goal text, planned task fields and text, linked ADR statuses and plan rules.
// Progress (status, verify and review results, ticked boxes, task Notes, Work log and Review) and the goal's Cancellations log are left out, so doing
// the work, or pausing it, never invalidates it.
function planFingerprint(root, goal) {
  const norm = (body) => bodyLines(body).map((l) => l.replace(/\[[xX]\]/g, '[ ]').trimEnd()).join('\n').trim();
  const g = readDoc(goal.file);
  const adrStatus = new Map(listAdrs(root).map((a) => [a.id, a.status]));
  const plan = {
    goal: [g.data.title, g.data.adrs, g.data.adr_reason, norm(withoutSection(g.body, CANCELLATIONS))],
    tasks: listTasks(goal).map((t) => [t.id, t.title, t.depends_on, t.risk, String(t.verify ?? ''), norm(withoutSection(readDoc(t.file).body, TASK_PROGRESS_SECTIONS))]),
    adrs: (Array.isArray(g.data.adrs) ? g.data.adrs : []).map((id) => [id, adrStatus.get(id)]),
    rules: activeRules(root, 'plan').map((r) => [r.id, r.rule, r.severity, r.check]),
  };
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

// Whether the task-explorer runs before a task: `implement.explore` is never (the default), risk (high-risk tasks only)
// or always. A bad value fails loudly instead of being read as the default.
function exploreDecision(root, t) {
  const mode = loadConfig(root).implement?.explore ?? 'never';
  if (!EXPLORE_MODES.includes(mode)) fail(`implement.explore "${mode}" is not valid. Use ${EXPLORE_MODES.join(', ')}: \`config set implement.explore <mode>\`.`);
  return { mode, run: mode === 'always' || (mode === 'risk' && t.risk === 'high') };
}

// ---------- gates ----------

function requireStep(root, goal, step) {
  const d = goal.data;
  const problems = [];
  if (goal.status === 'cancelled') problems.push(`goal is cancelled; reopen it with \`state move ${goal.id} pending\` first`);
  if (step === 'challenge') {
    if (!['pending', 'cancelled'].includes(goal.status)) problems.push(`goal is ${goal.status}; challenge only runs on pending goals`);
  } else if (step === 'adr' || step === 'govern') {
    // Govern comes first: its review asks the open questions and settles the ADR decision itself, so neither
    // challenge nor the ADR step has to run before it. Both stay available, and GOV-04 still checks the ADR.
    if (goal.status === 'completed') problems.push('goal is already completed');
  } else if (step === 'implement' || step === 'final') {
    if (goal.status === 'completed') problems.push('goal is already completed');
    if (d.gate_govern !== 'passed') problems.push(`run /aisdlc:signoff ${goal.id} first (gate_govern = ${d.gate_govern || 'pending'})`);
    else if (!d.govern_fingerprint) problems.push(`governance passed before aisdlc 0.2.0, which records what it reviewed; re-run /aisdlc:signoff ${goal.id}`);
    else if (d.govern_fingerprint !== planFingerprint(root, goal)) {
      problems.push(`the plan (goal, tasks, linked ADRs or plan rules) changed after governance passed; re-run /aisdlc:signoff ${goal.id}`);
    }
    const p = goalProgress(listTasks(goal));
    if (!p.dag_ok) problems.push(`task DAG invalid: ${p.dag_errors.join('; ')}`);
    if (p.total === 0) problems.push('goal has no tasks');
    if (step === 'final') {
      if (!p.complete) problems.push('not every task is done or skipped yet');
      if (!activeRules(root, 'final').length) problems.push('governance.md has no active final-stage rules, so there is nothing to review');
    }
  } else fail(`Unknown step "${step}". Valid: challenge, adr, govern, implement, final`);
  // Challenge and the ADR may run with open questions, since that is where they get answered. From govern on,
  // nothing moves ahead until each one is answered (or removed from Risks & Unknowns), whatever the rules say.
  if (['govern', 'implement', 'final'].includes(step) && goal.status !== 'cancelled') {
    problems.push(...CHECKS['questions-resolved']({ root, goal }));
  }
  return problems;
}

function readReview(file) {
  const doc = readDoc(file);
  const results = new Map();
  const malformed = [];
  // The Verify coverage table has its own rows (T-01.2), which are not rule results.
  for (const r of tableRows(withoutSection(doc.body, VERIFY_COVERAGE))) {
    const id = r[0].match(/[A-Z][A-Z0-9]*-\d+/)?.[0];
    if (!id) continue;
    // An unescaped `|` in a note splits it into extra cells, and the text after it would be lost.
    if (r.length > 3) malformed.push(`${id}'s row has ${r.length} cells instead of 3; write a literal | in a note as \\|`);
    results.set(id, { result: (r[1] || '').toLowerCase().replace(/[^a-z/]/g, ''), notes: r[2] || '' });
  }
  const covered = section(doc.body, VERIFY_COVERAGE);
  const coverage = new Map();
  for (const r of tableRows(covered || '')) {
    if (!COVERAGE_ID.test(r[0])) continue;
    if (r.length > 3) malformed.push(`${r[0]}'s row has ${r.length} cells instead of 3; write a literal | in a cell as \\|`);
    coverage.set(r[0], r.slice(2).join('|').trim());
  }
  return {
    data: doc.data, results, malformed, coverage, hasCoverage: covered !== null, coverageText: covered,
    fixes: listItems(section(doc.body, /^required fixes\b/i)),
    questions: listItems(section(doc.body, /^questions\b/i)),
    readings: listItems(section(doc.body, /^readings\b/i)),
  };
}

// What stops a governance review from counting as a pass. `invalid` problems make the review unusable whatever its
// result; `blocking` ones are its verdict (it says fail, or a must rule failed).
function reviewProblems(root, goal, stage) {
  const name = REVIEW_FILE[stage];
  const file = path.join(goal.dir, name);
  if (!fs.existsSync(file)) return { invalid: [`${name} is required`], blocking: [], review: null };
  const review = readReview(file);
  const invalid = [...review.malformed];
  const blocking = [];
  if (review.data.result !== 'pass') blocking.push(`${name}: \`result\` is not \`pass\``);
  if (review.data.goal && review.data.goal !== goal.id) invalid.push(`${name}: review is for ${review.data.goal}, not ${goal.id}`);
  if (review.data.stage && review.data.stage !== stage) invalid.push(`${name}: review is for stage ${review.data.stage}, not ${stage}`);
  const rules = activeRules(root, stage);
  const checks = new Map(runChecks(root, goal, rules).map((c) => [c.rule, c]));
  for (const rule of rules) {
    const r = review.results.get(rule.id);
    const check = checks.get(rule.id);
    if (!r) invalid.push(`${rule.id} is missing from the review table`);
    else if (!['pass', 'fail', 'n/a'].includes(r.result)) invalid.push(`${rule.id} has result "${r.result}" (use pass, fail or n/a)`);
    else if (check && !check.ok && r.result !== 'fail') invalid.push(`${rule.id} is ${r.result} but its automatic check "${check.check}" failed: ${check.problems.join('; ')}`);
    else {
      if (r.result === 'fail' && rule.severity === 'must') blocking.push(`${rule.id} is a must rule and failed`);
      // A pass needs its evidence as much as a fail needs its reason.
      if (!r.notes) invalid.push(`${rule.id} is ${r.result} without a note (${r.result === 'pass' ? 'cite the evidence' : 'give the reason'})`);
    }
  }
  // The rule about verify commands is judged criterion by criterion, in the review's Verify coverage table.
  const verifiable = stage === 'plan' && rules.find((r) => r.check === 'tasks-verifiable');
  const coverage = verifiable ? coverageProblems(goal, review, verifiable, name) : { invalid: [], uncovered: [] };
  invalid.push(...coverage.invalid);
  return { invalid, blocking, review, uncovered: coverage.uncovered };
}

// Earlier reviews of a stage, oldest first, so the next reviewer can find them without listing the folder.
function staleReviews(root, goal, stage) {
  const base = REVIEW_FILE[stage].replace(/\.md$/, '');
  const n = (f) => Number(f.match(/\.stale-(\d+)\.md$/)[1]);
  return fs.readdirSync(goal.dir).filter((f) => f.startsWith(`${base}.stale-`) && /\.stale-\d+\.md$/.test(f))
    .sort((a, b) => n(a) - n(b)).map((f) => path.relative(root, path.join(goal.dir, f)));
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
  const rerun = { adr: `/aisdlc:adr ${goal.id}`, govern: `/aisdlc:signoff ${goal.id}`, final: `/aisdlc:signoff ${goal.id} --final` };
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
  // Both verdicts are checked against the review, so the output says whether the review file itself holds up.
  let checked = {};
  if (stage && value !== 'pending') {
    const { invalid, blocking, review, uncovered = [] } = reviewProblems(root, goal, stage);
    let prechecked;
    if (value === 'passed') {
      const problems = [...(gate === 'final' ? requireStep(root, goal, 'final') : requireStep(root, goal, 'govern').filter((p) => /^(?:open question|unmarked question|placeholder)/.test(p))), ...invalid, ...blocking];
      // The script runs every pending verify itself, last, so a review can't pass a verify that proves nothing.
      if (!problems.length && gate === 'govern' && activeRules(root, 'plan').some((r) => r.check === 'tasks-verifiable')) {
        const p = precheckProblems(root, goal, review);
        problems.push(...p.problems);
        prechecked = p.prechecked;
      }
      if (problems.length) fail(`Cannot mark ${gate} passed:\n- ${problems.join('\n- ')}`);
    }
    const warnings = [...invalid, ...(value === 'failed' && review?.data.result === 'pass' ? [`${REVIEW_FILE[stage]} says \`result: pass\`; set it to \`fail\``] : [])];
    const fixes = review ? fixSummary(review) : null;
    const questions = review?.questions || [];
    checked = {
      checked: true, warnings, questions, readings: review?.readings || [], ...(uncovered.length && { uncovered }),
      ...(prechecked && { prechecked }),
      ...(value === 'failed' && fixes && {
        fixes,
        // A failed review the session may fix and run again without the user: no question, and every fix fully written out.
        auto_fix: !warnings.length && !questions.length && fixes.ask === 0 && fixes.auto > 0,
        auto_fix_rounds: autoFixRounds(root),
      }),
    };
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
  return { notes, ...checked, ...(stage && value === 'pending' && { stale_reviews: staleReviews(root, goal, stage) }) };
}

// A Required Fix starts with `(auto)` when it is written out in full and needs no choice: the exact command, clause or
// text to change, in the plan files only. Anything else (untagged, `(ask)`, offering options) needs the user.
const AUTO_FIX = /^\(auto\)\s*\S/i;
function fixSummary(review) {
  const auto = review.fixes.filter((f) => AUTO_FIX.test(f)).length;
  return { auto, ask: review.fixes.length - auto };
}

// How many failed plan reviews in a row the session fixes and runs again on its own: `govern.auto_fix_rounds`
// (default 2, 0 turns it off). A bad value fails loudly instead of being read as the default.
function autoFixRounds(root) {
  const v = loadConfig(root).govern?.auto_fix_rounds ?? 2;
  if (!Number.isInteger(v) || v < 0) fail(`govern.auto_fix_rounds "${v}" is not valid. Use a whole number, 0 or more: \`config set govern.auto_fix_rounds 2\`.`);
  return v;
}

function reviewSummary(root, goal, stage) {
  const file = path.join(goal.dir, REVIEW_FILE[stage]);
  if (!fs.existsSync(file)) return null;
  const r = readReview(file);
  // Failed rules in a passing review are the `should` rules that did not block; keep them visible.
  const failed = [...r.results].filter(([, v]) => v.result === 'fail').map(([rule, v]) => ({ rule, notes: v.notes }));
  return { file: path.relative(root, file), result: r.data.result || null, failed, ...(r.questions.length && { questions: r.questions }) };
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
    const views = ['registry.md', 'registry-archive.md'].map((f) => path.join(base, f)).filter((f) => !fs.existsSync(f));
    registrySync(root);
    created.push(...views);
    out({ root, created: created.map((f) => path.relative(root, f)), config: cfg, detected_stacks: detectStacks(root) });
  },

  'detect-stack'() {
    const root = findRoot();
    const cfg = loadConfig(root);
    out(stackReport(root, cfg));
  },

  config([action, key, value], opts) {
    const root = findRoot();
    const cfg = loadConfig(root);
    if (action === 'get') return out(key ? getPath(cfg, key) ?? null : cfg);
    if (action === 'set') {
      if (!key || value === undefined) fail('Usage: config set <dot.path> <value>');
      const by = signature(root, opts);
      let v;
      try { v = JSON.parse(value); } catch { v = value; }
      const old = getPath(cfg, key);
      setPath(cfg, key, v);
      saveConfig(root, cfg);
      logDecision(root, null, `config ${key}: ${old === undefined ? 'unset' : JSON.stringify(old)} → ${JSON.stringify(v)}`, by);
      return out({ [key]: v });
    }
    fail('Usage: config get [dot.path] | config set <dot.path> <value>');
  },

  // The decision log: every change the script makes is logged by itself. `decision add` records a choice the user made
  // in conversation that no other command records (merge or create, retry, skip or block, which option to take).
  decision([action, goalId, ...rest], opts) {
    const root = findRoot();
    if (action === 'list') {
      const g = goalId && goalId !== 'project' ? getGoal(root, goalId) : null;
      const file = g ? path.join(g.dir, DECISIONS) : path.join(aisdlcDir(root), DECISIONS);
      return out({ subject: g ? g.id : 'project', file: path.relative(root, file), decisions: readDecisions(file) });
    }
    if (action === 'add') {
      const text = oneLine(rest.join(' '));
      if (!goalId || !text) fail('Usage: decision add <G-id>|project <decision> [--reason "<why>"] [--by user]');
      const g = goalId === 'project' ? null : getGoal(root, goalId);
      if (g) assertOpen(g);
      const by = signature(root, opts);
      const reason = oneLine(opts.reason);
      logDecision(root, g, `${text}${reason ? `: ${reason}` : ''}`, by);
      return out({ subject: g ? g.id : 'project', by, decision: text, ...(reason && { reason }) });
    }
    fail('Usage: decision add <G-id>|project <decision> [--reason "<why>"] [--by user] | decision list <G-id>|project');
  },

  goal([action, ...rest], opts) {
    const root = findRoot();
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: goal new <title>');
      const by = signature(root, opts);
      const name = actorName(root);
      const id = nextId('G', listGoals(root).map((g) => g.id), 3);
      const dir = path.join(aisdlcDir(root), 'goals', 'pending', `${id}-${slugify(title)}`);
      // The person who created the goal is its first owner; created_by never changes, owner moves with `goal owner`.
      const content = render('goal.md', { id, title, date: today(), created_by: name, owner: name });
      fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'goal.md'), content);
      logDecision(root, { id, dir }, `created "${title}"; owner ${name}`, by);
      registrySync(root);
      return out({ id, dir: path.relative(root, dir), file: path.relative(root, path.join(dir, 'goal.md')), created_by: name, owner: name });
    }
    if (action === 'list') {
      const match = statusFilter(opts.status, GOAL_STATES);
      const owner = typeof opts.owner === 'string' ? opts.owner.trim().toLowerCase() : null;
      return out(listGoals(root).filter((g) => match(g.status) && (owner === null || String(g.data.owner || '').toLowerCase() === owner)).map((g) => ({
        id: g.id, title: g.title, status: g.status, owner: g.data.owner || null, dir: path.relative(root, g.dir),
        gates: gatesOf(g), next: nextStep(root, g),
      })));
    }
    if (action === 'owner') {
      // Hands a goal to someone else. Every handoff is logged with its reason; created_by stays as it was.
      const [id, ...words] = rest;
      const name = oneLine(words.join(' '));
      const reason = oneLine(opts.reason);
      if (!id || !name || !reason) fail('Usage: goal owner <G-id> <name> --reason "<why>"');
      const g = getGoal(root, id);
      assertOpen(g);
      const by = signature(root, opts);
      const previous = g.data.owner || null;
      if (previous === name) return out({ id, owner: name, previous, changed: false });
      const doc = readDoc(g.file);
      doc.data = withKeys(doc.data, { ...(doc.data.created_by !== undefined && { created_by: doc.data.created_by }), owner: name });
      if ('updated' in doc.data) doc.data.updated = today();
      writeDoc(g.file, doc);
      logDecision(root, g, `owner ${previous || 'none'} → ${name}: ${reason}`, by);
      registrySync(root);
      return out({ id, owner: name, previous, changed: true, reason });
    }
    if (action === 'parallel') {
      // `goal parallel <G-id>` reports similar work on other branches; `goal parallel ack <G-id> <branch>` records that
      // the user knows about one and why it is fine, at that branch's current commit.
      if (rest[0] !== 'ack') {
        const g = getGoal(root, rest[0]);
        const r = parallelWork(root, g);
        return out({ goal: g.id, ...r, unacknowledged: r.findings.filter((f) => !f.acknowledged).length });
      }
      const [, id, branch] = rest;
      const reason = oneLine(opts.reason);
      if (!id || !branch || !reason) fail('Usage: goal parallel ack <G-id> <branch> --reason "<why>" --by user');
      if (opts.by !== 'user') fail('goal parallel ack needs --by user: it attests that the user knows about this branch and decided it is fine. Ask the user.');
      const g = getGoal(root, id);
      assertOpen(g);
      const by = signature(root, opts);
      const refs = (git(root, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(objectname)', ...PARALLEL_REFS]) || '').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
      const hit = refs.find(([ref, short]) => ref === branch || short === branch);
      if (!hit) fail(`No local, remote or pull-request branch named ${branch}. \`goal parallel ${id}\` lists the branches it found.`);
      const [, short, sha] = hit;
      const file = path.join(g.dir, PARALLEL_ACKS);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# Parallel work acknowledged: ${g.id}\n\nWritten by \`aisdlc.mjs goal parallel ack\`: branches with similar work that the user knows about, each at the commit it was acknowledged. New commits on a branch make it count again. Don't edit it by hand.\n\n`);
      fs.appendFileSync(file, `- ${short} @ ${sha} | ${actorName(root)} | ${today()} | ${reason}\n`);
      logDecision(root, g, `acknowledged parallel work on ${short} at ${sha.slice(0, 10)}: ${reason}`, by);
      return out({ goal: g.id, branch: short, sha, reason });
    }
    if (action === 'backfill') {
      // For goals made before aisdlc recorded names: created_by is the author of the commit that added goal.md (renames
      // followed, so a goal that moved folders still finds it), and owner starts as the same person. A goal.md that is
      // not committed yet was made by whoever runs this. Goals that already have created_by are left alone.
      const by = signature(root, opts);
      const repo = git(root, ['rev-parse', '--git-dir']) !== null;
      const filled = [];
      for (const g of listGoals(root)) {
        if (g.data.created_by) continue;
        const rel = path.relative(root, g.file).split(path.sep).join('/');
        const tracked = repo && !!git(root, ['ls-files', '--', rel])?.trim();
        const log = (args) => (tracked ? (git(root, ['log', '--follow', ...args, '--format=%an', '--', rel]) || '').trim().split('\n').filter(Boolean) : []);
        const authors = log(['--diff-filter=A']);
        // `--follow` loses a file that first appeared in a merge; `-m` follows it into the merged branch, back to the
        // commit that added it there. Failing that, the earliest commit git finds for the path.
        const merged = authors.length ? [] : log(['-m', '--diff-filter=A']);
        const earliest = authors.length || merged.length || !tracked ? [] : (git(root, ['log', '--format=%an', '--', rel]) || '').trim().split('\n').filter(Boolean);
        const [name, source] = authors.length ? [authors.at(-1), 'git history']
          : merged.length ? [merged.at(-1), 'git history, through a merge']
          : earliest.length ? [earliest.at(-1), 'earliest commit found']
          : repo && !tracked ? [actorName(root), 'not committed yet'] : ['unknown', repo ? 'no commit found' : 'no git repository'];
        const doc = readDoc(g.file);
        doc.data = withKeys(doc.data, { created_by: name, owner: doc.data.owner || name });
        writeDoc(g.file, doc);
        logDecision(root, g, `created_by set to ${name} (${source}); owner ${doc.data.owner} (backfill)`, by);
        filled.push({ id: g.id, created_by: name, owner: doc.data.owner, source });
      }
      registrySync(root);
      return out({ filled: filled.length, goals: filled });
    }
    if (action === 'overlap') {
      // `goal overlap <G-id>` compares a goal with the other unfinished goals; keywords do the same for a goal not yet written.
      const subject = rest.join(' ').trim();
      if (!subject) fail('Usage: goal overlap <G-id>|<keywords>');
      const own = /^G-\d+$/.test(subject) ? getGoal(root, subject) : null;
      const terms = own ? goalWords(own) : wordsOf(subject);
      if (!terms.length) fail('goal overlap needs words of 3 or more letters.');
      const overlaps = goalOverlap(root, terms, own?.id, own ? goalFiles(own) : []);
      return out({ subject: own ? own.id : 'keywords', terms, files: own ? goalFiles(own) : [], overlaps, likely: overlaps.filter((o) => o.likely).map((o) => o.id) });
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
      // A stack registration rewrites its manifest; committed inside the goal, it would show up in the goal's diff.
      for (const stack of activeStacks(root)) {
        const manifest = `.aisdlc/stacks/${stack}.json`;
        if (fs.existsSync(path.join(root, manifest)) && git(root, ['status', '--porcelain', '--', manifest])?.trim()) {
          warnings.push(`${manifest} has uncommitted changes, for example from registering the stack. Commit it on its own before the goal starts, so it stays out of the goal's changes.`);
        }
      }
      return out({ goal: g.id, before_goal: commands, switches_branch: switches, base_branch: base, other_in_progress: others, warnings });
    }
    if (action === 'diff') {
      const g = getGoal(root, rest[0]);
      const changes = goalChanges(root, g);
      if (!changes) fail('goal diff needs a git repository. Ask the user which files belong to the goal.');
      return out({ goal: g.id, ...changes });
    }
    if (action === 'push') {
      // The after_goal default. A goal's work reaches the base branch through review, never through this push.
      const g = getGoal(root, rest[0]);
      if (git(root, ['rev-parse', '--git-dir']) === null) fail('goal push needs a git repository.');
      const base = loadConfig(root).git?.base_branch || 'develop';
      const branch = g.data.branch;
      if (!branch) fail(`${g.id} has no branch recorded, so there is nothing to push. Record it with \`goal set ${g.id} branch <name>\`.`);
      if (branch === base) fail(`${g.id} was built on the base branch ${base}, and aisdlc never pushes the base branch. Push it yourself if that is what you want.`);
      if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) === null) fail(`The goal's branch ${branch} doesn't exist.`);
      process.stdout.write(`[aisdlc] goal push: git push -u origin ${branch}\n`);
      const r = spawnSync('git', ['push', '-u', 'origin', branch], { cwd: root, stdio: 'inherit' });
      process.exitCode = r.error ? 1 : r.status ?? 1;
      return;
    }
    if (action === 'show') {
      const g = getGoal(root, rest[0]);
      const tasks = listTasks(g);
      const next = nextStep(root, g);
      const finals = activeRules(root, 'final').length > 0;
      const p = goalProgress(tasks);
      // `next` names a command; say when all it has left to do is finish the goal.
      const hint = next === 'implement' && p.complete && (!finals || g.data.gate_final === 'passed')
        ? `Every task is done${finals ? ' and the final review passed' : ''}. /aisdlc:implement ${g.id} only completes the goal.`
        : next === 'implement' && p.complete ? `Every task is done. /aisdlc:implement ${g.id} runs the final review, then completes the goal.` : null;
      const decisions = readDecisions(path.join(g.dir, DECISIONS));
      return out({
        id: g.id, title: g.title, status: g.status, dir: path.relative(root, g.dir),
        created_by: g.data.created_by || null, owner: g.data.owner || null, you: actorName(root, false),
        decisions: { file: path.relative(root, path.join(g.dir, DECISIONS)), count: decisions.length, last: decisions.at(-1) || null },
        gates: gatesOf(g), next, ...(hint && { next_hint: hint }),
        final_review_required: finals,
        governance: { plan: reviewSummary(root, g, 'plan'), final: reviewSummary(root, g, 'final') },
        ...(g.status === 'cancelled' && { cancel_reason: g.data.cancel_reason || null }),
        cancellations: listItems(section(readDoc(g.file).body, CANCELLATIONS)),
        adrs: g.data.adrs, auto_commit: g.data.auto_commit, branch: g.data.branch,
        suggested_branch: hookContext(root, loadConfig(root), { goal: g.id }).goal_branch,
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk, depends_on: t.depends_on, verify: t.verify, file: path.relative(root, t.file) })),
        progress: p,
      });
    }
    if (action === 'set') {
      const [id, key, value] = rest;
      if (!id || !key || value === undefined) fail('Usage: goal set <G-id> <key> <value>');
      if (['id', 'status', 'adrs', 'adr_reason', 'govern_fingerprint'].includes(key) || key.startsWith('gate_')) fail('Use `state move`, `gate set` or `adr link|none` for status, gates and ADR links.');
      // The branch is substituted into hook commands, so keep it to git-ref-safe characters.
      if (key === 'branch' && !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value)) fail(`Invalid branch name "${value}".`);
      if (key === 'cancel_reason') fail('Use `state move <G-id> cancelled --reason "<why>"` to cancel a goal.');
      if (key === 'owner') fail(`Use \`goal owner ${id} <name> --reason "<why>"\` to hand a goal over, so the handoff is logged.`);
      if (key === 'created_by') fail('created_by never changes. `goal backfill` fills it for goals made before aisdlc recorded names.');
      const g = getGoal(root, id);
      assertOpen(g);
      const by = signature(root, opts);
      updateDoc(g.file, { [key]: parseScalar(value, key) });
      logDecision(root, g, `set ${key} to ${value}`, by);
      return out({ id, [key]: parseScalar(value, key) });
    }
    fail('Usage: goal new|list|show|diff|overlap|preflight|push|set|owner|backfill|parallel');
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
    const by = signature(root, opts);
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
      if (activeRules(root, 'final').length && g.data.gate_final !== 'passed') fail(`${id} needs a passing final governance review; run /aisdlc:signoff ${id} --final.`);
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
    logDecision(root, { id, dir: dest }, `moved ${g.status} → ${status}${reason ? `: ${reason}` : ''}`, by);
    registrySync(root);
    out({ id, from: g.status, to: status, dir: path.relative(root, dest), ...(reason && { reason }) });
  },

  task([action, goalId, ...rest], opts) {
    const root = findRoot();
    if (action === 'precheck' && goalId === 'all') return out(precheckAll(root, rest));
    const g = getGoal(root, goalId);
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: task new <G-id> <title> [--depends T-01,T-02] [--risk high|medium|low] [--verify "<cmd>"]');
      assertOpen(g);
      const by = signature(root, opts);
      const risk = opts.risk || 'medium';
      if (!(risk in RISK_RANK)) fail(`Invalid risk "${risk}"`);
      const tasks = listTasks(g);
      // Removed IDs count too: earlier reviews may still name them.
      const id = nextId('T', [...tasks.map((t) => t.id), ...removedTaskIds(g)], 2);
      const depends = typeof opts.depends === 'string' ? opts.depends.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const unknown = depends.filter((d) => !tasks.some((t) => t.id === d));
      if (unknown.length) fail(`Unknown dependencies: ${unknown.join(', ')} (create them first)`);
      const file = path.join(g.dir, 'tasks', `${id}-${slugify(title)}.md`);
      fs.writeFileSync(file, render('task.md', { id, goal: g.id, title, depends_on: depends, risk }));
      if (typeof opts.verify === 'string') updateDoc(file, { verify: opts.verify });
      // A task added after governance was never reviewed, so governance has to run again.
      const notes = invalidate(g, 'govern');
      logDecision(root, g, `added ${id} "${title}" (risk ${risk}${depends.length ? `, after ${depends.join(', ')}` : ''})${resets(notes)}`, by);
      return out({ id, file: path.relative(root, file), notes });
    }
    if (action === 'remove') {
      const [taskId] = rest;
      const reason = typeof opts.reason === 'string' ? opts.reason.replace(/\s+/g, ' ').trim() : '';
      if (!taskId || !reason) fail('Usage: task remove <G-id> <T-id> --reason "<why>"');
      const t = getTask(g, taskId);
      assertOpen(g);
      // Once work starts, a task that is no longer wanted is skipped with a reason, so the record stays.
      if (g.status !== 'pending') fail(`${g.id} is ${g.status}; tasks can only be removed before the goal starts. Skip it instead: \`task set ${g.id} ${taskId} skipped --reason "<why>"\`.`);
      const dependents = listTasks(g).filter((x) => x.depends_on.includes(taskId)).map((x) => x.id);
      if (dependents.length) fail(`${dependents.join(', ')} depend${dependents.length > 1 ? '' : 's'} on ${taskId}. Change ${dependents.length > 1 ? 'their' : 'its'} dependencies first with \`task edit ${g.id} <T-id> depends …\`.`);
      const by = signature(root, opts);
      fs.rmSync(t.file);
      const doc = readDoc(g.file);
      doc.body = appendToSection(doc.body, REMOVED_TASKS, 'Removed tasks', `- ${today()}: ${taskId} "${t.title}" removed: ${reason}`);
      doc.data.updated = today();
      writeDoc(g.file, doc);
      const notes = invalidate(g, 'govern');
      logDecision(root, g, `removed ${taskId} "${t.title}": ${reason}${resets(notes)}`, by);
      writeTasksMd(g);
      registrySync(root);
      return out({ goal: g.id, removed: taskId, reason, notes });
    }
    if (action === 'edit') {
      const [taskId, field, ...value] = rest;
      const fields = ['title', 'depends', 'risk', 'verify'];
      if (!taskId || !fields.includes(field) || !value.length) fail('Usage: task edit <G-id> <T-id> title|depends|risk|verify <value> (depends takes T-01,T-02 or none)');
      const v = value.join(' ').trim();
      const t = getTask(g, taskId);
      assertOpen(g);
      if (TASK_SATISFIED.has(t.status)) fail(`${taskId} is ${t.status}; a finished task no longer changes. Add a new task for the change.`);
      const by = signature(root, opts);
      const doc = readDoc(t.file);
      let file = t.file;
      if (field === 'title') {
        if (!v) fail('Usage: task edit <G-id> <T-id> title "<title>"');
        doc.data.title = v;
        doc.body = doc.body.replace(new RegExp(`^# ${taskId}:.*$`, 'm'), `# ${taskId}: ${v}`);
        file = path.join(path.dirname(t.file), `${taskId}-${slugify(v)}.md`);
      } else if (field === 'depends') {
        const depends = /^(none|-)$/i.test(v) ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
        const dag = analyzeDag(listTasks(g).map((x) => (x.id === taskId ? { ...x, depends_on: depends } : x)));
        if (!dag.ok) fail(`Cannot change ${taskId}'s dependencies:\n- ${dag.errors.join('\n- ')}`);
        doc.data.depends_on = depends;
      } else if (field === 'risk') {
        if (!(v in RISK_RANK)) fail(`Invalid risk "${v}" (use high|medium|low)`);
        doc.data.risk = v;
      } else {
        // A new check makes the old result meaningless.
        Object.assign(doc.data, { verify: v, verified: '', verify_evidence: '', reviewed: '', review_evidence: '' });
      }
      const changed = formatDoc(doc) !== fs.readFileSync(t.file, 'utf8') || file !== t.file;
      writeDoc(t.file, doc);
      if (file !== t.file) fs.renameSync(t.file, file);
      // The planned fields are what governance reviewed.
      const notes = changed ? invalidate(g, 'govern') : [];
      if (changed) logDecision(root, g, `${taskId} ${field} → ${field === 'depends' ? (doc.data.depends_on.join(', ') || 'none') : v}${resets(notes)}`, by);
      writeTasksMd(g);
      return out({ goal: g.id, task: taskId, [field]: field === 'depends' ? doc.data.depends_on : v, file: path.relative(root, file), notes });
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
        if (t.reviewed !== 'pass') fail(`${taskId} has not passed its review; run \`task review ${g.id} ${taskId} pass|fail --evidence "<findings>"\` first.`);
      }
      const by = signature(root, opts);
      const patch = { status, reason: typeof opts.reason === 'string' ? opts.reason : '' };
      if (status !== 'done') Object.assign(patch, { verified: '', verify_evidence: '', reviewed: '', review_evidence: '', review_round: '', review_fails: '' });
      const explore = status === 'in-progress' ? exploreDecision(root, t) : null;
      updateDoc(t.file, patch);
      // The final review judged the finished tasks; any change to them means it has to run again.
      const notes = invalidate(g, 'final');
      logDecision(root, g, `${taskId} ${t.status} → ${status}${patch.reason ? `: ${patch.reason}` : ''}${resets(notes)}`, by);
      writeTasksMd(g);
      registrySync(root);
      return out({ goal: g.id, task: taskId, status, progress: goalProgress(listTasks(g)), notes, ...(explore && { explore }) });
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
      if (trivialVerify(verify)) fail(`${trivialVerifyProblem(taskId, verify)}. Change it with \`task edit ${g.id} ${taskId} verify "<command>"\`.`);
      if (unisolatedNameFilter(verify)) fail(`${taskId} verify command \`${verify}\` filters \`node --test\` by test name without \`--test-isolation=none\`, so a filter that matches no test still passes. Add \`--test-isolation=none\` with \`task edit ${g.id} ${taskId} verify "<command>"\`.`);
      const unanchored = unanchoredVerify(root, verify);
      if (unanchored) fail(`${taskId} verify command \`${verify}\`: ${unanchored}. Change it with \`task edit ${g.id} ${taskId} verify "<command>"\`.`);
      const byHand = manual || (!verify && !hook.commands.length);
      const by = signature(root, opts);
      if (byHand && !evidence) {
        fail(manual
          ? `${taskId} has a manual check ("${manual[1]}"); pass --evidence "<what you checked and saw>".`
          : `${taskId} has no verify command and no after_task hook, so nothing would run; check it by hand and pass --evidence "<what you checked and saw>".`);
      }
      const steps = [];
      if (verify && !manual) steps.push([`${taskId} verify`, [verify]]);
      if (hook.commands.length) steps.push([`hook after_task (${hook.source})`, hook.commands]);
      let code = 0;
      const ran = [];
      for (const [label, cmds] of steps) if ((code = runCommands(root, label, cmds, ran))) break;
      // One line the final review can cite instead of running everything again.
      const summary = ran.map((r) => `${r.cmd}: exit ${r.code}${r.tests ? ` (${r.tests})` : ''}`).join('; ');
      const recorded = [byHand ? evidence : '', summary].filter(Boolean).join('; ').replace(/\s*\n\s*/g, ' ');
      // The code may have changed since the last review, so verifying again sends the task back to review.
      updateDoc(t.file, { verified: code ? 'fail' : 'pass', verify_evidence: clip(recorded), reviewed: '', review_evidence: '' });
      logDecision(root, g, `${taskId} verify ${code ? 'fail' : 'pass'}: ${shortText(recorded)}`, by);
      process.stdout.write(`[aisdlc] verify ${taskId}: ${code ? 'fail' : 'pass'}\n`);
      if (code) process.exitCode = code;
      return;
    }
    if (action === 'review') {
      // Records the review of a verified task. Every round goes to the goal's code-review.md and the task's Review section.
      const [taskId, result] = rest;
      if (!taskId || !['pass', 'fail'].includes(result)) fail('Usage: task review <G-id> <T-id> pass|fail --evidence "<findings>"');
      const t = getTask(g, taskId);
      assertOpen(g);
      if (t.status !== 'in-progress') fail(`${taskId} is ${t.status}; only an in-progress task can be reviewed.`);
      if (t.verified !== 'pass') fail(`${taskId} has not passed verification; run \`task verify ${g.id} ${taskId}\` before the review.`);
      const full = typeof opts.evidence === 'string' ? opts.evidence.trim() : '';
      if (!full) fail(`--evidence is required: ${result === 'pass' ? 'what you checked and found for each acceptance criterion' : 'the defects found'}.`);
      const evidence = full.replace(/\s*\n\s*/g, ' ');
      const by = signature(root, opts);
      const round = Number(t.review_round || 0) + 1;
      const fails = result === 'fail' ? Number(t.review_fails || 0) + 1 : 0;
      const doc = readDoc(t.file);
      Object.assign(doc.data, { reviewed: result, review_evidence: clip(evidence), review_round: round, review_fails: fails });
      doc.body = appendToSection(doc.body, TASK_REVIEW, 'Review', `- ${today()}: round ${round}: ${result}: ${evidence}`);
      if ('updated' in doc.data) doc.data.updated = today();
      writeDoc(t.file, doc);
      const log = path.join(g.dir, CODE_REVIEW);
      const head = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').replace(/\s*$/, '\n') : `# Code review: ${g.id}\n\nWritten by \`task review\`: every review round of every task, oldest first.\n`;
      fs.writeFileSync(log, `${head}\n## ${taskId}: ${t.title}, round ${round} (${today()}): ${result}\n\n${full}\n`);
      logDecision(root, g, `${taskId} review round ${round} ${result}: ${shortText(evidence)} (full text in ${CODE_REVIEW})`, by);
      writeTasksMd(g);
      out({ goal: g.id, task: taskId, result, round, fails_in_a_row: fails, file: path.relative(root, log) });
      if (result === 'fail') process.exitCode = 1;
      return;
    }
    if (action === 'explore') {
      // Records what the task-explorer found: the files the task will change and why. It replaces the earlier list.
      const [taskId, ...files] = rest;
      if (!taskId || !files.length) fail('Usage: task explore <G-id> <T-id> <file>... --evidence "<where each file needs changes and why>"');
      const t = getTask(g, taskId);
      assertOpen(g);
      if (t.status !== 'in-progress') fail(`${taskId} is ${t.status}; only an in-progress task can be explored.`);
      const why = typeof opts.evidence === 'string' ? opts.evidence.trim().replace(/\s*\n\s*/g, ' ') : '';
      if (!why) fail('--evidence is required: where each file needs changes and why.');
      const bad = files.filter((f) => path.isAbsolute(f) || f.split(/[\\/]/).includes('..'));
      if (bad.length) fail(`Files must be relative to the project root and inside it: ${bad.join(', ')}`);
      const listed = [...new Set(files.map((f) => f.replace(/^\.\//, '')))].map((f) => ({ file: f, state: fs.existsSync(path.join(root, f)) ? 'exists' : 'new' }));
      const doc = readDoc(t.file);
      const lines = [...listed.map((l) => `- ${l.file} (${l.state})`), '', `Why: ${why}`].join('\n');
      doc.body = appendToSection(withoutSection(doc.body, TASK_EXPLORED), TASK_EXPLORED, 'Explored', lines);
      writeDoc(t.file, doc);
      return out({ goal: g.id, task: taskId, files: listed });
    }
    if (action === 'precheck') {
      // Runs the verify of each pending task (or of the ones named) before its work, so a verify that proves nothing
      // is fixed while the plan is written, not found by a review. It changes no state.
      const tasks = listTasks(g);
      const patterns = environmentPatterns(root);
      const unknown = rest.filter((id) => !tasks.some((t) => t.id === id));
      if (unknown.length) fail(`Task ${unknown.join(', ')} not found in ${g.id}.`);
      const started = rest.filter((id) => tasks.find((t) => t.id === id).status !== 'pending');
      if (started.length) fail(`${started.join(', ')} ${started.length > 1 ? 'are' : 'is'} not pending; precheck runs a task's verify before its work starts.`);
      const results = tasks.filter((t) => t.status === 'pending' && (!rest.length || rest.includes(t.id))).map((t) => precheckTask(root, t, patterns));
      return out({ goal: g.id, passes_now: results.filter((r) => r.result === 'passes').map((r) => r.task), results });
    }
    fail('Usage: task new|edit|remove|set|verify|review|explore|precheck');
  },

  // The goal's open questions, kept by the script so none hides: `- **Open:** Q-n: text` under Risks & Unknowns until
  // the user answers, then `- **Q:** Q-n: text **A (user):** answer` under Clarifications. IDs are never reused.
  question([action, goalId, ...rest], opts) {
    const root = findRoot();
    const g = getGoal(root, goalId);
    const doc = readDoc(g.file);
    const OPEN_ITEM = OPEN_LINE;
    const risks = () => { const r = sectionRange(bodyLines(doc.body), /^risks\b/i); return r ? bodyLines(doc.body).slice(r[0] + 1, r[1]) : []; };
    const openItems = () => risks().map((line) => line.match(OPEN_ITEM)).filter(Boolean).map((m) => ({ id: m[2] || null, text: m[3].trim() }));
    const nextQ = () => `Q-${Math.max(0, ...[...doc.body.matchAll(/\bQ-(\d+)\b/g)].map((m) => Number(m[1]))) + 1}`;
    const save = () => { if ('updated' in doc.data) doc.data.updated = today(); writeDoc(g.file, doc); };
    const answered = (id, text, answer) => appendToSection(doc.body, /^clarifications\b/i, 'Clarifications', `- **Q:** ${id}: ${text} **A (user):** ${answer}`);
    const answer = typeof opts.answer === 'string' ? opts.answer.trim().replace(/\s*\n\s*/g, ' ') : '';
    // Only the user's answer settles a question. The script can't tell who typed it, so the caller has to say so:
    // `--by user` attests that the user gave this answer in this session, and the record shows it.
    if (answer && opts.by !== 'user') fail('--answer needs --by user: it attests the user gave this answer. A recommendation or your own reading is not an answer; ask the user.');
    if (action === 'list') {
      const scan = questionScan(g, root);
      const strip = ({ id, text, where }) => ({ id, text, where });
      const blocking = scan.open.length + scan.stray.length + scan.unmarked.length + scan.placeholders.length + scan.adrs.length > 0;
      return out({ goal: g.id, open: scan.open.map(({ id, text }) => ({ id, text })), unnumbered: scan.open.filter((q) => !q.id).length, elsewhere: scan.stray.map(strip), unmarked: scan.unmarked.map(({ text, where }) => ({ text, where })), placeholders: scan.placeholders, adrs: scan.adrs, blocking });
    }
    assertOpen(g);
    if (action === 'add') {
      // Without --answer the question stays open and blocks govern. With it, the user already answered: it is recorded as settled.
      const text = rest.join(' ').trim().replace(/\s*\n\s*/g, ' ');
      if (!text) fail('Usage: question add <G-id> <question> [--answer "<the user\'s answer>" --by user]');
      const by = signature(root, opts);
      const id = nextQ();
      doc.body = answer ? answered(id, text, answer) : appendToSection(doc.body, /^risks\b/i, 'Risks & Unknowns', `- **Open:** ${id}: ${text}`);
      save();
      logDecision(root, g, answer ? `${id} answered: ${text} → ${answer}` : `${id} asked: ${text}`, by);
      return out({ goal: g.id, id, status: answer ? 'answered' : 'open' });
    }
    if (action === 'resolve') {
      const [id] = rest;
      if (!/^Q-\d+$/.test(id || '') || !answer) fail('Usage: question resolve <G-id> <Q-id> --answer "<the user\'s answer>" --by user');
      const by = signature(root, opts);
      const lines = bodyLines(doc.body);
      const r = sectionRange(lines, /^risks\b/i);
      const at = r ? lines.findIndex((l, i) => i > r[0] && i < r[1] && l.match(OPEN_ITEM)?.[2] === id) : -1;
      if (at < 0) fail(`${g.id} has no open question ${id}. \`question list ${g.id}\` shows them.`);
      const text = lines[at].match(OPEN_ITEM)[3].trim();
      lines.splice(at, 1);
      doc.body = appendToSection(lines.join('\n'), /^clarifications\b/i, 'Clarifications', `- **Q:** ${id}: ${text} **A (user):** ${answer}`);
      save();
      logDecision(root, g, `${id} answered: ${text} → ${answer}`, by);
      return out({ goal: g.id, id, status: 'answered', still_open: openItems().length });
    }
    if (action === 'number') {
      // Brings every stray question under the script: numbers hand-written Open items, tracks unmarked questions,
      // and moves Open items found elsewhere in the goal or in a task into Risks & Unknowns, tagged with where they were.
      const scan = questionScan(g);
      const tasks = listTasks(g);
      let n = Math.max(0, ...[doc.body, ...tasks.map((t) => readDoc(t.file).body)].flatMap((b) => [...b.matchAll(/\bQ-(\d+)\b/g)].map((m) => Number(m[1]))));
      const ids = [];
      const lines = bodyLines(doc.body);
      const drop = new Set();
      const move = [];
      for (const q of [...scan.open.filter((x) => !x.id), ...scan.unmarked]) {
        ids.push(`Q-${++n}`);
        lines[q.line] = `${q.prefix}**Open:** ${ids.at(-1)}: ${q.text.replace(/^\*\*Open:\*\*\s*/, '')}`;
      }
      const byTask = new Map();
      for (const q of scan.stray) {
        ids.push(`Q-${++n}`);
        move.push(`- **Open:** ${ids.at(-1)}: ${q.where === g.id ? '' : `[${q.where}] `}${q.text}`);
        if (q.where === g.id) drop.add(q.line); else byTask.set(q.file, [...(byTask.get(q.file) || []), q.line]);
      }
      for (const [file, at] of byTask) {
        const td = readDoc(file);
        const tl = bodyLines(td.body);
        td.body = tl.filter((_, i) => !at.includes(i)).join('\n');
        if ('updated' in td.data) td.data.updated = today();
        writeDoc(file, td);
      }
      doc.body = lines.filter((_, i) => !drop.has(i)).join('\n');
      for (const item of move) doc.body = appendToSection(doc.body, /^risks\b/i, 'Risks & Unknowns', item);
      save();
      return out({ goal: g.id, numbered: ids });
    }
    fail('Usage: question list <G-id> | add <G-id> <question> [--answer "…" --by user] | resolve <G-id> <Q-id> --answer "…" --by user | number <G-id>');
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

  gate([action, goalId, a, b], opts) {
    const root = findRoot();
    const g = getGoal(root, goalId);
    if (action === 'require') {
      const problems = requireStep(root, g, a);
      out({ goal: g.id, step: a, ok: problems.length === 0, problems });
      if (problems.length) process.exitCode = 1;
      return;
    }
    if (action === 'set') {
      const by = signature(root, opts);
      const from = g.data[`gate_${a}`] || 'pending';
      const result = setGate(root, g, a, b);
      const review = { govern: REVIEW_FILE.plan, final: REVIEW_FILE.final }[a];
      logDecision(root, g, `gate ${a} ${from} → ${b}${review && b !== 'pending' ? ` (${review})` : ''}${resets(result.notes)}`, by);
      registrySync(root);
      return out({ goal: g.id, gate: a, value: b, ...result });
    }
    fail('Usage: gate require <G-id> <step> | gate set <G-id> <gate> <value>');
  },

  adr([action, ...rest], opts) {
    const root = findRoot();
    if (action === 'new') {
      const title = rest.join(' ').trim();
      if (!title) fail('Usage: adr new <title> [--goal G-001]');
      if (typeof opts.goal === 'string') assertOpen(getGoal(root, opts.goal));
      const by = signature(root, opts);
      const id = nextId('ADR', listAdrs(root).map((a) => a.id), 3);
      const goals = typeof opts.goal === 'string' ? [opts.goal] : [];
      const file = path.join(aisdlcDir(root), 'adr', `${id}-${slugify(title)}.md`);
      fs.writeFileSync(file, render('adr.md', { id, title, goals, date: today(), created_by: actorName(root) }));
      logDecision(root, null, `${id} "${title}" proposed${goals.length ? ` for ${goals[0]}` : ''}`, by);
      const notes = goals.length ? linkAdr(root, id, goals[0]) : [];
      if (goals.length) logDecision(root, getGoal(root, goals[0]), `linked new ${id} "${title}" (proposed)${resets(notes)}`, by);
      registrySync(root);
      return out({ id, file: path.relative(root, file), notes });
    }
    if (action === 'link') {
      const [adrId, goalId] = rest;
      const by = signature(root, opts);
      const before = goalId ? getGoal(root, goalId).data.adrs : null;
      const notes = linkAdr(root, adrId, goalId);
      const g = getGoal(root, goalId);
      if (!(Array.isArray(before) && before.includes(adrId))) logDecision(root, g, `linked ${adrId}${resets(notes)}`, by);
      registrySync(root);
      return out({ adr: adrId, goal: goalId, notes });
    }
    if (action === 'status') {
      // Settles an ADR: who decided it is kept on the ADR (decided_by) and in the log of the project and of every linked goal.
      const [adrId, status] = rest;
      if (!adrId || !ADR_STATUSES.includes(status)) fail(`Usage: adr status <ADR-id> ${ADR_STATUSES.join('|')} [--reason "<why>"] [--by user]`);
      const adr = listAdrs(root).find((a) => a.id === adrId) || fail(`ADR ${adrId} not found.`);
      const by = signature(root, opts);
      const reason = oneLine(opts.reason);
      if (adr.status === status) return out({ adr: adrId, status, changed: false });
      const doc = readDoc(adr.file);
      doc.data.status = status;
      doc.data.decided_by = status === 'proposed' ? '' : actorName(root);
      doc.data.date = today();
      writeDoc(adr.file, doc);
      const what = `${adrId} "${adr.title}" ${adr.status || 'proposed'} → ${status}${reason ? `: ${reason}` : ''}`;
      logDecision(root, null, what, by);
      const linked = (Array.isArray(adr.goals) ? adr.goals : []).map((id) => listGoals(root).find((x) => x.id === id)).filter((x) => x && !ARCHIVED_STATES.includes(x.status));
      for (const g of linked) logDecision(root, g, what, by);
      registrySync(root);
      return out({ adr: adrId, from: adr.status || 'proposed', status, decided_by: doc.data.decided_by || null, goals_logged: linked.map((x) => x.id) });
    }
    if (action === 'none') {
      const [goalId] = rest;
      if (typeof opts.reason !== 'string' || !opts.reason.trim()) fail('Usage: adr none <G-id> --reason "<why no decision is needed>"');
      const g = getGoal(root, goalId);
      assertOpen(g);
      const by = signature(root, opts);
      // Drop the back-links from ADRs this goal used to reference.
      const prev = Array.isArray(g.data.adrs) ? g.data.adrs : [];
      for (const a of listAdrs(root)) {
        if (prev.includes(a.id) && Array.isArray(a.goals)) updateDoc(a.file, { goals: a.goals.filter((x) => x !== goalId) });
      }
      const changed = g.data.adrs !== 'none' || g.data.adr_reason !== opts.reason;
      updateDoc(g.file, { adrs: 'none', adr_reason: opts.reason });
      const notes = changed ? invalidate(g, 'adr') : [];
      if (changed) logDecision(root, g, `no ADR needed: ${opts.reason}${prev.length ? ` (unlinked ${prev.join(', ')})` : ''}${resets(notes)}`, by);
      registrySync(root);
      return out({ goal: goalId, adrs: 'none', reason: opts.reason, notes });
    }
    if (action === 'list') {
      const match = statusFilter(opts.status);
      return out(listAdrs(root).filter((a) => match(a.status)).map((a) => ({
        id: a.id, title: a.title, status: a.status, goals: Array.isArray(a.goals) ? a.goals : [], file: path.relative(root, a.file),
      })));
    }
    fail('Usage: adr new|link|status|none|list');
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

  coverage([action, goalId]) {
    if (action !== 'check' || !goalId) fail('Usage: coverage check <G-id>');
    const root = findRoot();
    const r = coverageCheck(root, getGoal(root, goalId));
    out(r);
    if (!r.ok) process.exitCode = 1;
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
      const cell = tableCell;
      // A failed automatic check can only be a fail, so its row is filled in; every other row is left to the reviewer.
      // A check the review itself satisfies (criteria-met: the reviewer ticks what the code meets) is not a finding yet.
      const prefilled = (c) => c && !c.ok && !REVIEWER_CHECKS[c.check];
      const rows = rules.map((r) => {
        const c = checks.get(r.id);
        return prefilled(c) ? `| ${r.id} | fail | ${cell(`check ${c.check}: ${c.problems.join('; ')}`)} |` : `| ${r.id} |  |  |`;
      });
      // The rule about verify commands is reviewed one criterion at a time, so the review gets a row for each.
      const toCover = stage === 'plan' && rules.some((r) => r.check === 'tasks-verifiable') ? criteriaToCover(g).length : 0;
      const text = render('governance-review.md', { goal: g.id, stage, result: '', date: today() }).replace(/(\|-+\|-+\|-+\|\n)/, `$1${rows.map((r) => `${r}\n`).join('')}`)
        .replace(/^## Required Fixes$/m, () => `${toCover ? `${coverageSection(g)}\n` : ''}## Required Fixes`);
      fs.writeFileSync(file, text);
      return out({
        file: path.relative(root, file),
        ...(toCover && { verify_coverage: { criteria: toCover } }),
        rules: rules.map((r) => {
          const c = checks.get(r.id);
          if (!c) return { id: r.id, rule: r.rule, severity: r.severity };
          const detail = c.ok ? {} : REVIEWER_CHECKS[c.check] ? { to_check: REVIEWER_CHECKS[c.check](c.problems) } : { problems: c.problems };
          return { id: r.id, rule: r.rule, severity: r.severity, check: c.check, check_ok: c.ok, ...detail };
        }),
        stale_reviews: staleReviews(root, g, stage),
      });
    }
    if (action !== 'add' && action !== 'set') fail('Usage: governance list | checks <G-id> [--stage plan|final] | review <G-id> [--stage plan|final] | add <rule> --severity must|should --stage plan|final [--check <name>] | set <rule-id> rule|severity|stage|check <value>');
    if (gov.text === null) fail('No .aisdlc/governance.md; run init first.');
    const by = signature(root, opts);
    let rule;
    let what;
    if (action === 'add') {
      const text = rest.join(' ').trim();
      if (!text || typeof opts.severity !== 'string' || typeof opts.stage !== 'string') {
        fail('Usage: governance add <rule> --severity must|should --stage plan|final [--check <name>]');
      }
      rule = { id: nextId('GOV', gov.rules.map((r) => r.id), 2), rule: text, severity: opts.severity.toLowerCase(), stage: opts.stage.toLowerCase(), check: typeof opts.check === 'string' ? opts.check.replace(/^-$/, '') : '' };
      gov.rules.push(rule);
      what = `${rule.id} added (${rule.severity}, ${rule.stage}${rule.check ? `, check ${rule.check}` : ''}): ${rule.rule}`;
    } else {
      const [id, field, ...value] = rest;
      if (!['rule', 'severity', 'stage', 'check'].includes(field) || !value.length) fail('Usage: governance set <rule-id> rule|severity|stage|check <value>');
      // IDs never change and rules are never deleted: reviews reference them. Retire with `severity retired`.
      rule = gov.rules.find((r) => r.id === id) || fail(`Rule ${id} not found.`);
      const v = value.join(' ').trim();
      const old = rule[field];
      rule[field] = field === 'rule' ? v : field === 'check' ? v.replace(/^-$/, '') : v.toLowerCase();
      what = `${rule.id} ${field} ${old || 'none'} → ${rule[field] || 'none'}`;
    }
    const errors = ruleErrors(rule);
    if (errors.length) fail(errors.join('\n'));
    writeGovernance(gov, gov.rules);
    logDecision(root, null, what, by);
    return out(rule);
  },

  registry([action, ...words]) {
    const root = findRoot();
    if (action === 'search') return out(registrySearch(root, words));
    if (action !== 'sync') fail('Usage: registry sync | search <keywords>');
    const rel = (name) => path.relative(root, path.join(aisdlcDir(root), name));
    out({ ...registrySync(root), file: rel('registry.md'), archive: rel('registry-archive.md') });
  },

  docs([action, ...rest], opts) {
    const root = findRoot();
    if (action === 'paths') {
      if (!rest.length) return out({ paths: docsPaths(root) });
      const paths = [...new Set(rest.map((entry) => normalizeDocsEntry(root, entry)))];
      const cfg = loadConfig(root);
      cfg.docs = { ...(cfg.docs || {}), paths };
      saveConfig(root, cfg);
      return out({ paths, files: docsFiles(root, paths).filter((f) => !f.adr).length });
    }
    if (action === 'clear') {
      const cfg = loadConfig(root);
      if (cfg.docs) { delete cfg.docs.paths; if (!Object.keys(cfg.docs).length) delete cfg.docs; }
      saveConfig(root, cfg);
      return out({ paths: null, note: 'Project documentation is not configured; only ADR bodies are indexed.' });
    }
    if (action === 'sync') {
      const r = docsSync(root);
      return out({ rebuilt: r.rebuilt, documentation: r.entries ? 'configured' : 'not configured', files: r.files.length, sections: r.index.sections.length, index: toPosix(path.relative(root, path.join(aisdlcDir(root), DOCS_INDEX))) });
    }
    if (action === 'status') {
      let state;
      try { state = docsState(root); } catch (e) {
        if (!(e instanceof UserError)) throw e;
        return out({ configured: true, built: Boolean(docsIndexRead(root)), stale: true, problems: [e.message] });
      }
      return out({
        configured: Boolean(state.entries), paths: state.entries,
        ...(state.entries ? {} : { note: 'Project documentation is not configured; only ADR bodies are indexed. Set it with `docs paths <path>...`.' }),
        built: Boolean(state.index), stale: state.stale, files: state.files.length, adrs: state.files.filter((f) => f.adr).length,
        sections: state.index ? state.index.sections.length : 0,
      });
    }
    if (action === 'search') {
      const budget = opts.budget === undefined ? DEFAULT_BUDGET : Number(opts.budget);
      if (!Number.isInteger(budget) || budget < 100) fail('--budget must be a whole number of tokens, 100 or more');
      return out(docsSearch(root, rest, budget));
    }
    fail('Usage: docs paths [<path>...] | clear | sync | status | search <keywords> [--budget N]');
  },

  graph([action, ...words], opts) {
    const root = findRoot();
    const { provider } = graphConfig(root);
    if (action === 'status') {
      const tool = graphTool(root);
      const warnings = graphWarnings(root);
      return out({ provider, dir: GRAPH_DIR, ...tool, aisdlc_ignored: graphIgnoreOk(root), ...graphFreshness(root), ...(warnings.length && { warnings }) });
    }
    if (action === 'check') return out(graphCheck(root, provider));
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
      if (action === 'update' || action === 'query' || action === 'sync') return out({ provider, note: 'No code graph is set up; search the code directly.' });
      fail('Usage: graph status | check | sync <G-id> | setup | update | query "<keywords>" [--budget N]');
    }
    if (action === 'update') return out(graphUpdate(root));
    if (action === 'sync') {
      if (!words[0]) fail('Usage: graph sync <G-id>');
      const g = getGoal(root, words[0]);
      const changes = goalChanges(root, g);
      if (!changes) return out({ goal: g.id, provider, note: 'graph sync needs a git repository; search the code directly.' });
      let refresh;
      try { refresh = graphUpdate(root); } catch (e) {
        if (!(e instanceof UserError) && e.code !== 'ENOENT') throw e;
        return out({ goal: g.id, provider, note: `Graph unavailable (${e.code === 'ENOENT' ? 'graphify is not installed' : e.message}); search the code directly.` });
      }
      const graph = graphIndexedFiles(root);
      if (!graph) return out({ goal: g.id, provider, note: `${GRAPH_DIR}/graph.json is missing or empty; run \`graph setup\`, or search the code directly.` });
      const changed = [...new Set([...changes.committed, ...changes.uncommitted, ...changes.untracked])].filter((f) => isGraphCode(f) && fs.existsSync(path.join(root, f))).sort();
      const missing = changed.filter((f) => !graph.files.has(f));
      return out({ goal: g.id, refreshed: Boolean(refresh.updated), changed: changed.length, indexed: changed.length - missing.length, ...(missing.length && { missing }), ...(refresh.warning && { warning: refresh.warning }), ...(refresh.warnings && { warnings: refresh.warnings }) });
    }
    if (action === 'query') {
      const question = words.join(' ').trim();
      if (!question) fail('Usage: graph query "<keywords>" [--budget N]');
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
      // The graph holds code structure (functions, classes, imports), not data fields or text, and matches node
      // names, not prose, so a miss is common.
      if (/^No matching nodes found/m.test(result)) process.stdout.write('[aisdlc] Nothing in the graph matches. Retry with identifiers (function, file or module names) rather than a sentence, or search the code directly.\n');
      return;
    }
    fail('Usage: graph status | check | sync <G-id> | setup | update | query "<keywords>" [--budget N]');
  },
};

// The test count a runner prints last: node:test's `tests/pass/fail N` lines (`# ` in TAP, `ℹ ` in its default
// spec reporter), or a line such as Jest's
// "Tests: 12 passed, 12 total", Mocha's "12 passing" or pytest's "12 passed in 0.5s".
export function testCounts(output) {
  const tap = [...output.matchAll(/^(?:#|ℹ) (tests|pass|fail) (\d+)$/gm)];
  if (tap.length) return Object.entries(Object.fromEntries(tap.map((m) => [m[1], m[2]]))).map(([k, n]) => `${k} ${n}`).join(', ');
  const line = output.split('\n').reverse().find((l) => /\b\d+ (passed|passing|failed|failing)\b/i.test(l));
  return line ? line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[\s=]+|[\s=]+$/g, '').replace(/\s+/g, ' ').slice(0, 120) : '';
}

// Runs commands in order with the platform's default shell; returns the first failing exit code, or 0.
// With `record`, output goes through a file so it can be summarized, then is printed in full; each command's
// exit code and test count are pushed onto `record`.
// A test command that passes because it found nothing to run proves nothing either.
export const ranNoTests = (output) => /^(?:#|ℹ) tests 0$/m.test(output) || /\bNo tests (?:found|ran)\b|\bcollected 0 items\b|\bRan 0 tests\b|^\s*Tests:\s+0 total\b|\b0 passing\b/im.test(output);

function runCommands(root, label, cmds, record) {
  for (const cmd of cmds) {
    process.stdout.write(`[aisdlc] ${label}: ${cmd}\n`);
    let code = 0;
    if (!record) {
      try { execSync(cmd, { cwd: root, stdio: 'inherit' }); } catch (e) { code = e.status || 1; }
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-run-'));
      const log = path.join(tmp, 'out');
      const fd = fs.openSync(log, 'w');
      try {
        const r = spawnSync(cmd, { cwd: root, shell: true, stdio: ['inherit', fd, fd] });
        code = r.error ? 1 : r.status ?? 1;
      } finally { fs.closeSync(fd); }
      const output = fs.readFileSync(log, 'utf8');
      fs.rmSync(tmp, { recursive: true, force: true });
      process.stdout.write(output);
      if (!code && ranNoTests(output)) {
        code = 1;
        process.stderr.write(`[aisdlc] ${label}: the command passed but ran no tests, so it proves nothing: ${cmd}\n`);
      } else if (!code && nameFilterMatchedNothing(cmd, output)) {
        code = 1;
        process.stderr.write(`[aisdlc] ${label}: the test-name filter matched no test, so the named test doesn't exist or didn't run: ${cmd}\n`);
      }
      record.push({ cmd, code, tests: testCounts(output) });
    }
    if (code) {
      process.stderr.write(`[aisdlc] ${label} failed (exit ${code}): ${cmd}\n`);
      return code;
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

// The workflow step that moves a goal on: signoff, implement, reopen, or null once completed. Challenge and the ADR
// step are optional, because the plan review covers both.
function nextStep(root, g) {
  const d = g.data;
  if (g.status === 'completed') return null;
  if (g.status === 'cancelled') return 'reopen';
  if (d.gate_govern !== 'passed' || d.govern_fingerprint !== planFingerprint(root, g)) return 'signoff';
  return 'implement';
}

const gatesOf = (g) => ({ challenge: g.data.gate_challenge, adr: g.data.gate_adr, govern: g.data.gate_govern, final: g.data.gate_final || 'pending' });

export function nodeVersionError(version) {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR ? null : `aisdlc needs Node.js ${MIN_NODE_MAJOR} or later; this is Node.js ${version}.`;
}

function main() {
  const versionError = nodeVersionError(process.versions.node);
  if (versionError) {
    process.stderr.write(`aisdlc: ${versionError}\n`);
    process.exit(1);
  }
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || !commands[cmd]) {
    process.stderr.write(`Usage: aisdlc.mjs <${Object.keys(commands).join('|')}> ...\n`);
    process.exit(cmd ? 1 : 0);
  }
  try {
    const { pos, opts } = parseArgs(argv);
    if ('by' in opts && opts.by !== 'user') fail('--by takes only "user": it attests that the user made this decision in this session.');
    commands[cmd](pos, opts);
  } catch (e) {
    if (e instanceof UserError) {
      process.stderr.write(`aisdlc: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) main();
