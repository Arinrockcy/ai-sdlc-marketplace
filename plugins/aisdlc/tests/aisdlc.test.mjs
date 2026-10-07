import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeDag, goalProgress, resolveHook, mergeStackHooks, parseDoc, formatDoc, testCounts, nodeVersionError } from '../scripts/aisdlc.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/aisdlc.mjs');

// Stack plugins installed on this machine would change what detect-stack reports, so the search finds none unless a
// test names the plugins it sets up.
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-'));
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, AISDLC_STACK_PLUGINS: '', ...env } });
    let json;
    try { json = JSON.parse(r.stdout); } catch { json = undefined; }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return { dir, run };
}

const t = (id, depends_on = [], extra = {}) => ({ id, depends_on, status: 'pending', risk: 'medium', ...extra });

const BASELINE_RULES = ['GOV-01', 'GOV-02', 'GOV-03', 'GOV-04', 'GOV-05'];

// Writes a governance review; `results` maps rule ID -> [result, notes], defaulting to pass with a note.
function writeReview(dir, goalId, results = {}, result = 'pass', { rules = BASELINE_RULES, file = 'governance-review.md' } = {}) {
  const rows = rules.map((id) => { const [res, notes] = results[id] || ['pass', 'checked']; return `| ${id} | ${res} | ${notes ?? ''} |`; });
  const text = `---\ngoal: ${goalId}\nresult: ${result}\n---\n\n| Rule | Result | Notes |\n|------|--------|-------|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(dir, file), text);
}

const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));

// Fills the Problem and first acceptance criterion, which the goal-defined and tasks-verifiable checks look for.
const fill = (file) => edit(file, (s) => s.replace('## Problem\n', '## Problem\n\nSomething is missing.\n').replace('- [ ] \n', '- [ ] It works\n'));

// Ticks every acceptance criterion in a goal or task file, as the criteria-met check expects.
const tick = (file) => edit(file, (s) => s.replace(/- \[ \] (?=\S)/g, '- [x] '));

// Creates a goal whose goal.md and tasks pass the automatic checks. Tasks without --verify get `--verify true`.
function plannedGoal(run, dir, tasks, title = 'Feature') {
  const goal = run(['goal', 'new', title]).json;
  fill(path.join(dir, goal.file));
  for (const args of tasks) {
    const r = run(['task', 'new', goal.id, ...(args.includes('--verify') ? args : [...args, '--verify', 'true'])]);
    assert.equal(r.code, 0, r.stderr);
    fill(path.join(dir, r.json.file));
  }
  return goal;
}

// Creates G-001 with the given tasks and passes every gate, so the goal is ready to implement.
function governedGoal(run, dir, tasks) {
  plannedGoal(run, dir, tasks);
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  run(['adr', 'none', 'G-001', '--reason', 'no architectural change']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);
  writeReview(path.join(dir, run(['goal', 'show', 'G-001']).json.dir), 'G-001');
  assert.equal(run(['gate', 'set', 'G-001', 'govern', 'passed']).code, 0);
}

test('runtime: the script refuses Node.js older than 24', () => {
  assert.equal(nodeVersionError('24.0.0'), null);
  assert.equal(nodeVersionError('25.1.0'), null);
  assert.equal(nodeVersionError('22.12.0'), 'aisdlc needs Node.js 24 or later; this is Node.js 22.12.0.');
});

test('frontmatter round-trips scalars and arrays', () => {
  const text = '---\nid: G-001\ntitle: Login: SSO\nadrs: [ADR-001, ADR-002]\nbranch:\n---\n# body\n';
  const doc = parseDoc(text);
  assert.equal(doc.data.title, 'Login: SSO');
  assert.deepEqual(doc.data.adrs, ['ADR-001', 'ADR-002']);
  assert.equal(formatDoc(doc), text);
});

test('frontmatter: CRLF parses, only list keys become arrays, newlines are rejected', () => {
  const doc = parseDoc('---\r\nid: G-001\r\ntitle: [WIP]\r\nadrs: [ADR-001]\r\n---\r\nbody\r\n');
  assert.equal(doc.data.id, 'G-001');
  assert.equal(doc.data.title, '[WIP]');
  assert.deepEqual(doc.data.adrs, ['ADR-001']);
  assert.throws(() => formatDoc({ data: { reason: 'x\nstatus: done' }, body: '' }), /single line/);
});

test('dag: waves group independent tasks and put high risk first', () => {
  const r = analyzeDag([t('T-01'), t('T-02', [], { risk: 'high' }), t('T-03', ['T-01', 'T-02']), t('T-04', ['T-03'])]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [['T-02', 'T-01'], ['T-03'], ['T-04']]);
});

test('dag: detects cycles, unknown deps and self deps', () => {
  assert.match(analyzeDag([t('T-01', ['T-02']), t('T-02', ['T-01'])]).errors[0], /cycle/);
  assert.match(analyzeDag([t('T-01', ['T-09'])]).errors[0], /unknown/);
  assert.match(analyzeDag([t('T-01', ['T-01'])]).errors.join(), /itself/);
});

test('progress: ready, blocked propagation, stuck and complete', () => {
  const tasks = [t('T-01', [], { status: 'done' }), t('T-02', ['T-01'], { status: 'blocked' }), t('T-03', ['T-02']), t('T-04', ['T-01'])];
  const p = goalProgress(tasks);
  assert.deepEqual(p.ready, ['T-04']);
  assert.deepEqual(p.waiting_on_blocked, ['T-03']);
  assert.equal(p.stuck, false);
  tasks[3].status = 'done';
  assert.equal(goalProgress(tasks).stuck, true);
  assert.equal(goalProgress([t('T-01', [], { status: 'done' }), t('T-02', [], { status: 'skipped' })]).complete, true);
});

test('hooks: precedence env > config > stack > default, with use: indirection', () => {
  const layers = {
    env: {},
    config: {},
    stack: { after_task: { run: 'npm test' } },
    default: { after_task: { use: 'stack' }, before_task: null },
  };
  assert.deepEqual(resolveHook('after_task', layers), { source: 'stack', commands: ['npm test'] });
  layers.config.after_task = { run: 'npx jest --ci' };
  assert.equal(resolveHook('after_task', layers).commands[0], 'npx jest --ci');
  layers.config.after_task = { use: 'stack' };
  assert.equal(resolveHook('after_task', layers).commands[0], 'npm test');
  layers.env.after_task = { run: 'pnpm test' };
  assert.equal(resolveHook('after_task', layers).source, 'env');
  layers.env.after_task = null;
  assert.deepEqual(resolveHook('after_task', layers).commands, []);
  assert.equal(resolveHook('before_task', layers).source, 'default');
});

test('hooks: circular use: references do not loop', () => {
  const layers = { env: {}, config: {}, stack: { x: { use: 'default' } }, default: { x: { use: 'stack' } } };
  assert.deepEqual(resolveHook('x', layers).commands, []);
});

test('hooks: several stacks run their commands in turn', () => {
  const defaults = { after_task: { use: 'stack' }, before_goal: { run: 'git pull' } };
  const node = { hooks: { after_task: { run: ['npm run lint', 'npm test'] }, before_goal: { use: 'default' }, on_block: null } };
  const python = { hooks: { after_task: { run: 'npm test' }, before_goal: { run: 'uv sync' }, on_block: null } };
  assert.deepEqual(mergeStackHooks([node, python], defaults), {
    after_task: { run: ['npm run lint', 'npm test'] },
    before_goal: { run: ['git pull', 'uv sync'] },
    on_block: null,
  });
  assert.deepEqual(mergeStackHooks([node, null], defaults), node.hooks, 'one stack keeps its values as written');
  assert.deepEqual(mergeStackHooks([], defaults), {});
});

test('cli: full gated flow from init to completed', () => {
  const { dir, run } = project();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');

  const init = run(['init']);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(init.json.detected_stacks, ['nodejs']);
  for (const s of ['pending', 'in-progress', 'blocked', 'completed', 'cancelled']) assert.ok(fs.existsSync(path.join(dir, '.aisdlc/goals', s)));
  assert.ok(['registry.md', 'registry-archive.md'].every((f) => init.json.created.includes(path.join('.aisdlc', f))), 'init reports the registry views');
  assert.equal(run(['init']).json.created.length, 0, 'init is idempotent');

  const goal = run(['goal', 'new', 'User', 'login']).json;
  assert.equal(goal.id, 'G-001');
  fill(path.join(dir, goal.file));
  const t1 = run(['task', 'new', 'G-001', 'Schema', '--risk', 'high', '--verify', 'true']).json;
  assert.equal(t1.id, 'T-01');
  const t2 = run(['task', 'new', 'G-001', 'API', '--depends', 'T-01', '--verify', 'true']).json;
  assert.equal(t2.id, 'T-02');
  for (const f of [t1.file, t2.file]) fill(path.join(dir, f));
  assert.equal(run(['task', 'new', 'G-001', 'Bad', '--depends', 'T-09']).code, 1);
  assert.equal(run(['dag', 'write', 'G-001']).json.ok, true);

  // Strict gating.
  assert.equal(run(['gate', 'require', 'G-001', 'adr']).code, 1);
  assert.equal(run(['gate', 'require', 'G-001', 'implement']).code, 1);
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  assert.equal(run(['gate', 'set', 'G-001', 'adr', 'done']).code, 1, 'adr gate needs a link or none+reason');
  run(['adr', 'none', 'G-001', '--reason', 'no architectural change']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);
  assert.equal(run(['gate', 'set', 'G-001', 'govern', 'passed']).code, 1, 'govern needs a passing review');
  const goalDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  assert.equal(run(['state', 'move', 'G-001', 'in-progress']).code, 1, 'cannot start before govern passes');
  writeReview(goalDir, 'G-001');
  run(['gate', 'set', 'G-001', 'govern', 'passed']);
  assert.equal(run(['gate', 'require', 'G-001', 'implement']).code, 0);

  // Re-running challenge invalidates governance and its review, so the old review cannot re-pass.
  assert.equal(run(['gate', 'set', 'G-001', 'challenge', 'done']).json.notes.length, 2);
  assert.ok(fs.existsSync(path.join(goalDir, 'governance-review.stale-1.md')));
  assert.equal(run(['gate', 'require', 'G-001', 'implement']).code, 1);
  assert.equal(run(['gate', 'set', 'G-001', 'govern', 'passed']).code, 1, 'stale review does not count');
  writeReview(goalDir, 'G-001');
  run(['gate', 'set', 'G-001', 'govern', 'passed']);

  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'in-progress']).code, 1, 'goal must be in progress first');
  run(['state', 'move', 'G-001', 'in-progress']);
  assert.deepEqual(run(['dag', 'next', 'G-001']).json.ready, ['T-01']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'blocked']).code, 1, 'blocked needs --reason');
  assert.equal(run(['task', 'set', 'G-001', 'T-02', 'in-progress']).code, 1, 'T-02 waits for T-01');
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'done']).code, 1, 'done needs a passing verify');
  assert.equal(run(['task', 'verify', 'G-001', 'T-01']).code, 0);
  run(['task', 'review', 'G-001', 'T-01', 'pass', '--evidence', 'checked']);
  run(['task', 'set', 'G-001', 'T-01', 'done']);
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 1, 'cannot complete with open tasks');
  run(['task', 'set', 'G-001', 'T-02', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-02']);
  run(['task', 'review', 'G-001', 'T-02', 'pass', '--evidence', 'checked']);
  const last = run(['task', 'set', 'G-001', 'T-02', 'done']);
  assert.equal(last.json.progress.complete, true);

  // init seeds GOV-06, a final rule whose criteria-met check needs every criterion ticked.
  assert.match(run(['state', 'move', 'G-001', 'completed']).stderr, /needs a passing final governance review/);
  const final = { rules: ['GOV-06'], file: 'governance-final.md' };
  const liveDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  writeReview(liveDir, 'G-001', {}, 'pass', final);
  assert.match(run(['gate', 'set', 'G-001', 'final', 'passed']).stderr, /GOV-06 is pass but its automatic check "criteria-met" failed: goal criterion not met: It works; T-01 criterion not met/);
  tick(path.join(liveDir, 'goal.md'));
  for (const t of run(['goal', 'show', 'G-001']).json.tasks) tick(path.join(dir, t.file));
  assert.equal(run(['gate', 'set', 'G-001', 'final', 'passed']).code, 0);
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 0);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'pending']).code, 1, 'completed goals are frozen');
  assert.match(run(['state', 'move', 'G-001', 'in-progress']).stderr, /completed; it can no longer move/);

  // Finished goals leave registry.md for the archive, so the file skills read only grows with open work.
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.aisdlc/registry.md'), 'utf8'), /G-001/);
  assert.match(fs.readFileSync(path.join(dir, '.aisdlc/registry-archive.md'), 'utf8'), /\| G-001 \| goal \| User login \| completed \(2\/2\) \| adr: none \|/);
});

test('cli: adr new links both directions', () => {
  const { run, dir } = project();
  run(['init']);
  run(['goal', 'new', 'Billing']);
  assert.equal(run(['adr', 'new', 'Use', 'Stripe', '--goal', 'G-001']).json.id, 'ADR-001');
  assert.deepEqual(run(['goal', 'show', 'G-001']).json.adrs, ['ADR-001']);
  assert.match(fs.readFileSync(path.join(dir, '.aisdlc/registry.md'), 'utf8'), /\| ADR-001 \| adr \| Use Stripe \| proposed \| G-001 \|/);
  assert.deepEqual(run(['adr', 'list']).json, [{ id: 'ADR-001', title: 'Use Stripe', status: 'proposed', goals: ['G-001'], file: '.aisdlc/adr/ADR-001-use-stripe.md' }]);
  assert.deepEqual(run(['adr', 'list', '--status', 'accepted,superseded']).json, []);
});

test('cli: hooks resolve uses stack manifest, config and env, with variables', () => {
  const { run, dir } = project();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  run(['init', '--base-branch', 'main']);
  assert.match(run(['hooks', 'resolve', 'before_goal']).json.commands[0], /git checkout main/);
  assert.deepEqual(run(['hooks', 'resolve', 'after_task']).json.commands, []);

  fs.writeFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), JSON.stringify({ name: 'nodejs', hooks: { after_task: { run: 'npm test' } } }));
  assert.deepEqual(run(['hooks', 'resolve', 'after_task']).json.commands, ['npm test']);

  run(['config', 'set', 'hooks.after_task', '{"run":"npx jest --ci"}']);
  assert.deepEqual(run(['hooks', 'resolve', 'after_task']).json.commands, ['npx jest --ci']);
  assert.deepEqual(run(['hooks', 'resolve', 'after_task'], { AISDLC_HOOK_AFTER_TASK: 'none' }).json.commands, []);

  run(['config', 'set', 'hooks.before_task', '{"run":"echo {task_id} on {goal_branch}"}']);
  run(['goal', 'new', 'Search']);
  assert.equal(run(['hooks', 'resolve', 'before_task', '--goal', 'G-001', '--task', 'T-03']).json.commands[0], 'echo T-03 on feature/G-001-search');

  const ok = run(['hooks', 'run', 'before_task', '--goal', 'G-001', '--task', 'T-03']);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /T-03 on feature\/G-001-search/);
  run(['config', 'set', 'hooks.on_block', '{"run":"exit 3"}']);
  assert.equal(run(['hooks', 'run', 'on_block']).code, 3);
});

test('cli: every detected stack with an installed manifest is active, with its hooks and standards', () => {
  const { run, dir } = project();
  const write = (file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
  run(['init']);
  assert.deepEqual(run(['detect-stack']).json, { configured: 'auto', detected: ['nodejs', 'python'], active: [], standards_skills: [], to_register: [], without_plugin: ['nodejs', 'python'], stacks: [
    { stack: 'nodejs', detected: true, active: false, manifest_installed: false, standards_skill: null, plugin: null, plugin_version: null, register_skill: null },
    { stack: 'python', detected: true, active: false, manifest_installed: false, standards_skill: null, plugin: null, plugin_version: null, register_skill: null },
  ] });

  write('.aisdlc/stacks/nodejs.json', { name: 'nodejs', standards_skill: 'aisdlc-nodejs:nodejs-standards', hooks: { after_task: { run: 'npm test' } } });
  let report = run(['detect-stack']).json;
  assert.deepEqual([report.active, report.standards_skills, report.without_plugin], [['nodejs'], ['aisdlc-nodejs:nodejs-standards'], ['python']]);
  assert.deepEqual(run(['hooks', 'resolve', 'after_task']).json.commands, ['npm test']);

  // A second registered stack joins the first: its standards load and its commands run after the first stack's.
  write('.aisdlc/stacks/python.json', { name: 'python', standards_skill: 'aisdlc-python:python-standards', hooks: { after_task: { run: ['pytest', 'npm test'] }, before_task: null } });
  report = run(['detect-stack']).json;
  assert.deepEqual([report.active, report.standards_skills, report.without_plugin], [['nodejs', 'python'], ['aisdlc-nodejs:nodejs-standards', 'aisdlc-python:python-standards'], []]);
  assert.deepEqual(run(['hooks', 'resolve', 'after_task']).json, { point: 'after_task', stacks: ['nodejs', 'python'], source: 'stack', commands: ['npm test', 'pytest'] });
  assert.deepEqual(run(['hooks', 'resolve', 'before_task']).json.commands, []);

  // A manifest registered before stack skills were named after their stack still finds the renamed skill.
  const manifest = path.join(dir, '.aisdlc/stacks/nodejs.json');
  write('.aisdlc/stacks/nodejs.json', { name: 'nodejs', standards_skill: 'aisdlc-nodejs:standards' });
  assert.equal(run(['detect-stack']).json.standards_skills[0], 'aisdlc-nodejs:nodejs-standards');
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).standards_skill, 'aisdlc-nodejs:standards');

  // A configured stack applies even without its marker; registered ones still join it.
  run(['config', 'set', 'stack', 'go']);
  assert.deepEqual(run(['detect-stack']).json.active, ['go', 'nodejs', 'python']);
  run(['config', 'set', 'stack', '["python","go"]']);
  assert.deepEqual(run(['detect-stack']).json.active, ['python', 'go', 'nodejs']);
});

test('cli: with nothing registered, a single detected stack is active', () => {
  const { run, dir } = project();
  fs.writeFileSync(path.join(dir, 'App.csproj'), '');
  run(['init']);
  assert.deepEqual(run(['detect-stack']).json.active, ['dotnet']);
  run(['goal', 'new', 'A']);
  assert.deepEqual(run(['coverage', 'check', 'G-001']).json.notes, ['No .aisdlc/stacks/dotnet.json is installed, so no coverage report is declared.']);
});

test('cli: stack plugins declare their markers and register skill, and unregistered stacks are reported', () => {
  const { run, dir } = project();
  const plugins = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-plugins-'));
  const plugin = (folder, meta, stack, skills) => {
    const root = path.join(plugins, folder);
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    if (meta) fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(root, 'stack.json'), JSON.stringify(stack));
    for (const s of skills) { fs.mkdirSync(path.join(root, 'skills', s), { recursive: true }); fs.writeFileSync(path.join(root, 'skills', s, 'SKILL.md'), ''); }
    return root;
  };
  const elixir = plugin('ex', { name: 'aisdlc-elixir', version: '1.2.0' }, { name: 'elixir', markers: ['mix.exs', '*.exs'] }, ['elixir-register', 'elixir-standards']);
  const python = plugin('py', { name: 'aisdlc-python' }, { name: 'python' }, ['register']);
  const other = plugin('other', null, { name: 'elixir', markers: ['other.txt'] }, []);
  const broken = path.join(plugins, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'stack.json'), '{');
  const env = { AISDLC_STACK_PLUGINS: [elixir, python, other, broken, path.join(plugins, 'missing')].join(path.delimiter) };

  fs.writeFileSync(path.join(dir, 'config.exs'), '');
  fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
  fs.writeFileSync(path.join(dir, 'other.txt'), '');
  run(['init'], env);
  const report = run(['detect-stack'], env).json;
  assert.deepEqual(report.detected, ['python', 'elixir'], 'the first plugin for a stack declares its markers');
  assert.deepEqual(report.to_register, [
    { stack: 'python', plugin: 'aisdlc-python', register_skill: 'aisdlc-python:register' },
    { stack: 'elixir', plugin: 'aisdlc-elixir', register_skill: 'aisdlc-elixir:elixir-register' },
  ]);
  assert.equal(report.stacks[1].plugin_version, '1.2.0');

  fs.writeFileSync(path.join(dir, '.aisdlc/stacks/elixir.json'), JSON.stringify({ name: 'elixir' }));
  assert.deepEqual(run(['detect-stack'], env).json.to_register.map((s) => s.stack), ['python']);
  assert.deepEqual(run(['detect-stack'], env).json.active, ['elixir']);
});

test('cli: stack plugins are found where Claude Code and GitHub Copilot install them', () => {
  const { run, dir } = project();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-home-'));
  const stackPlugin = (root, name, stack, marker) => {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
    fs.writeFileSync(path.join(root, 'stack.json'), JSON.stringify({ name: stack, markers: [marker] }));
  };
  // Claude Code keeps old versions in its cache; only the installed one counts.
  const cache = path.join(home, 'claude', 'plugins', 'cache', 'm', 'aisdlc-zig');
  stackPlugin(path.join(cache, 'old'), 'aisdlc-zig', 'zig-old', 'old.zig');
  stackPlugin(path.join(cache, 'new'), 'aisdlc-zig', 'zig', 'build.zig');
  fs.writeFileSync(path.join(home, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'aisdlc-zig@m': [{ scope: 'user', installPath: path.join(cache, 'new') }] } }));
  // Copilot CLI: config.json entries (a disabled one is skipped) and installed-plugins/<marketplace>/<plugin>/.
  const copilot = path.join(home, 'copilot');
  stackPlugin(path.join(copilot, 'installed-plugins', 'm', 'aisdlc-nim'), 'aisdlc-nim', 'nim', 'app.nimble');
  stackPlugin(path.join(home, 'elsewhere', 'aisdlc-odin'), 'aisdlc-odin', 'odin', 'main.odin');
  stackPlugin(path.join(home, 'elsewhere', 'aisdlc-off'), 'aisdlc-off', 'off', 'off.txt');
  fs.writeFileSync(path.join(copilot, 'config.json'), JSON.stringify({ installedPlugins: [
    { name: 'aisdlc-odin', cache_path: path.join(home, 'elsewhere', 'aisdlc-odin'), enabled: true },
    { name: 'aisdlc-off', cache_path: path.join(home, 'elsewhere', 'aisdlc-off'), enabled: false },
  ] }));
  for (const f of ['build.zig', 'old.zig', 'app.nimble', 'main.odin', 'off.txt']) fs.writeFileSync(path.join(dir, f), '');
  run(['init']);
  // Without AISDLC_STACK_PLUGINS the script searches; plugins next to this one (in this repository) may add stacks.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), COPILOT_HOME: copilot };
  delete env.AISDLC_STACK_PLUGINS;
  const detected = JSON.parse(spawnSync(process.execPath, [SCRIPT, 'detect-stack'], { cwd: dir, encoding: 'utf8', env }).stdout).detected;
  assert.deepEqual(detected.filter((s) => ['zig', 'zig-old', 'nim', 'odin', 'off'].includes(s)).sort(), ['nim', 'odin', 'zig']);
});

test('cli: after_goal checks the coverage report, then pushes the goal branch, by default', () => {
  const { run } = project();
  run(['init']);
  run(['goal', 'new', 'Search']);
  const r = run(['hooks', 'resolve', 'after_goal', '--goal', 'G-001']).json;
  assert.equal(r.source, 'default');
  assert.deepEqual(r.commands, [`"${process.execPath}" "${SCRIPT}" coverage check G-001`, `"${process.execPath}" "${SCRIPT}" goal push G-001`]);
});

test('cli: goal push pushes the goal branch and refuses the base branch', { skip: process.platform === 'win32' }, () => {
  const { run, dir } = project();
  run(['init']);
  run(['goal', 'new', 'A']);
  assert.match(run(['goal', 'push', 'G-001']).stderr, /needs a git repository/);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-remote-'));
  gitIn(remote, 'init', '-q', '--bare');
  gitIn(dir, 'init', '-q', '-b', 'develop');
  gitIn(dir, 'remote', 'add', 'origin', remote);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'base');

  assert.match(run(['goal', 'push', 'G-001']).stderr, /G-001 has no branch recorded/);
  run(['goal', 'set', 'G-001', 'branch', 'develop']);
  const onBase = run(['goal', 'push', 'G-001']);
  assert.equal(onBase.code, 1);
  assert.match(onBase.stderr, /built on the base branch develop, and aisdlc never pushes the base branch/);
  run(['goal', 'set', 'G-001', 'branch', 'feature/a']);
  assert.match(run(['goal', 'push', 'G-001']).stderr, /The goal's branch feature\/a doesn't exist/);
  gitIn(dir, 'checkout', '-q', '-b', 'feature/a');
  const pushed = run(['goal', 'push', 'G-001']);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.match(pushed.stdout, /git push -u origin feature\/a/);
  assert.match(gitIn(remote, 'branch', '--list').stdout, /feature\/a/);
  assert.doesNotMatch(gitIn(remote, 'branch', '--list').stdout, /develop/);
});

test('cli: coverage check reads the report the stack declares and holds it to the thresholds', () => {
  const { run, dir } = project();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  run(['init']);
  run(['goal', 'new', 'Search']);
  const check = () => run(['coverage', 'check', 'G-001']);
  const manifest = (qualityGate) => fs.writeFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), JSON.stringify({ name: 'nodejs', quality_gate: qualityGate }));
  const report = (file, text) => { fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true }); fs.writeFileSync(path.join(dir, 'coverage', file), text); };
  const summary = (pct) => JSON.stringify({ total: Object.fromEntries(['lines', 'statements', 'functions', 'branches'].map((m) => [m, { total: 10, covered: 9, pct: pct[m] ?? 90 }])) });

  assert.equal(run(['coverage', 'check']).code, 1);
  assert.match(check().json.notes[0], /No \.aisdlc\/stacks\/nodejs\.json is installed/);
  assert.equal(check().code, 0, 'without a stack manifest nothing is declared, so nothing fails');

  manifest({ coverage_thresholds: { lines: 80 } });
  assert.match(check().json.problems[0], /declares no quality_gate\.coverage_report/);
  manifest({ coverage_report: { path: 'coverage/out.xml', format: 'cobertura' } });
  assert.match(check().json.problems[0], /unknown coverage report format "cobertura"\. Valid: json-summary, lcov/);

  const thresholds = { branches: 80, functions: 80, lines: 80, statements: 80 };
  manifest({ coverage_report: { path: 'coverage/coverage-summary.json', format: 'json-summary' }, coverage_thresholds: thresholds });
  assert.match(check().json.problems[0], /coverage\/coverage-summary\.json doesn't exist.*hooks run after_task --goal G-001/);
  report('coverage-summary.json', '{"files":{}}');
  assert.match(check().json.problems[0], /isn't a valid json-summary report: it has no "total" entry/);
  report('coverage-summary.json', summary({}));
  const ok = check();
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(ok.json.reports[0].metrics, { lines: 90, statements: 90, functions: 90, branches: 90 });
  assert.match(ok.json.notes[0], /isn't a git repository/);
  report('coverage-summary.json', summary({ branches: 72.5, lines: 'Unknown' }));
  const low = check();
  assert.equal(low.code, 1);
  assert.deepEqual(low.json.problems, ['branches coverage is 72.5%, below the 80% threshold.']);
  assert.equal(low.json.reports[0].metrics.lines, 90, 'a pct Istanbul could not compute comes from covered/total');

  // LCOV sums every file's records and has no statement figures.
  manifest({ coverage_report: { path: 'coverage/lcov.info', format: 'lcov' }, coverage_thresholds: thresholds });
  report('lcov.info', 'SF:a.js\nFNF:2\nFNH:2\nLF:10\nLH:9\nBRF:4\nBRH:3\nend_of_record\nSF:b.js\nFNF:2\nFNH:1\nLF:10\nLH:7\nend_of_record\n');
  const lcov = check().json;
  assert.deepEqual(lcov.reports[0].metrics, { lines: 80, branches: 75, functions: 75 });
  assert.deepEqual(lcov.problems, [
    'branches coverage is 75%, below the 80% threshold.',
    'functions coverage is 75%, below the 80% threshold.',
    'coverage/lcov.info has no statements figure, but .aisdlc/stacks/nodejs.json sets a statements threshold of 80%.',
  ]);
  report('lcov.info', 'TN:\nend_of_record\n');
  assert.match(check().json.problems[0], /isn't a valid lcov report: it has no LF: line counts/);
});

test('cli: coverage check fails a report older than a file the goal changed', { skip: process.platform === 'win32' }, () => {
  const { run, dir } = project();
  gitIn(dir, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'coverage/\n');
  run(['init']);
  run(['goal', 'new', 'A']);
  fs.writeFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), JSON.stringify({ name: 'nodejs', quality_gate: { coverage_report: { path: 'coverage/lcov.info', format: 'lcov' }, coverage_thresholds: { lines: 80 } } }));
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'base');
  gitIn(dir, 'checkout', '-q', '-b', 'feature/a');
  run(['goal', 'set', 'G-001', 'branch', 'feature/a']);
  fs.writeFileSync(path.join(dir, 'a.js'), '1\n');
  gitIn(dir, 'add', 'a.js');
  gitIn(dir, 'commit', '-qm', 'a');
  fs.writeFileSync(path.join(dir, 'b.js'), '2\n');
  fs.mkdirSync(path.join(dir, 'coverage'));
  fs.writeFileSync(path.join(dir, 'coverage/lcov.info'), 'LF:10\nLH:9\n');
  const past = new Date(Date.now() - 60_000);
  for (const f of ['a.js', 'b.js']) fs.utimesSync(path.join(dir, f), past, past);
  const fresh = run(['coverage', 'check', 'G-001']);
  assert.equal(fresh.code, 0, fresh.stdout);
  assert.deepEqual(fresh.json.notes, []);

  const future = new Date(Date.now() + 60_000);
  for (const f of ['a.js', 'b.js']) fs.utimesSync(path.join(dir, f), future, future);
  const stale = run(['coverage', 'check', 'G-001']);
  assert.equal(stale.code, 1);
  assert.deepEqual(stale.json.problems, ['coverage/lcov.info is older than a.js, b.js, which the goal changed, so it may not cover the finished code. Run `hooks run after_task --goal G-001` to write it again.']);
});

test('cli: tasks cannot be finished, nor goals completed, outside the gated flow', () => {
  const { run } = project();
  run(['init']);
  run(['goal', 'new', 'Bypass']);
  run(['task', 'new', 'G-001', 'A']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'done']).code, 1, 'goal is still pending');
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 1, 'gates are pending');
  assert.equal(run(['goal', 'list']).json[0].status, 'pending');
});

test('cli: task verify runs verify then after_task, records the result, and needs evidence for manual checks', () => {
  const { run, dir } = project();
  run(['init']);
  run(['config', 'set', 'hooks.after_task', '{"run":"echo after {task_id}"}']);
  governedGoal(run, dir, [['Pass', '--verify', 'echo checked'], ['Fail', '--verify', 'exit 4'], ['Manual', '--verify', 'manual: open /health and see 200']]);
  run(['state', 'move', 'G-001', 'in-progress']);
  for (const id of ['T-01', 'T-02', 'T-03']) run(['task', 'set', 'G-001', id, 'in-progress']);

  const ok = run(['task', 'verify', 'G-001', 'T-01']);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /checked[\s\S]*after T-01[\s\S]*verify T-01: pass/);

  const bad = run(['task', 'verify', 'G-001', 'T-02']);
  assert.equal(bad.code, 4);
  assert.doesNotMatch(bad.stdout, /after T-02/, 'after_task is skipped once verify fails');
  assert.equal(run(['task', 'set', 'G-001', 'T-02', 'done']).code, 1);

  assert.equal(run(['task', 'verify', 'G-001', 'T-03']).code, 1, 'manual check needs --evidence');
  assert.equal(run(['task', 'verify', 'G-001', 'T-03', '--evidence', 'curl returned 200']).code, 0);
  run(['task', 'review', 'G-001', 'T-03', 'pass', '--evidence', 'checked']);
  assert.equal(run(['task', 'set', 'G-001', 'T-03', 'done']).code, 0);

  // Going back to in-progress clears the recorded result.
  run(['task', 'set', 'G-001', 'T-01', 'pending']);
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'done']).code, 1);
});

test('cli: govern passes only with a review that covers every active rule and fails no must rule', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A']]);
  const goalDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  const pass = () => run(['gate', 'set', 'G-001', 'govern', 'passed']);

  writeReview(goalDir, 'G-001', { 'GOV-02': ['fail', 'T-01 has no verify'] });
  assert.match(pass().stderr, /GOV-02 is a must rule and failed/);
  writeReview(goalDir, 'G-001', { 'GOV-05': ['n/a'] });
  assert.match(pass().stderr, /GOV-05 is n\/a without a note/);
  writeReview(goalDir, 'G-001', { 'GOV-03': ['pass', ''] });
  assert.match(pass().stderr, /GOV-03 is pass without a note \(cite the evidence\)/);
  writeReview(goalDir, 'G-002');
  assert.match(pass().stderr, /review is for G-002/);

  // New rules must be reviewed; retired and failed `should` rules do not block.
  run(['governance', 'add', 'Has docs.', '--severity', 'should', '--stage', 'plan']);
  run(['governance', 'add', 'Old rule.', '--severity', 'should', '--stage', 'plan']);
  run(['governance', 'set', 'GOV-08', 'severity', 'retired']);
  writeReview(goalDir, 'G-001');
  assert.match(pass().stderr, /GOV-07 is missing/);
  fs.appendFileSync(path.join(goalDir, 'governance-review.md'), '| GOV-07 | fail | no README section |\n');
  assert.equal(pass().code, 0);
});

test('cli: adr gate needs accepted ADRs, and adr none removes back-links', () => {
  const { run, dir } = project();
  run(['init']);
  run(['goal', 'new', 'Billing']);
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  const adr = path.join(dir, run(['adr', 'new', 'Use', 'Stripe', '--goal', 'G-001']).json.file);
  assert.match(run(['gate', 'set', 'G-001', 'adr', 'done']).stderr, /ADR-001 \(proposed\) not accepted/);
  fs.writeFileSync(adr, fs.readFileSync(adr, 'utf8').replace('status: proposed', 'status: accepted'));
  assert.equal(run(['gate', 'set', 'G-001', 'adr', 'done']).code, 0);

  run(['adr', 'none', 'G-001', '--reason', 'decided against']);
  assert.deepEqual(parseDoc(fs.readFileSync(adr, 'utf8')).data.goals, []);
});

test('cli: blocked goals resume, and damaged goal files keep their IDs', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A'], ['B', '--depends', 'T-01']]);
  run(['state', 'move', 'G-001', 'in-progress']);
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'blocked', '--reason', 'waiting on API key']).json.progress.stuck, true);
  run(['state', 'move', 'G-001', 'blocked']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'in-progress']).code, 1, 'blocked goal must be resumed first');
  run(['task', 'set', 'G-001', 'T-01', 'pending']);
  assert.equal(run(['state', 'move', 'G-001', 'in-progress']).code, 0);

  // A goal.md that loses its frontmatter (or has CRLF endings) is still found by ID.
  const file = path.join(dir, run(['goal', 'show', 'G-001']).json.dir, 'goal.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(run(['goal', 'show', 'G-001']).code, 0);
  fs.writeFileSync(file, '# broken\n');
  assert.equal(run(['goal', 'new', 'Next']).json.id, 'G-002');
});

test('cli: argument and value guards', () => {
  const { run, dir } = project();
  assert.equal(run(['hooks', 'run', 'pre_init']).code, 0, 'pre_init runs before .aisdlc exists');
  run(['init']);
  run(['goal', 'new', 'Guards']);
  const task = path.join(dir, run(['task', 'new', 'G-001', 'Version', '--verify', '--version']).json.file);
  assert.equal(parseDoc(fs.readFileSync(task, 'utf8')).data.verify, '--version');
  assert.equal(run(['goal', 'set', 'G-001', 'adrs', 'none']).code, 1);
  assert.equal(run(['goal', 'set', 'G-001', 'branch', 'x;rm -rf ~']).code, 1);
  assert.equal(run(['goal', 'set', 'G-001', 'branch', 'feature/G-001-guards']).code, 0);
  assert.match(run(['goal', 'new', 'Two\nlines']).stderr, /single line/);
});

test('cli: automatic checks stop a review from passing rules the files do not meet', () => {
  const { run, dir } = project();
  run(['init']);
  run(['goal', 'new', 'Empty']);
  run(['task', 'new', 'G-001', 'A']);
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  run(['adr', 'none', 'G-001', '--reason', 'no architectural change']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);

  const checks = run(['governance', 'checks', 'G-001']).json;
  assert.deepEqual(checks.map((c) => [c.rule, c.ok]), [['GOV-01', false], ['GOV-02', false], ['GOV-03', true], ['GOV-04', true], ['GOV-05', true]]);
  assert.deepEqual(checks[1].problems, ['T-01 has no verify command or manual check', 'T-01 has no acceptance criteria']);

  const goalDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  writeReview(goalDir, 'G-001');
  const r = run(['gate', 'set', 'G-001', 'govern', 'passed']);
  assert.match(r.stderr, /GOV-01 is pass but its automatic check "goal-defined" failed: goal has no Problem statement; goal has no acceptance criteria/);
  assert.match(r.stderr, /GOV-02 is pass but its automatic check "tasks-verifiable" failed/);
  writeReview(goalDir, 'G-001', { 'GOV-02': ['n/a', 'no tests here'] });
  assert.match(run(['gate', 'set', 'G-001', 'govern', 'passed']).stderr, /GOV-02 is n\/a but its automatic check/);
});

test('cli: a plan change after governance passed needs a new review; progress does not', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A'], ['B']]);
  run(['state', 'move', 'G-001', 'in-progress']);
  const goalDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  const task = path.join(dir, run(['goal', 'show', 'G-001']).json.tasks[0].file);
  const stale = () => run(['gate', 'require', 'G-001', 'implement']).json.problems.join();

  // Doing the work (status, verify results, ticked boxes, Notes) keeps the plan governed.
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-01']);
  run(['task', 'review', 'G-001', 'T-01', 'pass', '--evidence', 'checked']);
  edit(task, (s) => s.replace('- [ ] It works', '- [x] It works').replace('## Notes\n', '## Notes\n\nAsked the user: keep the old API.\n'));
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'done']).code, 0);
  assert.equal(stale(), '');

  // Editing what was reviewed stops the next task from starting.
  edit(task, (s) => s.replace('- [x] It works', '- [x] It works fast'));
  assert.match(stale(), /plan .* changed after governance passed/);
  assert.match(run(['task', 'set', 'G-001', 'T-02', 'in-progress']).stderr, /changed after governance passed/);
  edit(task, (s) => s.replace('It works fast', 'It works'));
  assert.equal(stale(), '');

  // A goal governed before fingerprints existed (0.1.0) is told why it must be re-governed.
  const goalFile = path.join(goalDir, 'goal.md');
  const governed = fs.readFileSync(goalFile, 'utf8');
  edit(goalFile, (s) => s.replace(/^govern_fingerprint: .*$/m, 'govern_fingerprint:'));
  assert.match(stale(), /governance passed before aisdlc 0.2.0/);
  fs.writeFileSync(goalFile, governed);

  // A new task resets governance and archives the review without overwriting older archives.
  const added = run(['task', 'new', 'G-001', 'Extra', '--verify', 'true']);
  assert.deepEqual(added.json.notes, [
    'gate_govern reset to pending; re-run /aisdlc:govern G-001',
    'governance-review.md is now stale (moved to governance-review.stale-1.md)',
  ]);
  assert.match(run(['task', 'set', 'G-001', 'T-02', 'in-progress']).stderr, /run \/aisdlc:govern G-001 first/);
  fill(path.join(dir, added.json.file));
  writeReview(goalDir, 'G-001');
  run(['gate', 'set', 'G-001', 'govern', 'passed']);
  assert.equal(run(['task', 'set', 'G-001', 'T-02', 'in-progress']).code, 0);
  run(['gate', 'set', 'G-001', 'govern', 'pending']);
  assert.ok(fs.existsSync(path.join(goalDir, 'governance-review.stale-2.md')));
  assert.ok(!fs.existsSync(path.join(goalDir, 'governance-review.md')));
});

test('cli: linking another ADR after the adr gate reopens it', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A']]);
  const r = run(['adr', 'new', 'Use', 'Redis', '--goal', 'G-001']);
  assert.deepEqual(r.json.notes.slice(0, 2), ['gate_adr reset to pending; re-run /aisdlc:adr G-001', 'gate_govern reset to pending; re-run /aisdlc:govern G-001']);
  assert.equal(run(['goal', 'show', 'G-001']).json.gates.adr, 'pending');
  assert.equal(run(['adr', 'link', 'ADR-001', 'G-001']).json.notes.length, 0, 'an existing link changes nothing');
});

test('cli: task verify needs evidence when nothing would run', () => {
  const { run, dir } = project();
  run(['init']);
  const goal = plannedGoal(run, dir, [['A', '--verify', 'true']]);
  // Clear the verify command after planning (GOV-02 is retired so the plan still passes).
  run(['governance', 'set', 'GOV-02', 'severity', 'retired']);
  edit(path.join(dir, run(['goal', 'show', goal.id]).json.tasks[0].file), (s) => s.replace('verify: true', 'verify:'));
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  run(['adr', 'none', 'G-001', '--reason', 'none']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);
  writeReview(path.join(dir, run(['goal', 'show', 'G-001']).json.dir), 'G-001', {}, 'pass', { rules: ['GOV-01', 'GOV-03', 'GOV-04', 'GOV-05'] });
  assert.equal(run(['gate', 'set', 'G-001', 'govern', 'passed']).code, 0);
  run(['state', 'move', 'G-001', 'in-progress']);
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  assert.match(run(['task', 'verify', 'G-001', 'T-01']).stderr, /nothing would run/);
  assert.equal(run(['task', 'verify', 'G-001', 'T-01', '--evidence', 'opened the page']).code, 0);
  const task = path.join(dir, run(['goal', 'show', goal.id]).json.tasks[0].file);
  assert.equal(parseDoc(fs.readFileSync(task, 'utf8')).data.verify_evidence, 'opened the page');
});

test('cli: final-stage rules gate completion', () => {
  const { run, dir } = project();
  run(['init']);
  // The seeded GOV-06 (criteria-met) has its own test; this one is about rules a project adds.
  run(['governance', 'set', 'GOV-06', 'severity', 'retired']);
  assert.deepEqual(run(['governance', 'add', 'New', 'behavior', 'has', 'tests.', '--severity', 'must', '--stage', 'final']).json,
    { id: 'GOV-07', rule: 'New behavior has tests.', severity: 'must', stage: 'final', check: '' });
  run(['governance', 'add', 'Docs updated.', '--severity', 'should', '--stage', 'final']);
  governedGoal(run, dir, [['A']]);
  assert.equal(run(['goal', 'show', 'G-001']).json.final_review_required, true);
  run(['state', 'move', 'G-001', 'in-progress']);
  const goalDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  assert.match(run(['gate', 'require', 'G-001', 'final']).json.problems.join(), /not every task is done/);

  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-01']);
  run(['task', 'review', 'G-001', 'T-01', 'pass', '--evidence', 'checked']);
  run(['task', 'set', 'G-001', 'T-01', 'done']);
  assert.match(run(['state', 'move', 'G-001', 'completed']).stderr, /needs a passing final governance review/);
  assert.equal(run(['gate', 'require', 'G-001', 'final']).code, 0);

  const final = { rules: ['GOV-07', 'GOV-08'], file: 'governance-final.md' };
  writeReview(goalDir, 'G-001', { 'GOV-07': ['fail', 'no tests for the parser'] }, 'fail', final);
  assert.match(run(['gate', 'set', 'G-001', 'final', 'passed']).stderr, /GOV-07 is a must rule and failed/);
  writeReview(goalDir, 'G-001', { 'GOV-08': ['fail', 'README not updated'] }, 'pass', final);
  assert.equal(run(['gate', 'set', 'G-001', 'final', 'passed']).code, 0);
  assert.deepEqual(run(['goal', 'show', 'G-001']).json.governance.final.failed, [{ rule: 'GOV-08', notes: 'README not updated' }]);

  // Touching a task after the final review sends it back.
  run(['task', 'set', 'G-001', 'T-01', 'pending']);
  assert.equal(run(['goal', 'show', 'G-001']).json.gates.final, 'pending');
  assert.ok(fs.existsSync(path.join(goalDir, 'governance-final.stale-1.md')));
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-01']);
  run(['task', 'review', 'G-001', 'T-01', 'pass', '--evidence', 'checked']);
  run(['task', 'set', 'G-001', 'T-01', 'done']);
  writeReview(goalDir, 'G-001', {}, 'pass', final);
  run(['gate', 'set', 'G-001', 'final', 'passed']);
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 0);
});

test('cli: governance rules are validated, never renumbered, and old tables are upgraded', () => {
  const { run, dir } = project();
  run(['init']);
  const gov = path.join(dir, '.aisdlc/governance.md');
  const original = fs.readFileSync(gov, 'utf8');

  edit(gov, (s) => s.replace('| GOV-03 | Task DAG is valid (no cycles, no unknown dependencies). | must |', '| GOV-03 | Task DAG is valid. | mandatory |'));
  assert.match(run(['governance', 'list']).stderr, /GOV-03 has severity "mandatory"/);
  fs.writeFileSync(gov, original.replace('| GOV-05 |', '| GOV-04 |'));
  assert.match(run(['governance', 'list']).stderr, /GOV-04 appears more than once/);
  fs.writeFileSync(gov, original);

  assert.match(run(['governance', 'add', 'x', '--severity', 'must']).stderr, /Usage/, 'stage is never defaulted');
  assert.match(run(['governance', 'add', 'x', '--severity', 'must', '--stage', 'plan', '--check', 'magic']).stderr, /unknown check "magic"/);
  run(['governance', 'add', 'Use a | b pipes', '--severity', 'should', '--stage', 'plan']);
  run(['governance', 'set', 'GOV-01', 'severity', 'retired']);
  const rules = run(['governance', 'list']).json;
  assert.equal(rules.find((r) => r.id === 'GOV-07').rule, 'Use a | b pipes');
  assert.equal(rules.find((r) => r.id === 'GOV-01').severity, 'retired');
  assert.match(fs.readFileSync(gov, 'utf8'), /## Definition of Done/, 'text around the table is kept');

  // A three-column table from an older init still parses, and the first write upgrades it.
  fs.writeFileSync(gov, '# Governance\n\n| ID | Rule | Severity |\n|----|------|----------|\n| GOV-01 | Old. | must |\n');
  assert.deepEqual(run(['governance', 'list']).json, [{ id: 'GOV-01', rule: 'Old.', severity: 'must', stage: 'plan', check: '' }]);
  run(['governance', 'add', 'New.', '--severity', 'should', '--stage', 'final']);
  assert.match(fs.readFileSync(gov, 'utf8'), /\| GOV-01 \| Old\. \| must \| plan \| - \|\n\| GOV-02 \| New\. \| should \| final \| - \|/);
});

test('cli: goals can be cancelled with a reason, are frozen while cancelled, and reopen as pending', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A']]);
  run(['state', 'move', 'G-001', 'in-progress']);

  fs.rmSync(path.join(dir, '.aisdlc/goals/cancelled'), { recursive: true }); // as in a project from before 0.3.0
  assert.match(run(['state', 'move', 'G-001', 'cancelled']).stderr, /--reason is required/);
  assert.match(run(['state', 'move', 'G-001', 'blocked', '--reason', 'x']).stderr, /only used when cancelling/);
  const cancel = run(['state', 'move', 'G-001', 'cancelled', '--reason', 'superseded by G-002']);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.deepEqual([cancel.json.from, cancel.json.to, cancel.json.reason], ['in-progress', 'cancelled', 'superseded by G-002']);
  const show = run(['goal', 'show', 'G-001']).json;
  assert.equal(show.cancel_reason, 'superseded by G-002');
  assert.match(fs.readFileSync(path.join(dir, '.aisdlc/registry-archive.md'), 'utf8'), /\| G-001 \| goal \| Feature \| cancelled \(0\/1\) \|/);

  // A cancelled goal takes no changes until it is reopened.
  for (const args of [
    ['task', 'set', 'G-001', 'T-01', 'in-progress'], ['task', 'set', 'G-001', 'T-01', 'pending'], ['task', 'new', 'G-001', 'B'],
    ['gate', 'set', 'G-001', 'challenge', 'done'], ['goal', 'set', 'G-001', 'branch', 'x'], ['adr', 'none', 'G-001', '--reason', 'x'],
    ['adr', 'new', 'Pick a DB', '--goal', 'G-001'],
  ]) assert.match(run(args).stderr, /cancelled; reopen it with `state move G-001 pending`/, args.join(' '));
  assert.match(run(['state', 'move', 'G-001', 'in-progress']).stderr, /From cancelled it can move to: pending, blocked/);
  assert.match(run(['state', 'move', 'G-001', 'blocked']).stderr, /None of G-001's tasks has started; reopen it with `state move G-001 pending`/);
  assert.equal(fs.readdirSync(path.join(dir, '.aisdlc/adr')).filter((f) => f.startsWith('ADR-')).length, 0, 'a refused adr new writes nothing');
  for (const step of ['challenge', 'adr', 'govern', 'implement']) {
    assert.match(run(['gate', 'require', 'G-001', step]).json.problems.join(), /goal is cancelled/, step);
  }
  assert.match(run(['goal', 'set', 'G-001', 'cancel_reason', 'x']).stderr, /state move <G-id> cancelled/);

  const reopen = run(['state', 'move', 'G-001', 'pending']);
  assert.equal(reopen.code, 0, reopen.stderr);
  assert.equal(run(['goal', 'show', 'G-001']).json.status, 'pending');
  assert.match(fs.readFileSync(path.join(dir, '.aisdlc/goals/pending/G-001-feature/goal.md'), 'utf8'), /\ncancel_reason:\n/);
  assert.equal(run(['gate', 'require', 'G-001', 'challenge']).code, 0);
  assert.equal(run(['goal', 'new', 'Next']).json.id, 'G-002', 'cancelled goals keep their IDs');
});

test('cli: questions-resolved fails while Risks & Unknowns lists open questions', () => {
  const { run, dir } = project();
  run(['init']);
  const goal = plannedGoal(run, dir, [['A']]);
  const file = path.join(dir, goal.file);
  const gov05 = () => run(['governance', 'checks', 'G-001']).json.find((c) => c.rule === 'GOV-05');
  assert.equal(gov05().check, 'questions-resolved');
  assert.equal(gov05().ok, true);

  edit(file, (s) => s.replace('## Risks & Unknowns\n', '## Risks & Unknowns\n\n- **Open:** Which regions ship first?\n- Open: Retry limit?\n- Vendor API may be slow.\n'));
  assert.deepEqual(gov05().problems, ['open question: Which regions ship first?', 'open question: Retry limit?']);
  edit(file, (s) => s.replace(/- \*\*Open:\*\* .*\n- Open: .*\n/, ''));
  assert.equal(gov05().ok, true, 'a plain risk is not an open question');
});

test('cli: criteria-met needs every goal and done-task criterion ticked; skipped tasks do not count', () => {
  const { run, dir } = project();
  run(['init']);
  const goal = plannedGoal(run, dir, [['A'], ['B']]);
  const g = run(['goal', 'show', 'G-001']).json;
  const met = () => run(['governance', 'checks', 'G-001', '--stage', 'final']).json.find((c) => c.rule === 'GOV-06');
  assert.deepEqual(met().problems, ['goal criterion not met: It works', 'T-01 criterion not met: It works', 'T-02 criterion not met: It works']);
  tick(path.join(dir, goal.file));
  tick(path.join(dir, g.tasks[0].file));
  // T-02 skipped: its criteria are not expected to be met. Status is set by hand here; the gated path is tested elsewhere.
  edit(path.join(dir, g.tasks[1].file), (s) => s.replace('status: pending', 'status: skipped'));
  assert.equal(met().ok, true);
});

test('cli: goal moves follow the transition table, and a started goal never goes back to pending', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A'], ['B']]);
  const move = (to, ...rest) => run(['state', 'move', 'G-001', to, ...rest]);
  assert.match(move('blocked').stderr, /G-001 is pending; it can't move to blocked\. From pending it can move to: in-progress, cancelled/);
  assert.match(move('pending').stderr, /can't move to pending/);

  // Undoing an accidental start is fine while no task has started.
  assert.equal(move('in-progress').code, 0);
  assert.equal(move('pending').code, 0);
  assert.equal(move('in-progress').code, 0);

  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  assert.match(move('pending').stderr, /can't go back to pending: T-01 already started\. Add tasks for new scope/);
  assert.equal(move('blocked').code, 0);
  assert.match(move('pending').stderr, /From blocked it can move to: in-progress, cancelled/);
  assert.match(run(['gate', 'require', 'G-001', 'challenge']).json.problems.join(), /goal is blocked; challenge only runs on pending goals/);

  // A cancelled goal whose work started reopens as blocked, and resumes through the implement gate.
  assert.equal(move('cancelled', '--reason', 'on hold').code, 0);
  assert.match(move('pending').stderr, /T-01 already started\. Reopen it with `state move G-001 blocked`/);
  assert.equal(move('blocked').code, 0);
  assert.equal(run(['goal', 'show', 'G-001']).json.status, 'blocked');
  assert.equal(move('in-progress').code, 0, 'the Cancellations log is not part of the reviewed plan');
});

test('cli: every cancellation reason is kept in the goal, through reopens', () => {
  const { run, dir } = project();
  run(['init']);
  plannedGoal(run, dir, [['A']]);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(run(['state', 'move', 'G-001', 'cancelled', '--reason', '   ']).stderr, /--reason is required/);
  run(['state', 'move', 'G-001', 'cancelled', '--reason', 'budget cut']);
  run(['state', 'move', 'G-001', 'pending']);
  const reopened = run(['goal', 'show', 'G-001']).json;
  assert.equal(reopened.cancel_reason, undefined, 'the current reason only shows while cancelled');
  assert.deepEqual(reopened.cancellations, [`${today}: cancelled while pending: budget cut`, `${today}: reopened as pending`]);

  run(['state', 'move', 'G-001', 'cancelled', '--reason', 'replaced by vendor tool']);
  const show = run(['goal', 'show', 'G-001']).json;
  assert.equal(show.cancel_reason, 'replaced by vendor tool');
  assert.equal(show.cancellations.length, 3);
  const text = fs.readFileSync(path.join(dir, show.dir, 'goal.md'), 'utf8');
  assert.match(text, /## Clarifications[\s\S]*\n## Cancellations\n\n- .*budget cut\n- .*reopened as pending\n- .*replaced by vendor tool\n$/);
});

test('cli: goal list filters by several states and rejects unknown ones', () => {
  const { run, dir } = project();
  run(['init']);
  for (const title of ['A', 'B', 'C']) run(['goal', 'new', title]);
  run(['state', 'move', 'G-002', 'cancelled', '--reason', 'not needed']);
  const ids = (status) => run(['goal', 'list', '--status', status]).json.map((g) => g.id);
  assert.deepEqual(ids('pending,in-progress,blocked'), ['G-001', 'G-003']);
  assert.deepEqual(ids('cancelled'), ['G-002']);
  assert.match(run(['goal', 'list', '--status', 'pending,done']).stderr, /Unknown status "done"/);

  // A reopened goal moves back from the archive into registry.md.
  const registry = () => fs.readFileSync(path.join(dir, '.aisdlc/registry.md'), 'utf8');
  assert.doesNotMatch(registry(), /G-002/);
  run(['state', 'move', 'G-002', 'pending']);
  assert.match(registry(), /\| G-002 \| goal \| B \| pending \|/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.aisdlc/registry-archive.md'), 'utf8'), /G-002/);
  assert.deepEqual(run(['registry', 'sync']).json, { rows: 3, archived: 0, file: '.aisdlc/registry.md', archive: '.aisdlc/registry-archive.md' });
});

const gitIn = (dir, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });

// A stand-in for the graphify CLI: the commands the workflow uses, with `update` writing a graph and counting runs.
function fakeGraphify(dir) {
  const bin = path.join(dir, 'fake-graphify');
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
  --help) printf '  update <path>   re-extract code\\n  query "<question>"  BFS\\n    --budget N  cap\\n' ;;
  --version) echo "graphify 9.9.9" ;;
  update) [ -n "$FAKE_WARN" ] && echo '  warning: 2 .sql file(s) contributed nothing to the graph because a dependency is missing' >&2
    [ -n "$FAKE_SAME" ] && echo '[graphify watch] No code-graph topology changes detected; outputs left untouched.' && exit 0
    [ -n "$FAKE_NOOP" ] && exit 0; mkdir -p graphify-out && echo '{}' > graphify-out/graph.json && echo run >> graphify-out/runs ;;
  query) [ "$2" = nothing ] && echo 'No matching nodes found.' || echo "QUERY $2 $3 $4" ;;
esac
`, { mode: 0o755 });
  return bin;
}

