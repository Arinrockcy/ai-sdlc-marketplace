# Goal: ship the `goal` plugin 0.1.0 in aisdlc-marketplace

- **Slug:** `goal-plugin`
- **Status:** in-progress
- **Requested:** 2026-10-03, source: user request to package an existing goal workflow from another project as a plugin
- **Branch:** `goal-plugin`, off `master` at `502c390`; the workflow's agents never push, the user may
- **Plan approved by user:** 2026-10-04
- **Orchestrated from:** a session in the source project; every changed file is in this repo

## Goal

This marketplace gains a third plugin, `goal` 0.1.0: a generic port of
an existing project-specific goal workflow for Claude Code and GitHub Copilot. It ships the
skill `goal-workflow` with its ledger template, the skill `start`, four role
agents (`planner`, `governor`, `implementer`, `reviewer`), and a SessionStart
triage hook. The source project's own rules become "the project's instructions" and
its commands become the project's own, recorded per goal.

Done means `npm test` and `npm run validate` pass with the plugin included, it
loads with `--plugin-dir`, installs from the local marketplace in Claude Code,
and is hand-checked in Copilot CLI once the user has installed it.

Out of scope: any change to the source project; any change to `aisdlc` or
`aisdlc-nodejs` behaviour or versions; a per-repo config file; Codex or Cursor
adapters; `DEPENDENCY_GUARDIAN_PLAN.md`; pushing; tagging.

## Source material

The source project's goal workflow: its canonical skill, four role agents,
ledger template, and the task-workflow section of its instructions. The
orchestrator passes their location to each agent; it is not recorded here.

## Project commands

Confirmed by the user 2026-10-03.

- **Test:** `npm test`
- **Project validation:** `npm run validate` (includes `plugins/goal` from sub-task 1)
- **Lint:** none
- **Build:** none
- **Browser check:** none; no sub-task changes a screen

## Test baseline

