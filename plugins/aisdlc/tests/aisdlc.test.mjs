import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeDag, goalProgress, resolveHook, parseDoc, formatDoc } from '../scripts/aisdlc.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/aisdlc.mjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-'));
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    let json;
    try { json = JSON.parse(r.stdout); } catch { json = undefined; }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return { dir, run };
}

const t = (id, depends_on = [], extra = {}) => ({ id, depends_on, status: 'pending', risk: 'medium', ...extra });

const BASELINE_RULES = ['GOV-01', 'GOV-02', 'GOV-03', 'GOV-04', 'GOV-05'];

// Writes a governance review; `results` maps rule ID -> [result, notes], defaulting to pass.
function writeReview(dir, goalId, results = {}, result = 'pass') {
  const rows = BASELINE_RULES.map((id) => `| ${id} | ${(results[id] || ['pass'])[0]} | ${(results[id] || [])[1] || ''} |`);
  const text = `---\ngoal: ${goalId}\nresult: ${result}\n---\n\n| Rule | Result | Notes |\n|------|--------|-------|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(dir, 'governance-review.md'), text);
}

// Creates G-001 with the given tasks and passes every gate, so the goal is ready to implement.
function governedGoal(run, dir, tasks) {
  run(['goal', 'new', 'Feature']);
  for (const args of tasks) assert.equal(run(['task', 'new', 'G-001', ...args]).code, 0);
  run(['gate', 'set', 'G-001', 'challenge', 'done']);
  run(['adr', 'none', 'G-001', '--reason', 'no architectural change']);
  run(['gate', 'set', 'G-001', 'adr', 'done']);
  writeReview(path.join(dir, run(['goal', 'show', 'G-001']).json.dir), 'G-001');
  assert.equal(run(['gate', 'set', 'G-001', 'govern', 'passed']).code, 0);
}

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

test('cli: full gated flow from init to completed', () => {
  const { dir, run } = project();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');

  const init = run(['init']);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(init.json.detected_stacks, ['nodejs']);
  for (const s of ['pending', 'in-progress', 'blocked', 'completed']) assert.ok(fs.existsSync(path.join(dir, '.aisdlc/goals', s)));
  assert.equal(run(['init']).json.created.length, 0, 'init is idempotent');

  assert.equal(run(['goal', 'new', 'User', 'login']).json.id, 'G-001');
  assert.equal(run(['task', 'new', 'G-001', 'Schema', '--risk', 'high', '--verify', 'true']).json.id, 'T-01');
  assert.equal(run(['task', 'new', 'G-001', 'API', '--depends', 'T-01']).json.id, 'T-02');
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
  assert.ok(fs.existsSync(path.join(goalDir, 'governance-review.stale.md')));
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
  run(['task', 'set', 'G-001', 'T-01', 'done']);
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 1, 'cannot complete with open tasks');
  run(['task', 'set', 'G-001', 'T-02', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-02']);
  const last = run(['task', 'set', 'G-001', 'T-02', 'done']);
  assert.equal(last.json.progress.complete, true);
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 0);
  assert.equal(run(['task', 'set', 'G-001', 'T-01', 'pending']).code, 1, 'completed goals are frozen');

  const registry = fs.readFileSync(path.join(dir, '.aisdlc/registry.md'), 'utf8');
  assert.match(registry, /\| G-001 \| goal \| User login \| completed \(2\/2\) \| goals\/completed\/G-001-user-login\/goal.md \| adr: none \|/);
});

test('cli: adr new links both directions', () => {
  const { run, dir } = project();
  run(['init']);
  run(['goal', 'new', 'Billing']);
  assert.equal(run(['adr', 'new', 'Use', 'Stripe', '--goal', 'G-001']).json.id, 'ADR-001');
  assert.deepEqual(run(['goal', 'show', 'G-001']).json.adrs, ['ADR-001']);
  assert.match(fs.readFileSync(path.join(dir, '.aisdlc/registry.md'), 'utf8'), /\| ADR-001 \| adr \| Use Stripe \| proposed \|.*\| G-001 \|/);
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
  writeReview(goalDir, 'G-002');
  assert.match(pass().stderr, /review is for G-002/);

  // New rules must be reviewed; retired and failed `should` rules do not block.
  const gov = path.join(dir, '.aisdlc/governance.md');
  fs.writeFileSync(gov, fs.readFileSync(gov, 'utf8').replace('| must |\n\n', '| must |\n| GOV-06 | Has docs. | should |\n| GOV-07 | Old rule. | retired |\n\n'));
  writeReview(goalDir, 'G-001');
  assert.match(pass().stderr, /GOV-06 is missing/);
  fs.appendFileSync(path.join(goalDir, 'governance-review.md'), '| GOV-06 | fail | no README section |\n');
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