test('cli: registry search finds open and archived goals by keyword prefix', () => {
  const { run } = project();
  run(['init']);
  run(['goal', 'new', 'Add rate limiting to the API']);
  run(['goal', 'new', 'Export invoices']);
  run(['state', 'move', 'G-001', 'cancelled', '--reason', 'later']);
  const r = run(['registry', 'search', 'limit', 'api', 'the']).json;
  assert.deepEqual(r.terms, ['limit', 'api']);
  assert.equal(r.matches.length, 1);
  assert.match(r.matches[0], /\| G-001 \| goal \| Add rate limiting to the API \| cancelled/);
  assert.match(run(['registry', 'search', 'an']).stderr, /Usage: registry search/);
});

test('cli: goal list and show name the next step from status and gates', () => {
  const { run } = project();
  run(['init']);
  run(['goal', 'new', 'A']);
  const next = () => run(['goal', 'show', 'G-001']).json.next;
  assert.equal(next(), 'challenge');
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  assert.equal(next(), 'adr');
  run(['adr', 'none', 'G-001', '--reason', 'no decision']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);
  assert.equal(run(['goal', 'list']).json[0].next, 'govern');
  run(['state', 'move', 'G-001', 'cancelled', '--reason', 'x']);
  assert.equal(next(), 'reopen');
});

