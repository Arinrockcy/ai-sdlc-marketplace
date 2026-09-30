# AI-SDLC Marketplace

A stack-agnostic AI-SDLC workflow for Claude Code. Its skills are written in neutral markdown so adapters for Codex, Cursor and other agents can follow later.

| Plugin | Purpose |
|--------|---------|
| `aisdlc` | Core workflow: init, create-goal, challenge, adr, govern, implement |
| `aisdlc-nodejs` | Node.js stack: class-oriented coding standards and required ESLint/coverage hooks |

## Install

```
/plugin marketplace add <path-or-git-url-of-this-repo>
/plugin install aisdlc@aisdlc-marketplace
/plugin install aisdlc-nodejs@aisdlc-marketplace   # optional, per stack
```

Requires Node.js 18+. Graphify is optional; `/aisdlc:init` offers to set it up.

## Workflow (strict and gated)

```
/aisdlc:init
/aisdlc:create-goal <description>   → checks unfinished goals (merge / finish first / cancel / separate), intake questions, then goal + task DAG (waves, risk-first)
/aisdlc:challenge G-001             → one-question-at-a-time clarification
/aisdlc:adr G-001                   → ADRs, or "none needed" with a reason
/aisdlc:govern                      → edit project rules (no argument), with an optional rule catalog
/aisdlc:govern G-001                → plan review: pass or fail against the plan-stage rules
/aisdlc:implement G-001 [--all]     → task by task in DAG order, with hooks
/aisdlc:govern G-001 --final        → final review of the finished work (implement runs it; init seeds GOV-06, a final rule)
```

No step works from assumptions. When something is unclear or under-documented and the code doesn't answer it, the skill asks you, and answers are recorded under the goal's Clarifications.

Each step refuses to run until the previous gate passes, and the script enforces it:
- A goal can't start before governance passes.
- Tasks run in dependency order.
- A task is done only after `task verify` passes.
- A goal with `final`-stage rules completes only after the final review passes. New projects start with one: GOV-06, every acceptance criterion met.
- A goal you no longer want is cancelled with a reason (`aisdlc.mjs state move G-001 cancelled --reason "…"`). Every reason stays in the goal's `## Cancellations` log, even after the goal is reopened. It reopens with `state move G-001 pending`, or `state move G-001 blocked` if its work had started. Completed goals can't change.
- A goal is `pending` only until its first task starts. After that, new scope goes in as new tasks (governance runs again), or in a new goal.
- Tasks change only through the script: `task edit` for a title, dependencies, risk or verify command, and `task remove --reason` before the goal starts. Removals are logged in the goal, and a task ID is never reused.

Governance is tied to what it reviewed:
- Rules can name automatic checks (`goal-defined`, `tasks-verifiable`, `dag-valid`, `adr-recorded`, `questions-resolved`, `criteria-met`) that a review can't overrule.
- Every row of a review needs a note: the evidence for a `pass`, the reason for a `fail` or `n/a`.
- The plan is fingerprinted when governance passes. Editing the goal, tasks, linked ADRs or plan rules afterwards blocks the next task until it is re-governed.
- Re-running `challenge` or `adr`, linking another ADR, or adding or editing a task resets the governance gate. The old review is archived as `governance-review.stale-N.md`. Archived reviews are kept on purpose, as the goal's audit trail, and the next reviewer reads the latest one.
- A reviewer that runs into a question only the user can answer writes it under Questions for the user. The review fails, the questions are asked, and the answers go under Clarifications, which later reviewers treat as settled.
- There is no waiver.

## Project layout created by init

```
.aisdlc/
  config.json  registry.md  registry-archive.md  governance.md
  adr/  stacks/  cache/
  goals/{pending,in-progress,blocked,completed,cancelled}/G-001-slug/
    goal.md  tasks.md  tasks/T-01-slug.md  governance-review.md  governance-final.md
```

## Hooks

Hook points: `before_goal`, `after_goal`, `before_task`, `after_task`, `on_block`, and `pre_<step>`/`post_<step>` for each command.

