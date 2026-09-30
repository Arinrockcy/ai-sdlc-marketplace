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
/aisdlc:create-goal <description>   → goal + task DAG (waves, risk-first)
/aisdlc:challenge G-001             → one-question-at-a-time clarification
/aisdlc:adr G-001                   → ADRs, or "none needed" with a reason
/aisdlc:govern                      → edit project rules (no argument)
/aisdlc:govern G-001                → gate: pass or fail against the rules
/aisdlc:implement G-001 [--all]     → task by task in DAG order, with hooks
```

Each step refuses to run until the previous gate passes, and the script enforces it: a goal cannot start before governance passes, tasks run in dependency order, and a task is done only after `task verify` passes. Re-running `challenge` or `adr` resets the governance gate and marks the old review stale.

## Project layout created by init

```
.aisdlc/
  config.json  registry.md  governance.md
  adr/  stacks/  cache/
  goals/{pending,in-progress,blocked,completed}/G-001-slug/
    goal.md  tasks.md  tasks/T-01-slug.md  governance-review.md
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