test('cli: governance review writes one row per active rule and fills in failed checks', () => {
  const { run, dir } = project();
  run(['init']);
  run(['goal', 'new', 'A']);
  const r = run(['governance', 'review', 'G-001']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.rules.map((x) => x.id), BASELINE_RULES);
  assert.deepEqual(r.json.rules[0].problems, ['goal has no Problem statement', 'goal has no acceptance criteria']);
  const text = fs.readFileSync(path.join(dir, r.json.file), 'utf8');
  assert.match(text, /\| GOV-01 \| fail \| check goal-defined: goal has no Problem statement; goal has no acceptance criteria \|/);
  assert.match(text, /\| GOV-05 \| {2}\| {2}\|/);
  assert.match(run(['governance', 'review', 'G-001']).stderr, /already exists\. Run `gate set G-001 govern pending` first/);
  assert.equal(run(['governance', 'review', 'G-001', '--stage', 'final']).json.rules[0].id, 'GOV-06');
});

test('cli: goal preflight warns before before_goal switches branches away from work', () => {
  const { run, dir } = project();
  gitIn(dir, 'init', '-q', '-b', 'develop');
  run(['init']);
  run(['goal', 'new', 'A']);
  run(['goal', 'new', 'B']);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'plan');
  assert.deepEqual(run(['goal', 'preflight', 'G-001']).json.warnings, []);

  gitIn(dir, 'checkout', '-q', '-b', 'feature/c');
  run(['goal', 'new', 'C']);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'c');
  const p = run(['goal', 'preflight', 'G-003']).json;
  assert.equal(p.switches_branch, true);
  assert.match(p.warnings.join('\n'), /committed on the current branch but not on develop/);

  run(['config', 'set', 'hooks.before_goal', 'null']);
  assert.deepEqual(run(['goal', 'preflight', 'G-003']).json, { goal: 'G-003', before_goal: [], switches_branch: false, base_branch: 'develop', other_in_progress: [], warnings: [] });
});