Each point resolves in this order: **env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` > stack manifest > core defaults**.

```json
{ "hooks": { "after_task": { "run": "npx jest --ci" }, "before_task": null } }
```

```
AISDLC_HOOK_AFTER_TASK="pnpm test" …   # one-off override; "none" disables
```

Core defaults: `before_goal` pulls the base branch (`git.base_branch`, default `develop`), and `after_task` defers to the stack. `after_task` runs as part of `aisdlc.mjs task verify`, after the task's own `verify` command. Branch creation and auto-commit are always asked, never forced.

See [`plugins/aisdlc/docs/stack-plugin-contract.md`](plugins/aisdlc/docs/stack-plugin-contract.md) to add a stack.

## Upgrading

Each plugin keeps a changelog: [`aisdlc`](plugins/aisdlc/CHANGELOG.md), [`aisdlc-nodejs`](plugins/aisdlc-nodejs/CHANGELOG.md). Breaking changes are listed there with their upgrade step.

### 0.5.x → 0.6.0 (`aisdlc`)

Update the plugin. Then, in each project with a review that hasn't passed yet (`governance-review.md` or `governance-final.md`), escape each literal `|` in a note as `\|`. `gate set … passed` now refuses a row with more than three cells, because the text after an unescaped `|` was silently dropped.

Goal files need no edits. The new `## Standards deviations` section is optional, so older goals simply don't have it. The first `graph query` after the update rebuilds the graph once, because `.gitignore` no longer counts as code.

### `aisdlc-nodejs` 0.2.0 → 0.2.1

Nothing is required. To bring an existing manifest in line with the tools you chose, re-run `/aisdlc-nodejs:register`: it writes the chosen test runner and enforced thresholds into `.aisdlc/stacks/nodejs.json`, and checks that the gate passes on the current code. Commit the manifest on its own.

### `aisdlc-nodejs` 0.1.0 → 0.2.0

The Node.js after-task gate now requires two package scripts: `lint` and `test:coverage`. The latter must enforce at least 80% coverage for branches, functions, lines and statements (Jest is the default).

1. Re-run `/aisdlc-nodejs:register` and select the lint/test tooling. It will ask before adding or changing third-party packages.
2. Add or update the two scripts and their configuration as prompted. Existing stricter coverage thresholds should stay unchanged.
3. Commit the updated `.aisdlc/stacks/nodejs.json`, `package.json`, lockfile and tool configuration.

### 0.4.0 → 0.5.0 (`aisdlc`)

Update the plugin. Only projects that use Graphify need anything:

1. **Remove `graph.path`** from `.aisdlc/config.json` if it is set. The graph always lives in `graphify-out/`.
2. **Run `node <plugin>/scripts/aisdlc.mjs graph setup`.** It adds `.aisdlc/` to `.graphifyignore` and rebuilds the graph code-only, so it no longer needs the model or the `/graphify` skill. Commit `.graphifyignore`.

### 0.3.x → 0.4.0 (`aisdlc`)

Update the plugin, then in each project that already has `.aisdlc/`:

1. **Regenerate the registry.** Run `node <plugin>/scripts/aisdlc.mjs registry sync`, or let the next workflow step do it. It moves completed and cancelled goals into `registry-archive.md` and drops the Path column. Commit both files.
2. **Check any tooling around `.aisdlc/`.** Anything that reads finished goals or the Path column from `registry.md`, or the numeric output of `registry sync`, needs updating. Use `goal list` and `adr list` for structured data.

Goal and ADR files need no edits.

### 0.2.0 → 0.3.0 (`aisdlc`)

Update the plugin, then in each project that already has `.aisdlc/`:

