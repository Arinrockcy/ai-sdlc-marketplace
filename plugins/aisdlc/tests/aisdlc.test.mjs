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
  for (const s of ['pending', 'in-progress', 'blocked', 'completed', 'cancelled']) assert.ok(fs.existsSync(path.join(dir, '.aisdlc/goals', s)));
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
  run(['task', 'set', 'G-001', 'T-01', 'done']);
  assert.equal(run(['state', 'move', 'G-001', 'completed']).code, 1, 'cannot complete with open tasks');
  run(['task', 'set', 'G-001', 'T-02', 'in-progress']);
  run(['task', 'verify', 'G-001', 'T-02']);
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
  assert.match(fs.readFileSync(path.join(dir, '.aisdlc/registry.md'), 'utf8'), /\| G-001 \| goal \| Feature \| cancelled \(0\/1\) \| goals\/cancelled\//);

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