test('cli: graph setup, freshness and query drive graphify without the model', { skip: process.platform === 'win32' }, () => {
  const { run, dir } = project();
  gitIn(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'graphify-out/\nfake-graphify\n');
  run(['init']);
  const env = { AISDLC_GRAPHIFY: fakeGraphify(dir) };
  const runs = () => fs.readFileSync(path.join(dir, 'graphify-out/runs'), 'utf8').split('\n').filter(Boolean).length;

  // Without a graph the workflow keeps going: query tells the agent to search directly.
  assert.equal(run(['graph', 'query', 'where'], env).json.provider, 'none');
  assert.equal(run(['graph', 'status'], { AISDLC_GRAPHIFY: path.join(dir, 'missing') }).json.installed, false);
  assert.match(run(['graph', 'setup'], { AISDLC_GRAPHIFY: path.join(dir, 'missing') }).stderr, /not installed/);

  const setup = run(['graph', 'setup'], env);
  assert.equal(setup.code, 0, setup.stderr);
  assert.deepEqual([setup.json.provider, setup.json.version, setup.json.ignore_added, setup.json.updated], ['graphify', '9.9.9', true, true]);
  assert.equal(fs.readFileSync(path.join(dir, '.graphifyignore'), 'utf8'), '.aisdlc/\n');
  assert.equal(run(['config', 'get', 'graph.provider']).json, 'graphify');
  const status = run(['graph', 'status'], env).json;
  assert.deepEqual([status.supported, status.aisdlc_ignored, status.stale], [true, true, false]);

  // Workflow files and commits of code already in the graph never make it stale; code changes do.
  run(['goal', 'new', 'A']);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'all');
  assert.equal(run(['graph', 'update'], env).json.updated, false);
  fs.appendFileSync(path.join(dir, '.gitignore'), 'tmp/\n');
  assert.equal(run(['graph', 'status'], env).json.stale, false, 'a .gitignore edit is not a code change');
  fs.appendFileSync(path.join(dir, 'app.js'), 'export const b = 2;\n');
  const q = run(['graph', 'query', 'who uses a', '--budget', '400'], env);
  assert.match(q.stdout, /^\[aisdlc\] graph refreshed in \d+ ms \(code changed since the graph was built\)\nQUERY who uses a --budget 400\n$/);
  assert.equal(runs(), 2);
  assert.equal(run(['graph', 'query', 'again'], env).stdout, 'QUERY again --budget 1500\n');
  assert.match(run(['graph', 'query', 'x', '--budget', 'lots'], env).stderr, /--budget must be/);
  assert.equal(run(['graph', 'query', 'nothing'], env).stdout, 'No matching nodes found.\n[aisdlc] Nothing in the graph matches. Retry with identifiers (function, file or module names) rather than a sentence, or search the code directly.\n');

  // Setup always rebuilds, and Graphify's warnings are returned and kept for status until a build has none.
  const rebuilt = run(['graph', 'setup'], { ...env, FAKE_WARN: '1' }).json;
  assert.deepEqual([rebuilt.updated, rebuilt.reason, runs()], [true, 'rebuild requested', 3]);
  assert.match(rebuilt.warnings[0], /^2 \.sql file\(s\) contributed nothing/);
  assert.deepEqual(run(['graph', 'status'], env).json.warnings, rebuilt.warnings);
  run(['graph', 'setup'], env);
  assert.equal(run(['graph', 'status'], env).json.warnings, undefined);

  // An update that leaves the graph untouched is reported, and the graph stays stale so the next query retries.
  fs.appendFileSync(path.join(dir, 'app.js'), 'export const d = 4;\n');
  assert.match(run(['graph', 'update'], { ...env, FAKE_NOOP: '1' }).json.warning, /left graphify-out\/graph\.json unchanged/);
  assert.equal(run(['graph', 'status'], env).json.stale, true);

  // An edit that leaves the graph's topology unchanged still makes the graph current, so queries stop rebuilding.
  const same = run(['graph', 'update'], { ...env, FAKE_SAME: '1' }).json;
  assert.deepEqual([same.updated, same.warning], [true, undefined]);
  assert.equal(run(['graph', 'status'], env).json.stale, false);

  // A missing graphify never blocks the workflow.
  fs.appendFileSync(path.join(dir, 'app.js'), 'export const c = 3;\n');
  assert.match(run(['graph', 'query', 'where'], { AISDLC_GRAPHIFY: path.join(dir, 'missing') }).json.note, /Graph unavailable.*search the code directly/);

  run(['config', 'set', 'graph.path', 'docs/graph']);
  assert.match(run(['graph', 'status'], env).stderr, /graph\.path "docs\/graph" is not supported/);
});

