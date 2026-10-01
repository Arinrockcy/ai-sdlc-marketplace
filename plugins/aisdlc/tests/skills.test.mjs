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
  // T-02 depends on T-01, so `task remove … T-01` is refused and later invocations still find T-01.
  for (const args of [['init'], ['goal', 'new', 'Sample'], ['task', 'new', 'G-001', 'Sample', '--verify', 'true'], ['task', 'new', 'G-001', 'Next', '--depends', 'T-01'], ['adr', 'new', 'Sample', '--goal', 'G-001']]) {
    assert.equal(run(args).status, 0);
  }
  return run;
}

// Agents other than Claude Code (GitHub Copilot) parse frontmatter as strict YAML and follow the Agent Skills spec.
// A plain scalar can't hold ": " or " #", or start with an indicator character; quote such values.
function frontmatterProblems(file) {
  const text = fs.readFileSync(file, 'utf8');
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  if (block === undefined) return ['no frontmatter'];
  const problems = [];
  const fields = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-z-]+): (.*)$/);
    if (!m) { problems.push(`not a "key: value" line: ${line}`); continue; }
    let value = m[2];
    if (/^".*"$/.test(value)) value = JSON.parse(value);
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replaceAll("''", "'");
    else if (/: | #|^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) problems.push(`${m[1]} needs quotes in strict YAML`);
    fields[m[1]] = value;
  }
  const folder = path.basename(path.dirname(file));
  if (fields.name !== folder) problems.push(`name "${fields.name}" doesn't match its folder "${folder}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name ?? '') || fields.name.length > 64) problems.push(`name "${fields.name}" isn't 1-64 lowercase letters, digits and single hyphens`);
  if (!fields.description || fields.description.length > 1024) problems.push('description is missing or longer than 1024 characters');
  return problems;
}

test('skills: frontmatter parses as strict YAML and follows the Agent Skills spec', () => {
  const bad = skillFiles().flatMap((f) => frontmatterProblems(f).map((p) => `${path.relative(REPO, f)}: ${p}`));
  assert.deepEqual(bad, []);
});

// Claude Code expands `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` in skill text and namespaces skills as `/plugin:skill`.
// GitHub Copilot does neither, so a skill that relies on one says what it stands for.
test('skills: explain Claude Code variables and skill names for agents that leave them as written', () => {
  const missing = [];
  for (const file of skillFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file);
    if (text.includes('${CLAUDE_PLUGIN_ROOT}') && !text.includes('still starts with an unexpanded variable, that variable stands for this plugin\'s folder: two levels above the folder that holds this SKILL.md')) missing.push(`${rel}: \${CLAUDE_PLUGIN_ROOT}`);
    if (text.includes('$ARGUMENTS') && !text.includes('(the text after the skill\'s name)') && !text.includes('after the skill\'s name: `$ARGUMENTS`')) missing.push(`${rel}: $ARGUMENTS`);
    if (/\/aisdlc(-[a-z]+)?:[a-z]/.test(text) && !text.includes('in an agent without plugin namespaces, such as GitHub Copilot, call them `/<skill>`')) missing.push(`${rel}: /plugin:skill names`);
  }
  assert.deepEqual(missing, []);
});

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
