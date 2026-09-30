// Measures what the aisdlc workflow costs as a project grows: the files skills read and the output of the
// commands they run, in bytes and approximate tokens (bytes / 4), plus how long a state change takes.
// Usage: node scripts/bench.mjs [goal counts, default 10,100,500]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/aisdlc/scripts/aisdlc.mjs');
const TASKS_PER_GOAL = 6;
const ADR_EVERY = 3; // one ADR per this many goals
const sizes = (process.argv[2] || '10,100,500').split(',').map(Number);
if (sizes.some((n) => !Number.isInteger(n) || n < 1)) {
  console.error('Usage: node scripts/bench.mjs [goal counts, e.g. 10,100,500]');
  process.exit(1);
}

function run(dir, args) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`aisdlc ${args.join(' ')} failed: ${r.stderr}`);
  return { out: r.stdout, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

// One real goal with tasks and an ADR, then copies of it as finished goals: the shape of a project that has
// been using the workflow for a while, built without running the whole gated flow for every goal.
function buildProject(goals) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-bench-'));
  run(dir, ['init']);
  run(dir, ['goal', 'new', 'Add rate limiting to the public REST API endpoints']);
  for (let i = 1; i <= TASKS_PER_GOAL; i++) run(dir, ['task', 'new', 'G-001', `Implement token bucket middleware part ${i}`, '--risk', 'medium', '--verify', 'npm test']);
  run(dir, ['adr', 'new', 'Use Redis for distributed rate limit counters', '--goal', 'G-001']);

  const base = path.join(dir, '.aisdlc');
  const src = path.join(base, 'goals/pending', fs.readdirSync(path.join(base, 'goals/pending')).find((f) => f.startsWith('G-001')));
  const adrDir = path.join(base, 'adr');
  const adrSrc = fs.readFileSync(path.join(adrDir, fs.readdirSync(adrDir).find((f) => f.startsWith('ADR-001'))), 'utf8');
  for (let n = 2; n <= goals; n++) {
    const id = `G-${String(n).padStart(3, '0')}`;
    const dest = path.join(base, 'goals/completed', `${id}-add-rate-limiting`);
    fs.cpSync(src, dest, { recursive: true });
    const goalFile = path.join(dest, 'goal.md');
    fs.writeFileSync(goalFile, fs.readFileSync(goalFile, 'utf8').replace(/^id: G-001$/m, `id: ${id}`));
    if (n % ADR_EVERY === 0) {
      const adr = `ADR-${String(n / ADR_EVERY + 1).padStart(3, '0')}`;
      fs.writeFileSync(path.join(adrDir, `${adr}-redis.md`), adrSrc.replace(/^id: ADR-001$/m, `id: ${adr}`));
    }
  }
  run(dir, ['registry', 'sync']);
  return dir;
}

const size = (s) => Buffer.byteLength(s);
const tok = (bytes) => `~${Math.round(bytes / 4).toLocaleString('en-US')}`;
const read = (dir, f) => fs.readFileSync(path.join(dir, '.aisdlc', f), 'utf8');

const rows = [];
for (const goals of sizes) {
  const dir = buildProject(goals);
  const taskNew = run(dir, ['task', 'new', 'G-001', 'Extra task', '--risk', 'low', '--verify', 'npm test']);
  rows.push({
    goals,
    adrs: fs.readdirSync(path.join(dir, '.aisdlc/adr')).filter((f) => f.endsWith('.md')).length,
    'registry.md': size(read(dir, 'registry.md')),
    'archive (searched)': size(read(dir, 'registry-archive.md')),
    'goal list (all)': size(run(dir, ['goal', 'list']).out),
    'goal list (open)': size(run(dir, ['goal', 'list', '--status', 'pending,in-progress,blocked']).out),
    'registry search': size(run(dir, ['registry', 'search', 'rate', 'limiting']).out),
    'goal show': size(run(dir, ['goal', 'show', 'G-001']).out),
    'governance review': size(run(dir, ['governance', 'review', 'G-001']).out),
    'task new': size(taskNew.out),
    'task new ms': Math.round(taskNew.ms),
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Tokens per measure; create-goal's up-front cost is registry.md plus the open goal list plus a search.
const measures = Object.keys(rows[0]).filter((k) => !['goals', 'adrs', 'task new ms'].includes(k));
console.log(`Approximate tokens (bytes / 4). ${TASKS_PER_GOAL} tasks per goal, one ADR per ${ADR_EVERY} goals.\n`);
console.log(['measure', ...rows.map((r) => `${r.goals} goals / ${r.adrs} ADRs`)].join(' | '));
for (const m of measures) console.log([m, ...rows.map((r) => tok(r[m]))].join(' | '));
console.log(['create-goal up front', ...rows.map((r) => tok(r['registry.md'] + r['goal list (open)'] + r['registry search']))].join(' | '));
console.log(['task new time', ...rows.map((r) => `${r['task new ms']} ms`)].join(' | '));