test('cli: tasks are removed with a reason before the goal starts, edited in place, and IDs are never reused', () => {
  const { run, dir } = project();
  run(['init']);
  plannedGoal(run, dir, [['Schema'], ['API', '--depends', 'T-01'], ['Docs']]);
  const goalFile = () => path.join(dir, run(['goal', 'show', 'G-001']).json.dir, 'goal.md');

  assert.match(run(['task', 'remove', 'G-001', 'T-01']).stderr, /Usage: task remove/);
  assert.match(run(['task', 'remove', 'G-001', 'T-01', '--reason', 'x']).stderr, /T-02 depends on T-01\. Change its dependencies first/);
  const removed = run(['task', 'remove', 'G-001', 'T-03', '--reason', 'docs live elsewhere']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(run(['goal', 'show', 'G-001']).json.tasks.map((x) => x.id), ['T-01', 'T-02']);
  assert.match(fs.readFileSync(goalFile(), 'utf8'), /## Removed tasks\n\n- \d{4}-\d{2}-\d{2}: T-03 "Docs" removed: docs live elsewhere\n/);
  const added = run(['task', 'new', 'G-001', 'Tests', '--verify', 'true']).json;
  assert.equal(added.id, 'T-04', 'a removed ID is not allocated again');
  fill(path.join(dir, added.file));

  // Edits validate like `task new`, rename the file with the title, and reset governance.
  assert.match(run(['task', 'edit', 'G-001', 'T-01', 'depends', 'T-02']).stderr, /Cannot change T-01's dependencies:\n- Dependency cycle/);
  assert.match(run(['task', 'edit', 'G-001', 'T-01', 'depends', 'T-09']).stderr, /depends on unknown task T-09/);
  assert.match(run(['task', 'edit', 'G-001', 'T-01', 'risk', 'huge']).stderr, /Invalid risk "huge"/);
  assert.match(run(['task', 'edit', 'G-001', 'T-01', 'owner', 'me']).stderr, /Usage: task edit/);
  assert.deepEqual(run(['task', 'edit', 'G-001', 'T-02', 'depends', 'none']).json.depends, []);
  const renamed = run(['task', 'edit', 'G-001', 'T-02', 'title', 'Parse', 'arguments']).json;
  assert.equal(renamed.file.endsWith('tasks/T-02-parse-arguments.md'), true);
  const text = fs.readFileSync(path.join(dir, renamed.file), 'utf8');
  assert.match(text, /^title: Parse arguments$/m);
  assert.match(text, /^# T-02: Parse arguments$/m);
  assert.match(fs.readFileSync(path.join(dir, run(['goal', 'show', 'G-001']).json.dir, 'tasks.md'), 'utf8'), /\| T-02 \| Parse arguments \| medium \| - \|/);

  // Governance judged the planned fields, so an edit after it passed resets it; an edit that changes nothing does not.
  run(['task', 'edit', 'G-001', 'T-04', 'verify', 'npm test']);
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  run(['adr', 'none', 'G-001', '--reason', 'none needed']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);
  writeReview(path.dirname(goalFile()), 'G-001');
  assert.equal(run(['gate', 'set', 'G-001', 'govern', 'passed']).code, 0);
  assert.deepEqual(run(['task', 'edit', 'G-001', 'T-04', 'verify', 'npm test']).json.notes, []);
  assert.match(run(['task', 'edit', 'G-001', 'T-04', 'risk', 'high']).json.notes.join('\n'), /gate_govern reset to pending/);

  // After the goal starts, removing is refused in favor of skipping, and finished tasks don't change.
  writeReview(path.dirname(goalFile()), 'G-001');
  run(['gate', 'set', 'G-001', 'govern', 'passed']);
  run(['state', 'move', 'G-001', 'in-progress']);
  assert.match(run(['task', 'remove', 'G-001', 'T-04', '--reason', 'x']).stderr, /in-progress; tasks can only be removed before the goal starts\. Skip it instead/);
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-01']);
  run(['task', 'review', 'G-001', 'T-01', 'pass', '--evidence', 'checked']);
  run(['task', 'set', 'G-001', 'T-01', 'done']);
  assert.match(run(['task', 'edit', 'G-001', 'T-01', 'risk', 'low']).stderr, /T-01 is done; a finished task no longer changes/);
});

test('cli: gate set reports what it checked in the review, its questions and readings, and earlier rounds', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A']]);
  const goalDir = path.join(dir, run(['goal', 'show', 'G-001']).json.dir);
  const review = path.join(goalDir, 'governance-review.md');

  const pending = run(['gate', 'set', 'G-001', 'govern', 'pending']).json;
  assert.deepEqual(pending.stale_reviews, [path.relative(dir, path.join(goalDir, 'governance-review.stale-1.md'))]);
  assert.deepEqual(run(['governance', 'review', 'G-001']).json.stale_reviews, pending.stale_reviews);

  // A review whose only must failure is questions for the user: it fails, and the questions come back to the caller.
  writeReview(goalDir, 'G-001', { 'GOV-05': ['fail', 'two behaviors are open, see Questions'] }, 'fail');
  fs.appendFileSync(review, '\n## Questions for the user\n\n- Which error wins when the text is empty and the date is invalid?\n\n## Readings\n\n- The clock is injected, as the repo already does.\n');
  const failed = run(['gate', 'set', 'G-001', 'govern', 'failed']).json;
  assert.deepEqual([failed.checked, failed.warnings], [true, []]);
  assert.deepEqual(failed.questions, ['Which error wins when the text is empty and the date is invalid?']);
  assert.deepEqual(failed.readings, ['The clock is injected, as the repo already does.']);
  assert.deepEqual(run(['goal', 'show', 'G-001']).json.governance.plan.questions, failed.questions);

  // A failed verdict is still checked: an unescaped | splits a note into cells, and a pass result contradicts it.
  writeReview(goalDir, 'G-001', { 'GOV-02': ['fail', 'usage is add | list'] }, 'pass');
  const warned = run(['gate', 'set', 'G-001', 'govern', 'failed']).json;
  assert.deepEqual(warned.warnings, ['GOV-02\'s row has 4 cells instead of 3; write a literal | in a note as \\|', 'governance-review.md says `result: pass`; set it to `fail`']);
  assert.match(run(['gate', 'set', 'G-001', 'govern', 'passed']).stderr, /GOV-02's row has 4 cells/);
  writeReview(goalDir, 'G-001', { 'GOV-02': ['pass', 'usage is add \\| list'] });
  const passed = run(['gate', 'set', 'G-001', 'govern', 'passed']).json;
  assert.deepEqual([passed.checked, passed.warnings], [true, []]);
  assert.match(fs.readFileSync(review, 'utf8'), /add \\\| list/);
});

test('cli: the final review scaffold leaves criteria-met for the reviewer', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A'], ['B']]);
  run(['state', 'move', 'G-001', 'in-progress']);
  for (const id of ['T-01', 'T-02']) {
    run(['task', 'set', 'G-001', id, 'in-progress']);
    run(['task', 'verify', 'G-001', id]);
    run(['task', 'review', 'G-001', id, 'pass', '--evidence', 'checked']);
    run(['task', 'set', 'G-001', id, 'done']);
  }
  const show = run(['goal', 'show', 'G-001']).json;
  assert.equal(show.next_hint, 'Every task is done. /aisdlc:implement G-001 runs the final review, then completes the goal.');
  const r = run(['governance', 'review', 'G-001', '--stage', 'final']).json;
  assert.deepEqual(r.rules[0], { id: 'GOV-06', rule: r.rules[0].rule, severity: 'must', check: 'criteria-met', check_ok: false, to_check: '1 goal and 2 task criteria to check' });
  assert.match(fs.readFileSync(path.join(dir, r.file), 'utf8'), /\| GOV-06 \| {2}\| {2}\|/);
  assert.deepEqual(run(['goal', 'show', 'G-001']).json.governance.final.failed, []);

  tick(path.join(dir, show.dir, 'goal.md'));
  for (const t of show.tasks) tick(path.join(dir, t.file));
  writeReview(path.join(dir, show.dir), 'G-001', {}, 'pass', { rules: ['GOV-06'], file: 'governance-final.md' });
  run(['gate', 'set', 'G-001', 'final', 'passed']);
  assert.equal(run(['goal', 'show', 'G-001']).json.next_hint, 'Every task is done and the final review passed. /aisdlc:implement G-001 only completes the goal.');
});

test('cli: dag write warns when tasks in the same wave expect to change the same file', () => {
  const { run, dir } = project();
  run(['init']);
  plannedGoal(run, dir, [['Parse'], ['List'], ['Store', '--depends', 'T-01']]);
  const files = (id, text) => {
    const f = path.join(dir, run(['goal', 'show', 'G-001']).json.tasks.find((x) => x.id === id).file);
    edit(f, (s) => s.replace('## Files (expected)\n', `## Files (expected)\n\n${text}\n`));
  };
  files('T-01', '- `src/cli.mjs`: add --due\n- src/store.mjs');
  files('T-02', '- ./src/cli.mjs (print overdue)');
  files('T-03', '- `src/cli.mjs`');
  const w = run(['dag', 'write', 'G-001']).json;
  assert.deepEqual(w.warnings, ["T-01 and T-02 are in wave 1 as independent tasks, but both list src/cli.mjs under Files. Add a dependency if one has to go first, or confirm the changes don't conflict."]);
  assert.match(fs.readFileSync(path.join(dir, w.file), 'utf8'), /## Warnings\n\n- T-01 and T-02 are in wave 1/);
  run(['task', 'edit', 'G-001', 'T-02', 'depends', 'T-01']);
  assert.deepEqual(run(['dag', 'write', 'G-001']).json.warnings, ["T-02 and T-03 are in wave 2 as independent tasks, but both list src/cli.mjs under Files. Add a dependency if one has to go first, or confirm the changes don't conflict."]);
});

test('cli: task verify records a one-line summary of what ran', () => {
  const { run, dir } = project();
  run(['init']);
  run(['config', 'set', 'hooks.after_task', '{"run":"echo \'Tests:       3 passed, 3 total\'"}']);
  governedGoal(run, dir, [['A', '--verify', 'printf "# tests 2\\n# pass 2\\n# fail 0\\n"'], ['B', '--verify', 'manual: open it']]);
  run(['state', 'move', 'G-001', 'in-progress']);
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  const v = run(['task', 'verify', 'G-001', 'T-01']);
  assert.match(v.stdout, /# pass 2[\s\S]*Tests: {7}3 passed[\s\S]*verify T-01: pass/, 'output is still printed');
  const task = (id) => parseDoc(fs.readFileSync(path.join(dir, run(['goal', 'show', 'G-001']).json.tasks.find((x) => x.id === id).file), 'utf8')).data;
  assert.equal(task('T-01').verify_evidence, 'printf "# tests 2\\n# pass 2\\n# fail 0\\n": exit 0 (tests 2, pass 2, fail 0); echo \'Tests:       3 passed, 3 total\': exit 0 (Tests: 3 passed, 3 total)');
  run(['task', 'set', 'G-001', 'T-02', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-02', '--evidence', 'page loads']);
  assert.equal(task('T-02').verify_evidence, 'page loads; echo \'Tests:       3 passed, 3 total\': exit 0 (Tests: 3 passed, 3 total)');

  assert.equal(testCounts('  12 passing (40ms)\n'), '12 passing (40ms)');
  assert.equal(testCounts('==== 5 passed, 1 skipped in 0.2s ====\n'), '5 passed, 1 skipped in 0.2s');
  assert.equal(testCounts('✔ a (1ms)\nℹ tests 21\nℹ suites 0\nℹ pass 21\nℹ fail 0\nℹ file | line %\n'), 'tests 21, pass 21, fail 0');
  assert.equal(testCounts('built\n'), '');
});

test('cli: goal diff lists committed, uncommitted and untracked changes, and preflight flags an edited stack manifest', { skip: process.platform === 'win32' }, () => {
  const { run, dir } = project();
  gitIn(dir, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.js'), '1\n');
  run(['init']);
  run(['goal', 'new', 'A']);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'base');

  assert.match(run(['goal', 'diff', 'G-001']).json.warnings[0], /no branch recorded/);
  gitIn(dir, 'checkout', '-q', '-b', 'feature/a');
  run(['goal', 'set', 'G-001', 'branch', 'feature/a']);
  fs.writeFileSync(path.join(dir, 'b.js'), '2\n');
  gitIn(dir, 'add', 'b.js');
  gitIn(dir, 'commit', '-qm', 'b');
  fs.writeFileSync(path.join(dir, 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'c.js'), '3\n');
  const d = run(['goal', 'diff', 'G-001']).json;
  assert.deepEqual(d, {
    goal: 'G-001', base_branch: 'develop', branch: 'feature/a', current_branch: 'feature/a', range: 'develop...feature/a',
    committed: ['b.js'], uncommitted: ['a.js'], untracked: ['c.js'], warnings: [],
  });
  gitIn(dir, 'stash', '-q');
  gitIn(dir, 'checkout', '-q', 'develop');
  run(['goal', 'set', 'G-001', 'branch', 'feature/a']);
  const away = run(['goal', 'diff', 'G-001']).json;
  assert.deepEqual([away.committed, away.warnings], [['b.js'], ['The current branch is develop, not feature/a, so uncommitted and untracked files come from develop\'s working tree.']]);

  fs.writeFileSync(path.join(dir, '.aisdlc/stacks/nodejs.json'), '{"name":"nodejs"}\n');
  assert.match(run(['goal', 'preflight', 'G-001']).json.warnings.join('\n'), /\.aisdlc\/stacks\/nodejs\.json has uncommitted changes/);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'stack');
  assert.doesNotMatch(run(['goal', 'preflight', 'G-001']).json.warnings.join('\n'), /nodejs\.json/);
});

test('cli: a task needs a passing review after its verification before it is done', () => {
  const { run, dir } = project();
  run(['init']);
  governedGoal(run, dir, [['A', '--verify', 'true']]);
  run(['state', 'move', 'G-001', 'in-progress']);
  const file = path.join(dir, run(['goal', 'show', 'G-001']).json.tasks[0].file);
  const data = () => parseDoc(fs.readFileSync(file, 'utf8')).data;
  const stale = () => run(['gate', 'require', 'G-001', 'implement']).json.problems.join();
  const review = (...args) => run(['task', 'review', 'G-001', 'T-01', ...args]);

  assert.match(review('pass', '--evidence', 'x').stderr, /pending; only an in-progress task can be reviewed/);
  run(['task', 'set', 'G-001', 'T-01', 'in-progress']);
  assert.match(review('pass', '--evidence', 'x').stderr, /has not passed verification/, 'the review comes after verify');
  run(['task', 'verify', 'G-001', 'T-01']);
  assert.match(review('pass').stderr, /--evidence is required/);
  assert.match(review('maybe', '--evidence', 'x').stderr, /Usage: task review/);
  assert.match(run(['task', 'set', 'G-001', 'T-01', 'done']).stderr, /has not passed its review/);

  const failed = review('fail', '--evidence', 'no error test\nmissing null check');
  assert.equal(failed.code, 1);
  assert.deepEqual([data().reviewed, data().review_evidence], ['fail', 'no error test missing null check']);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'done']).code, 1, 'a failed review does not pass the gate');

  // Fixing the code means verifying again, which sends the task back to review.
  run(['task', 'verify', 'G-001', 'T-01']);
  assert.equal(data().reviewed, '');
  assert.equal(review('pass', '--evidence', 'criteria 1 met: tests/a.test.mjs:12').code, 0);
  assert.equal(data().reviewed, 'pass');

  // Every round stays in the Review section, and the plan stays governed while the agent writes there.
  edit(file, (s) => s.replace('## Work log\n', '## Work log\n\nTried the cache first; it broke the tests.\n'));
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /## Review\n+- \d{4}-\d\d-\d\d: fail: no error test missing null check\n- \d{4}-\d\d-\d\d: pass: criteria 1 met/);
  assert.equal(stale(), '');
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'done']).code, 0);
  assert.equal(data().reviewed, 'pass', 'done keeps the review');
});
