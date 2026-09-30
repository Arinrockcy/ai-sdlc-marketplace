// Every `$AISDLC …` invocation written in a skill must still parse: the command, action, gate, step,
// hook point, status and options it uses exist. Skills only reach the script through these lines,
// so drift here breaks a workflow at the moment a user hits it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_POINTS } from '../scripts/aisdlc.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO, 'plugins/aisdlc/scripts/aisdlc.mjs');

// Messages the script uses when it does not understand a command, as opposed to refusing it because of state.
const NOT_UNDERSTOOD = /Usage:|Unknown |Invalid |needs a value/;

// Values for placeholders. `<name>` placeholders are keyed by name; `…` after an option by the option.
const PLACEHOLDERS = { 'G-id': 'G-001', 'T-id': 'T-01', 'ADR-id': 'ADR-001', 'GOV-id': 'GOV-01', keywords: 'rate limiting' };
const OPTION_SAMPLES = { risk: 'medium', depends: 'T-01', verify: 'true', stage: 'plan', severity: 'must' };

function skillFiles() {
  const plugins = path.join(REPO, 'plugins');
  return fs.readdirSync(plugins).flatMap((p) => {
    const dir = path.join(plugins, p, 'skills');
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((s) => path.join(dir, s, 'SKILL.md')).filter(fs.existsSync) : [];
  });
}

// Inline `$AISDLC …` spans and `$AISDLC …` lines in code blocks.
function invocations(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/\$AISDLC ([^`\n]+)/g)].map((m) => ({ file: path.relative(REPO, file), text: m[1].trim() }));
}

// Turns a documented invocation into concrete argument lists: placeholders filled, optional [..] parts dropped,
// and each `a|b` alternative expanded.
export function expand(text) {
  const filled = text.replace(/\[[^\]]*\]/g, '').replace(/<([^>]+)>/g, (_, name) => PLACEHOLDERS[name] ?? 'x');
  const tokens = [...filled.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => ({ value: m[1] ?? m[2], quoted: m[1] !== undefined }));
  let variants = [[]];
  tokens.forEach((t, i) => {
    let options = [t.value];
    if (t.value === '…') {
      const prev = tokens[i - 1]?.value;
      if (!prev?.startsWith('--')) throw new Error(`"${text}": "…" can only stand for an option's value; write the full invocation`);
      options = [OPTION_SAMPLES[prev.slice(2)] ?? 'x'];
    } else if (!t.quoted && t.value.includes('|')) options = t.value.split('|');
    variants = variants.flatMap((v) => options.map((o) => [...v, o]));
  });
  return variants;
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisdlc-skills-'));
  // Hooks are disabled: this test is about arguments, not about what the hooks run.
  // Graphify is pointed at a missing binary, so `graph` commands never run a real one installed on this machine.
  const env = { ...process.env, AISDLC_GRAPHIFY: path.join(dir, 'no-graphify'), ...Object.fromEntries(HOOK_POINTS.map((p) => [`AISDLC_HOOK_${p.toUpperCase()}`, 'none'])) };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env });
  for (const args of [['init'], ['goal', 'new', 'Sample'], ['task', 'new', 'G-001', 'Sample', '--verify', 'true'], ['adr', 'new', 'Sample', '--goal', 'G-001']]) {
    assert.equal(run(args).status, 0);
  }
  return run;
}

test('skills: placeholder expansion', () => {
  assert.deepEqual(expand('task set <G-id> <T-id> skipped --reason "<why>"'), [['task', 'set', 'G-001', 'T-01', 'skipped', '--reason', 'x']]);
  assert.deepEqual(expand('goal set <G-id> auto_commit true|false'), [['goal', 'set', 'G-001', 'auto_commit', 'true'], ['goal', 'set', 'G-001', 'auto_commit', 'false']]);
  assert.deepEqual(expand('governance checks <G-id> [--stage plan|final]'), [['governance', 'checks', 'G-001']]);
  assert.deepEqual(expand('task new <G-id> "<title>" --risk … --verify "…"'), [['task', 'new', 'G-001', 'x', '--risk', 'medium', '--verify', 'true']]);
  assert.throws(() => expand('task new …'), /full invocation/);
});

test('skills: every $AISDLC invocation in a skill is understood by the script', () => {
  const found = skillFiles().flatMap(invocations);
  assert.ok(found.length > 50, `expected the skills to call the script often, found ${found.length}`);
  const run = project();
  const broken = [];
  for (const inv of found) {
    for (const args of expand(inv.text)) {
      const r = run(args);
      if (r.status !== 0 && NOT_UNDERSTOOD.test(r.stderr)) broken.push(`${inv.file}: $AISDLC ${args.join(' ')}\n    ${r.stderr.trim().split('\n')[0]}`);
    }
  }
  assert.deepEqual(broken, [], `skills call the script in ways it no longer understands:\n${broken.join('\n')}`);
});
