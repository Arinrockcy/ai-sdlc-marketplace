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

## Releases

Each plugin has its own version and `CHANGELOG.md` (Keep a Changelog format).
- When a change alters a plugin's behavior, add it to that plugin's changelog.
- Bump the version in the plugin's `.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`, and keep them identical. `npm test` enforces this.
- Changes that make existing `.aisdlc/` state refuse, fail or mean something different go under **Breaking**, with an upgrade step in the README's Upgrading section.
- Before 1.0.0, a breaking change bumps the minor version.

## Architecture

**Split of responsibilities.** Skills (`plugins/aisdlc/skills/*/SKILL.md`) handle the judgment and the user interaction. `plugins/aisdlc/scripts/aisdlc.mjs` handles every deterministic state change:
- ID allocation
- goal state moves
- DAG validation and ordering
- gates
- hook resolution and execution
- registry regeneration

Skills call the script (written `$AISDLC` in the skill files) and should never hand-edit state the script owns. Every `$AISDLC …` span in a skill must be a complete, runnable invocation. Write placeholders as `<G-id>`, `<T-id>`, `<ADR-id>`, `<GOV-id>` or `<name>`, alternatives as `a|b`, optional parts as `[...]`, and `…` only as an option's value. `tests/skills.test.mjs` runs each one and fails if the script no longer understands it. The script rejects unknown options, so every option must be in `OPTIONS`. The state the script owns: `status`, `gate_*`, `govern_fingerprint` and `cancel_reason` fields, the `## Cancellations` log in `goal.md`, the rules table in `governance.md`, `registry.md`, `tasks.md`, and goal folder moves. When adding workflow behavior, put invariants in the script with tests, and keep instructions in the skill.

**State model.** Everything lives in the target project's `.aisdlc/`, stored as markdown with flat frontmatter. The parser only supports `key: value` scalars and inline `[a, b]` arrays; there is no nested YAML.
- A goal's status is the folder it sits in: `goals/<status>/G-NNN-slug/`.
- Gates are the `gate_challenge`, `gate_adr` and `gate_govern` fields in `goal.md`.
- Tasks are `tasks/T-NN-*.md` files with `depends_on` and `risk`.
- `registry.md` and `tasks.md` are generated views. Rebuild them rather than editing them.

**Strict gating** (`requireStep`/`setGate`): challenge → adr → govern → implement.
- `adr done` requires a linked ADR that is `accepted` (or `superseded`), or `adrs: none` plus `adr_reason`.
- Rules in `governance.md` are rows of `ID | Rule | Severity | Stage | Check`, changed only through `governance add|set`:
  - Severity is `must|should|retired`. A bad value fails loudly.
  - Stage is `plan|final`.
  - Check names an entry in `CHECKS`.
- `govern passed` requires `governance-review.md` with `result: pass`, a row for every active plan rule, no failed `must` rule, a note on every row (evidence for `pass`, reason for `fail`/`n/a`), and no `pass`/`n/a` on a rule whose automatic check fails. It stores `govern_fingerprint` (`planFingerprint`: goal text, planned task fields and text minus Notes and checkbox state, linked ADR statuses, plan rules).
- `gate_final` works the same for `final` rules via `governance-final.md`. It is only required when active final rules exist.
- `invalidate` resets a gate and every later one (adr → govern → final) and archives reviews as `<name>.stale-N.md`. It runs on:
  - setting challenge or adr
  - `adr link` or `adr none` changing the links
  - `task new` (resets govern)
  - any `task set` (resets final)
  - `gate set govern|final pending`
- `state move in-progress|completed` requires the implement gate, which includes a matching plan fingerprint. `state move cancelled` requires `--reason` (stored as `cancel_reason`). A completed goal never changes again. A cancelled goal refuses every change until it is reopened (`assertOpen`). Moves follow `GOAL_MOVES`, and a goal is `pending` only while none of its tasks has started: an in-progress goal returns to `pending` only before its first task starts, and a cancelled goal whose work started reopens as `blocked`. `challenge` runs only on `pending` goals. A goal can only move to `completed` when every task is done or skipped and, if final rules exist, `gate_final` is passed.
- Task changes need the goal to be in-progress (except resetting to `pending`, used to resume a blocked goal). A task starts, or becomes done, only while the implement gate holds (governance passed and the plan unchanged). It also needs its dependencies done or skipped. It becomes `done` only from `in-progress` with `verified: pass`. `task verify` records that after running the task's `verify` command and the `after_task` hook. It takes `--evidence` instead for a `manual:` check, or when neither exists and nothing would run.
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
- No skill assumes. Anything unclear or under-documented that the code doesn't answer is asked, never guessed or defaulted silently.
- `/aisdlc:create-goal` first checks for unfinished goals (pending, in-progress, blocked). It asks whether to merge into a pending goal, finish or cancel an unfinished one first, or create a separate goal, and never picks for the user. Merge is offered only for `pending` goals, because in-progress and blocked goals can't be re-challenged. A merge resets the challenge and adr gates.
- `/aisdlc:create-goal` then asks intake questions about the gaps in the description, before writing the goal. Answers go under Clarifications so challenge doesn't repeat them.
- `/aisdlc:challenge` is clarification Q&A, one question at a time. It is not a critique.
- There is no governance waiver.
- Governance has two stages. `plan` rules gate implementation. `final` rules gate completion, and `/aisdlc:implement` runs the final review itself.
- `init` seeds GOV-06 (`must`, `final`, check `criteria-met`), so finished code is reviewed against its acceptance criteria by default. Init also offers `/aisdlc:govern` for the project's own rules.
- Every review row needs a note, and a `pass` note cites evidence. Reviews run in a sub-agent or fresh session when the agent supports one.
- Unanswered questions are recorded as `- **Open:** …` under Risks & Unknowns, and the `questions-resolved` check on GOV-05 fails while any remain.
- Goals can be cancelled and reopened. A cancel always records the user's reason, and the `## Cancellations` log keeps every one for good. A started goal never returns to `pending`. It takes new scope only as new tasks, which reset governance. Several goals may be in progress at once: `/aisdlc:implement` warns before `before_goal` switches branches under another goal and asks, but never refuses.
- A task added after governance passed (including one discovered mid-implement) resets governance. Implement stops until the goal is re-governed.
- `/aisdlc:govern` offers `templates/governance-catalog.md` rules as choices and never adds one silently. `governance add` requires an explicit severity and stage.
- `/aisdlc:implement` runs one task per invocation unless `--all` or `implement.mode: "auto"` is set.
- A goal auto-completes once all tasks pass.
- Graphify is optional. Init offers it, and the fallback is `registry.md` only.