1. **Write a note on every review row.** A governance review in progress needs a note on each `pass` row too, citing the evidence, before `gate set … passed` accepts it. Gates that already passed are not re-checked.
2. **Turn on the new checks (recommended).** Run `/aisdlc:govern`: it offers both. By hand:
   - `node <plugin>/scripts/aisdlc.mjs governance set GOV-05 check questions-resolved`. Unanswered questions under Risks & Unknowns then need the form `- **Open:** <question>`. This changes a plan rule, so goals past governance but not completed need `/aisdlc:govern <G-id>` again before their next task.
   - `node <plugin>/scripts/aisdlc.mjs governance add "The finished code meets every acceptance criterion of the goal and of each done task." --severity must --stage final --check criteria-met`. Goals in progress then need the final review (`/aisdlc:govern <G-id> --final`, which `/aisdlc:implement` runs) before they complete.
3. **Run `/aisdlc:init` again.** It creates the `goals/cancelled/` folder. `state move … cancelled` also creates it when needed.
4. **Check any tooling around `.aisdlc/`.** Completed goals now refuse every change, and `state move` fails when `--reason` is given for a state other than `cancelled`.
5. **Check for started goals sitting in `pending`.** `state move` now only allows these moves: pending → in-progress or cancelled; in-progress → blocked, completed, cancelled, or pending (only before any task starts); blocked → in-progress or cancelled; cancelled → pending or blocked. A goal that 0.2.0 moved back to `pending` after a task started keeps working, but `challenge` and the create-goal merge will re-plan work already done. Move it on with `/aisdlc:implement <G-id>`, which moves it to in-progress. `challenge` also refuses blocked goals now.

Goal files from 0.2.0 need no edits. A missing `cancel_reason` field counts as empty.

### 0.1.0 → 0.2.0 (`aisdlc`)

Update the plugin, then in each project that already has `.aisdlc/`:

1. **Re-govern goals that already passed.** Run `/aisdlc:govern <G-id>` for every goal that is past governance but not completed. 0.2.0 records what each review covered, and older reviews have no such record. Until you re-govern, `/aisdlc:implement` refuses with "governance passed before aisdlc 0.2.0". The earlier review is archived as `governance-review.stale-N.md`. Completed goals need nothing.
2. **Turn on the automatic checks (recommended).** Your `governance.md` keeps working as it is: every rule becomes a `plan` rule with no check. To get the checks new projects start with, run `/aisdlc:govern` and ask it to set these checks (or run the script's `governance set <id> check <name>` yourself):

   | Rule | Check |
   |------|-------|
   | GOV-01 | `goal-defined` |
   | GOV-02 | `tasks-verifiable` |
   | GOV-03 | `dag-valid` |
   | GOV-04 | `adr-recorded` |

   The first change rewrites the rules table in the new `ID | Rule | Severity | Stage | Check` format and keeps the rest of the file. With checks on, re-governing fails any goal whose `goal.md` lacks a Problem or acceptance criteria, or whose tasks lack acceptance criteria or a `verify` command. Fill those in first.
3. **Optionally add final-stage rules.** `/aisdlc:govern` now offers a rule catalog. Rules with stage `final` are checked against the finished code before a goal completes. Goals in progress pick them up automatically, so their completion then needs `/aisdlc:govern <G-id> --final`.
4. **Check any tooling around `.aisdlc/`.** If you have scripts that depend on the following, update them:
   - `governance-review.stale.md`: archives are now numbered.
   - `task verify` passing a task that has no verify command and no `after_task` hook: it now requires `--evidence`.
   - unknown options: the script used to ignore them, and now fails on them.

Goal files from 0.1.0 need no edits. Missing `gate_final` and `govern_fingerprint` fields count as pending.

## Development

```
npm test            # node:test suite for scripts/aisdlc.mjs
npm run bench       # token cost of registry files and command output at 10/100/500 goals
npm run validate    # claude plugin validate (marketplace and both plugins)
```

When a change alters a plugin's behavior, add an entry under that plugin's `CHANGELOG.md` and bump its version in both its `plugin.json` and `.claude-plugin/marketplace.json`. Breaking changes (anything that makes existing `.aisdlc/` state refuse, fail or mean something else) go under **Breaking**, with an upgrade step in the README. `npm test` checks that the versions and changelogs agree.