Recorded on `6481535`, one commit before the branch point (`502c390` adds only this ledger's first draft): `npm test` exits 0 with 83 tests, 81 pass, 0 fail, 2
skipped (both in `plugins/aisdlc-nodejs/tests/eslint-template.test.mjs`, which
need `AISDLC_ESLINT`). `npm run validate` exits 0 for the marketplace and both
plugins. No failing test files.

## Behaviour of the generic plugin (decided)

- Triage on every task: recommend simple or complex with a reason, user chooses.
- Never assume; every question and decision goes to the user with options.
- Govern: plan approval gate, rules check per sub-task before and after, scope
  and order control, ledger.
- Ledger at `.agent-goals/<slug>.md` in the project, committed.
- At plan approval the plugin asks once per goal, and records in the ledger:
  auto-commit per sub-task or ask before each commit; auto-fix up to 2 rounds
  or ask after every review.
- Commit gate: reviewer safe to commit, governor compliant, tests no worse than
  baseline, the project's lint, build and any project-specific validation, and
  a browser check for screen changes (ask when it cannot run). A command the
  project lacks is recorded as "none" at approval.
- A background agent finishes what it can and returns its questions.
- Work owned by another repo or owner is reported as a question, never done or
  dropped silently, following the project's hand-off rules if it has any.
- When a sub-task finishes, a "Task detail" section is appended to the source
  task document it came from, when one exists: done and not done, files
  changed and decisions, review and verification, commit and follow-ups.
- At plan approval the plugin also asks whether to work on a new branch or the
  current one, and confirms the project commands the planner found.
- Commits follow the project's message style and the host's attribution.
- The workflow never pushes on its own; it pushes when the user explicitly asks.
- Clear-context check: whenever the next thing to start does not need the
  current session's context, the orchestrator makes sure the ledger is up to
  date, says so, and stops until the user clears the session or says to
  continue. It runs before a new goal or unrelated task, after plan approval,
  between sub-tasks, and when the goal closes. Role agents are spawned fresh
  for each sub-task and resumed only within it.

## Sub-tasks

Run strictly in this order, one at a time. Every sub-task's acceptance also
includes: `npm test` exits 0 with at least 81 passing and 0 failing;
`npm run validate` exits 0 and prints no warnings; `git status --short` shows
only that sub-task's files. Each sub-task adds its line to
`plugins/goal/CHANGELOG.md` and grows `plugins/goal/tests/goal.test.mjs` with
the checks for what it adds.

The source-term search used below is: case-sensitive `FLEX`, and
case-insensitive `vitest`, `eslint`, `validate:components`,
`PROJECT_INSTRUCTIONS`, `.agents/`, `.ai/` as a path (not a web address on
an `.ai` domain), `agent-contract`, `Codex`,
`/usr/local/bin`, over `plugins/goal` excluding `plugins/goal/tests/`.

Role agents do not see a skill's folder (AGENTS.md line 13). Agents are
self-contained, and the orchestrator passes each one the ledger path, the
project commands, the decisions, and the template text it needs.

### 1. Scaffold `goal` 0.1.0, register it, and widen the preamble test

- **Status:** done
- **Scope:** Plugin manifest (`name`, `version` 0.1.0, `description`, `author {name: "arin"}`); changelog head in the repo's format; marketplace entry (`source` `./plugins/goal`, `category` `development`) and an updated top-level marketplace description that mentions goal, in both marketplace copies; `validate` script gains `claude plugin validate plugins/goal`; the skill preamble test widened to every marketplace plugin name, with the two original aisdlc-family patterns kept alongside the new marketplace-derived rule so no aisdlc check weakens; the new rule treats `<plugin>:<name>` as a skill reference only when `<name>` is a skill folder of that plugin, so agent names such as `goal:planner` are not held to the skill phrase; a `goal.test.mjs` skeleton. No `aisdlc` version bump, since no aisdlc behaviour changes.
- **Source document:** none
- **Areas:** `plugins/goal/.claude-plugin/plugin.json`, `plugins/goal/CHANGELOG.md`, `plugins/goal/tests/goal.test.mjs`, `.claude-plugin/marketplace.json`, `.github/plugin/marketplace.json`, `package.json`, `plugins/aisdlc/tests/skills.test.mjs`, this ledger
- **Changes a screen:** no
- **Depends on:** none
- **Acceptance:** the two marketplace files are identical; the release tests pass with three plugins; `package.json` `validate` includes `plugins/goal`; the widened test still passes for every aisdlc skill and fails on a scratch skill that uses `/goal:<skill>` without the preamble
- **Governor notes:** release.test.mjs:10-23; skills.test.mjs:101-110; AGENTS.md lines 29-33. A manifest-only plugin validates (checked by the governor).
- **Review:** safe to commit, no fix rounds. Two minor findings, neither against the spec: placeholder forms such as `/goal:<skill>` are not matched by the marketplace rule (open question below); a non-string marketplace `source` would throw, as it already does in the release test. Governor: compliant once this ledger was corrected.
- **Verification:** `npm test` exits 0: 86 tests, 84 pass, 0 fail, 2 skipped (baseline 81 pass). `npm run validate` exits 0 with no warnings for the marketplace and all three plugins. The two marketplace files are identical. In a scratch copy, a skill using `/goal:<skill>` without the preamble fails the widened test, agent names pass, and mutations of version, changelog head, marketplace copy and entry each fail a test. Not verified: install-time behaviour, which sub-task 8 covers.
- **Commit:** `8ca3e78`
- **Task detail:** Done: manifest, changelog head `## [0.1.0] - 2026-10-04`, marketplace entry and top-level description in both copies, `validate` script, widened preamble test, three-test `goal.test.mjs` that compares the changelog head with the manifest instead of pinning the version. Not done: nothing in scope. Files: `plugins/goal/.claude-plugin/plugin.json`, `plugins/goal/CHANGELOG.md`, `plugins/goal/tests/goal.test.mjs`, `.claude-plugin/marketplace.json`, `.github/plugin/marketplace.json`, `package.json`, `plugins/aisdlc/tests/skills.test.mjs`. Decisions: see the 2026-10-04 rows for sub-task 1 in the decision log.

### 2. Skill `goal-workflow` and ledger template

- **Status:** done
- **Scope:** Generic port of the canonical skill with the decided behaviour above, the repo's preamble sentences, agent-neutral wording with Claude detail as an aside (clearing the session, the structured question tool, background agents, resuming an agent), generalised triage criteria, the neutral fallback that hands a generic sub-agent the role file at the plugin root's `agents/` folder, and one sentence saying it is separate from `.aisdlc/`. Ledger template next to SKILL.md with Project commands, Source document, Task detail, branch, and the per-goal commit and fix-loop choices.
- **Source document:** none
- **Areas:** `plugins/goal/skills/goal-workflow/SKILL.md`, `plugins/goal/skills/goal-workflow/ledger-template.md`, `plugins/goal/tests/goal.test.mjs`
- **Changes a screen:** no
- **Depends on:** 1
- **Acceptance:** the skills tests pass, including the widened preamble test; the source-term search finds nothing; tests check the template exists where the skill names it and the term search stays empty; by reading, all of these are present: steps 0-4, resuming, statuses, the standing rules (never assume, ask with options, record every answer, only the user changes scope, never push), and the gate conditions (reviewer verdict, governor verdict, tests against baseline, lint, build, project validation, browser check with ask-when-it-cannot-run)
- **Governor notes:** AGENTS.md lines 11, 13, 14; skills.test.mjs:70-110.
- **Review:** safe to commit after two fix rounds. Round 1 fixed a dropped predecessor blocking the next sub-task, Resuming ignoring the goal's status and an outstanding commit, the browser-check exception, the declined and closing commit, the no-sub-agent wording, who drops or abandons, and a search term that matched web addresses. Round 2 added the clear-context and fresh-role-agent rules and three Resuming clauses. Governor: compliant; no rule violation, no undecided behaviour, no scope creep. Four optional clarifications from the last review are carried to sub-task 3.
- **Verification:** `npm test` exits 0: 89 tests, 87 pass, 0 fail, 2 skipped (baseline 81 pass). `npm run validate` exits 0 with no warnings. The source-term search and a hand search for the source project's name find nothing in `plugins/goal`. In scratch copies, mutations of the skill, template and term list each fail the test meant to catch them. Not verified: the role files the skill points at (sub-task 4) and behaviour in a live session of either agent (sub-task 8).
- **Commit:** `d847648`
- **Task detail:** Done: the generic skill (steps 0-4, standing rules, roles with the neutral fallback, once-per-goal questions at approval, seven gate conditions, task detail, resuming by status, clear-context check, fresh role agents per sub-task), the ledger template next to it, and three tests (term search, template presence, the term patterns themselves). Not done: nothing in scope. Files: `plugins/goal/skills/goal-workflow/SKILL.md`, `plugins/goal/skills/goal-workflow/ledger-template.md`, `plugins/goal/tests/goal.test.mjs`, `plugins/goal/CHANGELOG.md`. Decisions: the 2026-10-04 rows for sub-task 2 in the decision log. Follow-ups: the four clarifications listed under sub-task 3.

### 3. Script for listing and scaffolding ledgers

- **Status:** pending
- **Scope:** A zero-dependency `goal.mjs` with two commands: list the ledgers in a project's `.agent-goals/` with slug, goal and status; create a ledger from the template for a given slug without overwriting an existing one. The skill is updated to call it with a written-out path. Also applies four clarifications to the skill carried from the sub-task 2 review: the fresh-agents rule also allows resuming an agent with the user's answers; after the last sub-task the clear-context stop happens once, and the closing commit is made by a new implementer or the last sub-task's if still available; before a new goal or unrelated task the user is told to give the request again after clearing, since no ledger holds it yet; and Resuming's baseline check means the baseline section is still unfilled, not that the project has no test command.
- **Source document:** none
- **Areas:** `plugins/goal/scripts/goal.mjs`, `plugins/goal/tests/goal.test.mjs`, `plugins/goal/skills/goal-workflow/SKILL.md`
- **Changes a screen:** no
- **Depends on:** 2
- **Acceptance:** tests cover listing none, one and several ledgers, scaffolding a new ledger, refusing to overwrite, and a bad slug; the script fails with a clear message and non-zero exit on error; no npm dependency is added
- **Governor notes:** AGENTS.md lines 25, 112.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 4. Role agents

- **Status:** pending
- **Scope:** Generic, self-contained ports of the four roles as `agents/*.md`. The governor derives its checklist from the project's instruction files; planner and implementer use the ledger's project commands; the implementer follows the project's commit style and the host's attribution; planner, governor and reviewer are read-only through `tools: Read, Grep, Glob, Bash` plus the written rule; the reviewer's scratch location is whatever the orchestrator passes.
- **Source document:** none
- **Areas:** `plugins/goal/agents/planner.md`, `governor.md`, `implementer.md`, `reviewer.md`, `plugins/goal/tests/goal.test.mjs`
- **Changes a screen:** no
- **Depends on:** 2
- **Acceptance:** the source-term search finds nothing; a test checks each agent's frontmatter is strict single-line YAML with `name` equal to the file name; no agent points at the skill's folder; each role keeps its closing verdict line and its "Questions for the user" rule; manual: `/agents` in a `claude --plugin-dir plugins/goal` session shows the four agents, recorded here with how they are addressed
- **Governor notes:** AGENTS.md lines 13, 14. `claude plugin validate` does not check agent frontmatter, so the test is the only check.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 5. Skill `start`

- **Status:** pending
- **Scope:** `/goal:start <request>` triages and starts a goal; with no argument it lists the ledgers through the script and asks which to resume.
- **Source document:** none
- **Areas:** `plugins/goal/skills/start/SKILL.md`
- **Changes a screen:** no
- **Depends on:** 2, 3
- **Acceptance:** the skills tests pass including the `$ARGUMENTS` preamble phrase; the folder and `name` are `start`; manual: `/goal:start` appears in a `--plugin-dir` session
- **Governor notes:** skills.test.mjs:70-90, 108. AGENTS.md line 80: Copilot keeps one of two same-named skills.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 6. SessionStart triage hook

- **Status:** pending
- **Scope:** `hooks/hooks.json` firing on every session start event (new, resume, after a clear, after compaction) and a zero-dependency Node handler that emits the short triage and never-assume rule as context. The wording applies only to the session talking to the user, and steps aside when the user explicitly runs another workflow's skill or command.
- **Source document:** none
- **Areas:** `plugins/goal/hooks/hooks.json`, `plugins/goal/scripts/session-start.mjs`, `plugins/goal/tests/goal.test.mjs`
- **Changes a screen:** no
- **Depends on:** 2, 4
- **Acceptance:** tests check the handler's output parses as JSON with `hookSpecificOutput.hookEventName` equal to `SessionStart` and a non-empty `additionalContext`, and that `hooks.json` points at an existing script; the hook command quotes the plugin-root variable; manual: in a scratch repo with `--plugin-dir` a first plain request gets a triage question, recorded here
- **Governor notes:** `claude plugin validate` warns on an unquoted plugin-root variable in a hook command and does not check the script exists.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 7. Repo documentation

- **Status:** pending
- **Scope:** README: plugin table row, Claude and Copilot install lines, a `goal` section, a "Which plugin" paragraph, Copilot notes (un-namespaced names, the name-collision risk of `/start`, and `/start` as the Copilot entry if its hook cannot inject context, worded as unverified until sub-task 8), and lines 28, 265 and 267 updated for three plugins; the historical Upgrading lines are left alone. AGENTS.md: opening description and plugin list, a short `goal` paragraph (its `hooks/hooks.json` is an agent hook, not an aisdlc lifecycle hook; `.agent-goals/` is separate from `.aisdlc/`; `scripts/goal.mjs`), and a `goal` block under the preserved product decisions (triage, never assume, branch, commit and fix-loop choices asked once per goal, never push).
- **Source document:** none
- **Areas:** `README.md`, `AGENTS.md`
- **Changes a screen:** no
- **Depends on:** 4, 5, 6
- **Acceptance:** the README has the Claude and Copilot install lines for `goal@aisdlc-marketplace`; README lines 28, 265 and 267 no longer describe two plugins; AGENTS.md names all three plugins and records goal's decisions
- **Governor notes:** AGENTS.md lines 7, 75, 91-94.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 8. End-to-end install check, Copilot check, and close

- **Status:** pending
- **Scope:** First record the starting contents of the user's Claude plugin registrations. In a scratch repo: load with `--plugin-dir`; add the local marketplace; install `goal@aisdlc-marketplace` at local scope; list; uninstall; remove the marketplace. Then the same in Copilot CLI with a hand check once the user has installed it; the goal pauses here until then. This sub-task may reopen the skill, agents, README and changelog to fix what the checks find, including renaming `start` to `goal-start` if it clashes; the README's Copilot wording is made final and the changelog date is set to the closing date.
- **Source document:** none
- **Areas:** this ledger; and, only for fixes the checks call for, `plugins/goal/**`, `README.md`, `AGENTS.md`, both marketplace files
- **Changes a screen:** no
- **Depends on:** 7
- **Acceptance:** each command exits 0; skill, agents, hook and start are discoverable in Claude Code; the Copilot result is recorded for each of skills, agents (including what it does with `tools:`), hook and start; every format risk below has a recorded answer; the user's plugin registrations match the recorded starting contents; `git status --short` is clean here, and the source project's working tree is as the orchestrator found it; `git log master..HEAD` shows the plan commit, eight sub-task commits and one closing ledger commit; no agent pushed; `goal-plugin` is left unmerged for the user
- **Governor notes:** 
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

## Format risks to verify during implementation

1. Whether a plugin agent is addressed as `goal:planner`, and whether the bare name also resolves.
2. Whether `claude plugin validate` passes on a manifest-only plugin, and what it checks in `agents/` and `hooks/`.
3. Whether Copilot loads a plugin's `agents/` and `hooks/hooks.json`, and whether a session-start hook can inject context there.
4. Whether SessionStart context reaches spawned sub-agents, and whether it re-fires after a cleared or compacted session.
5. Whether "the file next to SKILL.md" resolves in Claude Code, or needs the plugin-root variable plus its preamble sentence.
6. Whether a local-path marketplace install reads the working tree or a git ref, and whether it copies into the plugin cache.
7. Whether `start` clashes with a built-in in either agent.

## Decision log

| Date | Question | Decision | Sub-task |
|---|---|---|---|
| 2026-10-03 | Simple or complex | Complex | all |
| 2026-10-03 | Content | Generic version, no per-repo config file | 2, 3 |
| 2026-10-03 | The source project's own copies | Kept; the plugin is not installed there | all |
| 2026-10-03 | Relation to aisdlc | A third plugin inside this marketplace | 1 |
| 2026-10-03 | Names | Plugin `goal`; skill `goal-workflow`; agents `planner`, `governor`, `implementer`, `reviewer`, kept even if Copilot drops the namespace | 1-4 |
| 2026-10-03 | Ledger and commits | `.agent-goals/` in this repo, committed with each sub-task | all |
| 2026-10-03 | Branch | New branch `goal-plugin` off `master`, never pushed | all |
| 2026-10-03 | Triage entry | SessionStart hook plus an explicit start entry | 4, 5 |
| 2026-10-03 | Project commands in the plugin | Planner finds, user confirms at plan approval, recorded in the ledger; missing recorded as "none" | 2, 3 |
| 2026-10-03 | Source-project-only steps | Generalised | 2, 3 |
| 2026-10-03 | Ledger template location | Inside the skill folder | 2 |
| 2026-10-03 | Testing | Validate, `npm test`, hook JSON check, scratch-repo load and local install, uninstalled afterwards; temporary marketplace registration accepted | 5, 7 |
| 2026-10-03 | Conventions | Plugin CHANGELOG, root README section, version 0.1.0, `goal 0.1.0: ...` commit style, no tag; author `arin`, no licence, as the other plugins | 1, 6 |
| 2026-10-03 | Agents supported | Claude and GitHub Copilot in this goal | 2-7 |
| 2026-10-03 | Start entry form | A second skill named `start` | 4 |
| 2026-10-03 | Role form | `agents/` plus a neutral fallback in the skill | 2, 3 |
| 2026-10-03 | Hook handler | Node script; `/start` documented as the Copilot entry if its hook cannot inject context | 5, 6 |
| 2026-10-03 | Tests | Add `plugins/goal/tests/goal.test.mjs` and widen the preamble test | 5, 6 |
| 2026-10-03 | Copilot verification | The user installs Copilot CLI; sub-task 7 pauses until then | 7 |
| 2026-10-03 | Auto-commit and fix loop in the plugin | Aligned to this repo: asked once per goal at plan approval, both recorded in the ledger | 2 |
| 2026-10-03 | Overlap with aisdlc | README "Which plugin" paragraph and one sentence in the skill; no aisdlc skill edits | 2, 6 |
| 2026-10-03 | Ledger folder name in the plugin | `.agent-goals/` | 2 |
| 2026-10-03 | Project commands for this goal | As listed under "Project commands" | all |
| 2026-10-03 | Commits for this goal | Auto-commit on `goal-plugin` once the gate passes | all |
| 2026-10-03 | Task detail | Appended to the source task document when a sub-task finishes, with all four parts; applies to the source project's workflow and the plugin | 2 |
| 2026-10-04 | Deterministic steps in a script | A small `scripts/goal.mjs` for listing and scaffolding ledgers, tested | 3, 5 |
| 2026-10-04 | AGENTS.md changes | Plugin list, a goal paragraph, and a goal block under preserved product decisions | 7 |
| 2026-10-04 | Fallback role text | The skill points at the plugin root's `agents/` files with the standard preamble | 2 |
| 2026-10-04 | Read-only roles | `tools:` list plus the written rule; Copilot's handling recorded in the final check | 4, 8 |
| 2026-10-04 | Where Copilot fixes go | The final sub-task may reopen files | 8 |
| 2026-10-04 | Hook timing | Every session start event | 6 |
| 2026-10-04 | Branches in the plugin | Asked at plan approval with the commit and fix-loop choices, recorded in the ledger | 2 |
| 2026-10-04 | Triage and other workflows | Steps aside when the user explicitly runs another workflow's skill or command | 6 |
| 2026-10-04 | `start` name clash | Keep `start`; rename to `goal-start` only if a clash is found | 5, 8 |
| 2026-10-04 | Repo descriptions | Marketplace, AGENTS.md and README updated to mention goal; category `development`; historical Upgrading lines untouched | 1, 7 |
| 2026-10-04 | Commit style in the plugin | The project's style and the host's attribution; the plugin prescribes neither | 4 |
| 2026-10-04 | After the goal closes | `goal-plugin` is left unmerged; the user merges or pushes | 8 |
| 2026-10-04 | Task detail in the source project | Done separately there as a simple task | none |
| 2026-10-04 | Plan approval | Approved | all |
| 2026-10-04 | Local paths and source-project references in this ledger | Removed before the first commit | all |
| 2026-10-04 | Plugin and marketplace descriptions | Accepted as the implementer wrote them | 1 |
| 2026-10-04 | Original aisdlc patterns in the preamble test | Kept alongside the marketplace-derived rule | 1 |
| 2026-10-04 | Goal changelog intro | Same as aisdlc-nodejs, without the pre-1.0.0 sentence | 1 |
| 2026-10-04 | First ledger draft pushed on `master` as `502c390`, naming the source project | Accepted; history is left as it is. The row above saying the references were removed before the first commit is wrong: they were removed in `f16f26a`, the second commit | all |
| 2026-10-04 | Pushing | The user pushes the branches themselves; the workflow's agents never push | all |
| 2026-10-04 | Ledger's first commit in the plugin | Travels with the first sub-task's commit; no separate plan commit | 2 |
| 2026-10-04 | Browser check recorded as "none" on a screen change | Asked each time, never skipped silently | 2 |
| 2026-10-04 | Pushing in the plugin | Never on its own; pushes when the user explicitly asks | 2 |
| 2026-10-04 | New branch in the plugin | The orchestrator creates it right after approval and asks first when the tree has uncommitted changes | 2 |
| 2026-10-04 | Dropped sub-task | Counts like done everywhere; only the user drops | 2 |
| 2026-10-04 | Command recorded as "none" | Waives that gate condition for the goal; the approval question states which conditions will not be checked | 2 |
| 2026-10-04 | Declined commit | The sub-task stays done with its commit outstanding; the next one waits | 2 |
| 2026-10-04 | Smaller points | Goal in-progress at the first sub-task; closing commit follows the commit choice; slug is lowercase letters, digits and hyphens | 2, 3 |
| 2026-10-04 | Agent without sub-agents | Roles run one at a time in the current session; the review runs in a fresh session | 2 |
| 2026-10-04 | Plan edits and rejection | An edited plan goes back through the governor; a rejected plan is abandoned; only the user drops a sub-task or abandons a goal | 2 |
| 2026-10-04 | Narrowed `.ai/` search term | Accepted: it matches a path, not a web address on an `.ai` domain | 2 |
| 2026-10-04 | Clear-context check | In the plugin (the source project's own workflow was changed separately, outside this goal): stop and ask the user to clear the session before a new goal or unrelated task, after plan approval, between sub-tasks and at close; role agents fresh per sub-task | 2, 4 |
| 2026-10-04 | "Continue without clearing" | Asked at every point; not recorded as a standing choice | 2 |
| 2026-10-04 | Optional clarifications from the last sub-task 2 review | Sub-task 2 committed as reviewed; the four clarifications are applied in sub-task 3 | 2, 3 |

## Deferred and open

- Backporting to the source project any wording fixes found while porting: not in this goal; raise as a question.
- The source project's name is kept out of this repo: it is checked for by the reviewer by hand, not by a committed test or search term.
- Open question from the sub-task 1 review: whether placeholder forms such as `/goal:<skill>` should require the preamble. Left as is unless a goal skill writes one.
- Resuming this goal after a cleared session: the source being ported is the goal workflow of the project the orchestrating session runs in; the user names its location when resuming, since it is not recorded here.
