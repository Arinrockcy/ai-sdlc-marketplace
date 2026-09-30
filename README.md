# AI-SDLC Marketplace

A stack-agnostic AI-SDLC workflow for Claude Code. Its skills are written in neutral markdown so adapters for Codex, Cursor and other agents can follow later.

| Plugin | Purpose |
|--------|---------|
| `aisdlc` | Core workflow: init, create-goal, challenge, adr, govern, implement |
| `aisdlc-nodejs` | Node.js stack: standards skill and test-hook overrides |

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
/aisdlc:create-goal <description>   → intake questions first, then goal + task DAG (waves, risk-first)
/aisdlc:challenge G-001             → one-question-at-a-time clarification
/aisdlc:adr G-001                   → ADRs, or "none needed" with a reason
/aisdlc:govern                      → edit project rules (no argument), with an optional rule catalog
/aisdlc:govern G-001                → plan review: pass or fail against the plan-stage rules
/aisdlc:implement G-001 [--all]     → task by task in DAG order, with hooks
/aisdlc:govern G-001 --final        → final review of the finished work (implement runs it when final-stage rules exist)
```

No step works from assumptions. When something is unclear or under-documented and the code doesn't answer it, the skill asks you, and answers are recorded under the goal's Clarifications.

Each step refuses to run until the previous gate passes, and the script enforces it:
- A goal can't start before governance passes.
- Tasks run in dependency order.
- A task is done only after `task verify` passes.
- A goal with `final`-stage rules completes only after the final review passes.

Governance is tied to what it reviewed:
- Rules can name automatic checks (`goal-defined`, `tasks-verifiable`, `dag-valid`, `adr-recorded`) that a review can't overrule.
- The plan is fingerprinted when governance passes. Editing the goal, tasks, linked ADRs or plan rules afterwards blocks the next task until it is re-governed.
- Re-running `challenge` or `adr`, linking another ADR, or adding a task resets the governance gate. The old review is archived as `governance-review.stale-N.md`.
- There is no waiver.

## Project layout created by init

```
.aisdlc/
  config.json  registry.md  governance.md
  adr/  stacks/  cache/
  goals/{pending,in-progress,blocked,completed}/G-001-slug/
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

## Development

```
npm test            # node:test suite for scripts/aisdlc.mjs
npm run validate    # claude plugin validate (marketplace and both plugins)
```
