// What each skill must keep telling the agent. A model's behavior can't be run here, but the instructions that
// produce it can drift: a rewrite that drops "never assume", or goes back to editing state by hand, passes every
// other test. Each contract names the skill, what it has to say (or must not say) and the rule it protects.
// This tests the wording, not the agent; `claude plugin eval` is the place for runs against a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills');
const read = (name) => fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');

// [skill, pattern the text must match, the rule it protects]
const MUST = [
  ['challenge', /\$AISDLC question add <G-id>/, 'challenge records questions with question add'],
  ['challenge', /\$AISDLC question resolve <G-id> <Q-id>/, 'challenge closes open questions with question resolve'],
  ['challenge', /one question at a time/i, 'challenge asks one question at a time'],
  ['challenge', /Only the user's answer resolves it/, 'only the user\'s answer resolves a question'],
  ['challenge', /never write the `- \*\*Open:\*\*` line by hand/, 'challenge never hand-writes Open lines'],
  ['create-goal', /\$AISDLC question add <G-id> "<question>" --answer "<the user's answer>" --by user/, 'intake answers are recorded as the user\'s'],
  ['create-goal', /Do \*\*not\*\* guess answers/, 'create-goal does not guess answers'],
  ['create-goal', /Never pick for the user/, 'create-goal never picks between merge, finish and separate'],
  ['create-goal', /\$AISDLC goal overlap/, 'create-goal checks overlap with unfinished goals'],
  ['govern', /\*\*Never assume\.\*\*/, 'the reviewer never assumes'],
  ['govern', /## Questions for the user/, 'gaps become questions for the user'],
  ['govern', /Recommended: /, 'the reviewer gives a recommendation with each question'],
  ['govern', /recommendation is advice, never the answer/, 'a recommendation is not an answer'],
  ['govern', /fresh eyes/i, 'the review runs in a sub-agent or fresh session'],
  ['govern', /\$AISDLC question add <G-id> "<question>" --answer "<the user's answer>" --by user/, 'govern records answers as the user\'s'],
  ['govern', /\$AISDLC goal overlap <G-id>/, 'govern checks overlap'],
  ...['create-goal', 'challenge', 'adr', 'implement', 'govern'].flatMap((skill) => [
    [skill, /\$AISDLC docs search <keywords>/, 'documentation is searched before it is read'],
    [skill, /never read the index in `\.aisdlc\/cache\/`/i, 'the documentation index is never read whole'],
  ]),
  ['init', /\$AISDLC docs paths <path>\.\.\./, 'init sets the documentation paths through the script'],
  ['init', /Never set `docs\.paths` without an answer/, 'init asks before it sets docs.paths'],
  ['implement', /\$AISDLC task review <G-id> <T-id> pass --evidence/, 'implement records a passing code review with evidence'],
  ['implement', /\$AISDLC task review <G-id> <T-id> fail --evidence/, 'implement records a failing code review with evidence'],
  ['implement', /\$AISDLC task verify <G-id> <T-id>/, 'implement records verification'],
  ['implement', /Stuck\./, 'implement asks to re-govern when a review repeats its defects'],
  ['implement', /sub-agent/, 'the reviewer runs as a sub-agent where the agent has them'],
];

// [skill or '*', pattern that must NOT match, why]
const MUST_NOT = [
  ['*', /--answer\s+"[^"]*"(?!\s+--by user)/, 'a recorded answer is attested with --by user'],
  ['*', /\bedit (?:the )?(?:status|gate_\w+)\b/i, 'script-owned fields are changed through the script'],
  ['*', /\bset (?:the )?`?(?:status|gate_\w+)`? (?:field )?(?:to|in)\b/i, 'script-owned fields are changed through the script'],
  ['*', /waiv(?:e|er)/i, 'there is no governance waiver'],
];

test('skill contracts: each skill keeps the instructions its rule depends on', () => {
  for (const [skill, pattern, why] of MUST) {
    assert.match(read(skill), pattern, `${skill}: ${why}`);
  }
});

test('skill contracts: no skill tells the agent to do what the workflow forbids', () => {
  for (const [skill, pattern, why] of MUST_NOT) {
    const names = skill === '*' ? fs.readdirSync(SKILLS) : [skill];
    for (const name of names) {
      const hit = read(name).split('\n').find((line) => pattern.test(line) && !/there is no|no governance waiver|never|not\b/i.test(line));
      assert.equal(hit, undefined, `${name}: ${why}: ${hit}`);
    }
  }
});

test('skill contracts: the question tool is how answers get collected, never the model\'s own text', () => {
  for (const name of ['challenge', 'govern', 'create-goal']) {
    assert.match(read(name), /structured question tool|Ask the user/i, `${name} asks the user`);
  }
});
