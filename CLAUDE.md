# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) that ships a stack-agnostic AI-SDLC workflow:
- `plugins/aisdlc`: the core plugin
- `plugins/aisdlc-nodejs`: a reference stack plugin

Skills must stay agent-neutral markdown, because Codex and Cursor adapters are planned. Put Claude-specific details only in path variables (`${CLAUDE_PLUGIN_ROOT}`, `$ARGUMENTS`).

## Commands

- `npm test`: runs every `plugins/*/tests/*.test.mjs` with `node:test`.
- Single test: `node --test --test-name-pattern "hooks: precedence" plugins/aisdlc/tests/aisdlc.test.mjs`
- `npm run validate`: runs `claude plugin validate` on the marketplace and on each plugin.
- Try the script by hand: `node plugins/aisdlc/scripts/aisdlc.mjs <cmd>` from inside any scratch project.

There is no build step and there are no npm dependencies. Keep it that way.

## Architecture

**Split of responsibilities.** Skills (`plugins/aisdlc/skills/*/SKILL.md`) handle the judgment and the user interaction. `plugins/aisdlc/scripts/aisdlc.mjs` handles every deterministic state change:
- ID allocation
- goal state moves
- DAG validation and ordering
- gates
- hook resolution and execution
- registry regeneration

Skills call the script (written `$AISDLC` in the skill files) and should never hand-edit state the script owns: `status`, `gate_*` fields, `registry.md`, `tasks.md`, or moving goal folders. When adding workflow behavior, put invariants in the script with tests, and keep instructions in the skill.

**State model.** Everything lives in the target project's `.aisdlc/`, stored as markdown with flat frontmatter. The parser only supports `key: value` scalars and inline `[a, b]` arrays; there is no nested YAML.
- A goal's status is the folder it sits in: `goals/<status>/G-NNN-slug/`.
- Gates are the `gate_challenge`, `gate_adr` and `gate_govern` fields in `goal.md`.
- Tasks are `tasks/T-NN-*.md` files with `depends_on` and `risk`.
- `registry.md` and `tasks.md` are generated views. Rebuild them rather than editing them.

**Strict gating** (`requireStep`/`setGate`): challenge → adr → govern → implement.
- `adr done` requires a linked ADR that is `accepted` (or `superseded`), or `adrs: none` plus `adr_reason`.
- `govern passed` requires `governance-review.md` with `result: pass`, a row for every non-retired rule in `governance.md`, no failed `must` rule, and a note on every `fail`/`n/a`.
- Setting challenge or adr again resets govern to pending and moves the review to `governance-review.stale.md`.
- `state move in-progress|completed` requires the implement gate. A goal can only move to `completed` when every task is done or skipped.
- Task changes need the goal to be in-progress (except resetting to `pending`, used to resume a blocked goal). A task starts only when its dependencies are done or skipped. It becomes `done` only from `in-progress` with `verified: pass`, which `task verify` records after running the task's `verify` command (or taking `--evidence` for a `manual:` check) and the `after_task` hook.
- Frontmatter values must be single-line. Only `adrs`, `depends_on` and `goals` parse as arrays.

**Hooks.** Each point resolves in the order env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` `hooks` > `.aisdlc/stacks/<stack>.json` > `plugins/aisdlc/defaults/hooks.json`. `{"use":"stack"|"default"}` delegates to another layer, and `null` disables the hook. The list of hook points is `HOOK_POINTS` in the script. When adding a workflow step, add it to `STEPS` so it gets `pre_`/`post_` points.

**Stack plugins** follow `plugins/aisdlc/docs/stack-plugin-contract.md`:
- a `stack.json` manifest
- a `register` skill that copies the manifest into the project's `.aisdlc/stacks/`
- a `standards` skill that `/aisdlc:implement` loads

The core script never reads other plugins' directories, only project-local files. To add stack detection, edit `STACK_MARKERS`.

## Product decisions to preserve

These were settled with the repo owner:
- Branch creation and per-task auto-commit are always **asked**, never forced.
- The `before_goal` default only pulls the base branch (default `develop`).
- On a verify failure, `/aisdlc:implement` asks the user to retry, skip or block. It does not auto-retry.
- `/aisdlc:challenge` is clarification Q&A, one question at a time. It is not a critique.
- There is no governance waiver.
- `/aisdlc:implement` runs one task per invocation unless `--all` or `implement.mode: "auto"` is set.
- A goal auto-completes once all tasks pass.
- Graphify is optional. Init offers it, and the fallback is `registry.md` only.
