// Measures what the aisdlc workflow costs as a project grows: the files skills read and the output of the
// commands they run, in bytes and approximate tokens (bytes / 4), plus how long a state change takes.
// Usage: node scripts/bench.mjs [goal counts, default 10,100,500] [--docs <documentation line counts, default 1000,10000,100000>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/aisdlc/scripts/aisdlc.mjs');
const TASKS_PER_GOAL = 6;
const ADR_EVERY = 3; // one ADR per this many goals
const args = process.argv.slice(2);
const flag = args.indexOf('--docs');
const docsArg = flag < 0 ? undefined : args.splice(flag, 2)[1];
const sizes = (args[0] || '10,100,500').split(',').map(Number);
const docSizes = (docsArg || '1000,10000,100000').split(',').map(Number);
if (args.length > 1 || [...sizes, ...docSizes].some((n) => !Number.isInteger(n) || n < 1)) {
  console.error('Usage: node scripts/bench.mjs [goal counts, e.g. 10,100,500] [--docs <documentation line counts, e.g. 1000,10000,100000>]');
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

// ---------- documentation index ----------

// A corpus of Markdown with `lines` lines: files of about 200 lines, a heading every ~12 lines, words drawn from a
// fixed pseudo-random vocabulary so the run is repeatable. About one section in forty is about "retention policy",
// the query below; the rest are other topics, so a search has to pick a few sections out of many.
const LINES_PER_FILE = 200;
const SECTION_LINES = 12;
const VOCAB = Array.from({ length: 3000 }, (_, i) => `w${(i * 2654435761 % 4294967296).toString(36)}`);
function buildDocs(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-bench-docs-'));
  run(dir, ['init']);
  let seed = 12345;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let written = 0;
  let file = 0;
  while (written < lines) {
    const out = [];
    while (out.length < LINES_PER_FILE && written + out.length < lines) {
      const n = out.length;
      if (n % SECTION_LINES === 0) out.push(`${n === 0 ? '#' : '##'} ${next(40) === 0 ? 'Retention policy' : `Topic ${VOCAB[next(VOCAB.length)]}`} ${file}.${n}`);
      else out.push(Array.from({ length: 12 }, () => VOCAB[next(VOCAB.length)]).join(' ') + (next(80) === 0 ? ' retention' : ''));
    }
    const sub = path.join(dir, 'docs', `area${file % 20}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `note${file}.md`), out.join('\n') + '\n');
    written += out.length;
    file += 1;
  }
  run(dir, ['docs', 'paths', 'docs']);
  return { dir, files: file };
}

const docRows = [];
for (const lines of docSizes) {
  const { dir, files } = buildDocs(lines);
  const build = run(dir, ['docs', 'sync']);
  const built = JSON.parse(build.out);
  const search = run(dir, ['docs', 'search', 'retention', 'policy']);
  const found = JSON.parse(search.out);
  const again = run(dir, ['docs', 'search', 'retention', 'policy']);
  fs.appendFileSync(path.join(dir, 'docs/area0/note0.md'), 'one more line about retention\n');
  const refresh = run(dir, ['docs', 'search', 'retention', 'policy']);
  let corpus = 0;
  for (const f of fs.readdirSync(path.join(dir, 'docs'), { recursive: true })) if (f.endsWith('.md')) corpus += size(fs.readFileSync(path.join(dir, 'docs', f), 'utf8'));
  docRows.push({
    lines, files, sections: built.sections, corpus, indexBytes: size(fs.readFileSync(path.join(dir, '.aisdlc/cache/docs-index.json'), 'utf8')),
    buildMs: Math.round(build.ms), searchMs: Math.round(again.ms), refreshMs: Math.round(refresh.ms),
    printed: size(search.out), matches: found.matches.length, more: found.more,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nDocumentation index. ${LINES_PER_FILE} lines per file, a heading every ~${SECTION_LINES} lines; the search is "retention policy" at the default budget.\n`);
console.log(['measure', ...docRows.map((r) => `${r.lines.toLocaleString('en-US')} lines`)].join(' | '));
const show = (label, f) => console.log([label, ...docRows.map(f)].join(' | '));
show('files / sections', (r) => `${r.files} / ${r.sections}`);
show('corpus (tokens)', (r) => tok(r.corpus));
show('index file (tokens, never read)', (r) => tok(r.indexBytes));
show('docs sync, first build', (r) => `${r.buildMs} ms`);
show('docs search, index fresh', (r) => `${r.searchMs} ms`);
show('docs search after one edit', (r) => `${r.refreshMs} ms`);
show('search output (tokens)', (r) => tok(r.printed));
show('matches printed / more', (r) => `${r.matches} / ${r.more}`);
show('search output vs corpus', (r) => `${((r.printed / r.corpus) * 100).toFixed(2)}%`);
const BUDGET = 1500;
const over = docRows.filter((r) => r.printed / 4 > BUDGET);
if (over.length) {
  console.error(`\nA search printed more than the default budget of ${BUDGET} tokens at ${over.map((r) => r.lines).join(', ')} lines.`);
  process.exitCode = 1;
}
