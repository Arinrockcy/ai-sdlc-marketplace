# AGENTS.md

This file guides coding agents (Claude Code, GitHub Copilot and others) working in this repository. `CLAUDE.md` only imports it, so keep everything here.

## What this repo is

A plugin marketplace for Claude Code and GitHub Copilot that ships a stack-agnostic AI-SDLC workflow:
- `plugins/aisdlc`: the core plugin
- `plugins/aisdlc-nodejs`: a reference stack plugin

Skills must stay agent-neutral markdown, because GitHub Copilot loads the same plugins, and Codex and Cursor adapters are planned. Put Claude-specific details only in path variables (`${CLAUDE_PLUGIN_ROOT}`, `$ARGUMENTS`). Copilot leaves those variables as written (it shows the model the skill's folder instead) and doesn't namespace skills (`/govern`, not `/aisdlc:govern`; its skill tool loads `nodejs-standards`, not `aisdlc-nodejs:nodejs-standards`), so:
- A skill that uses one of them, a `plugin:skill` name, or the `standards_skills` from `detect-stack` keeps the preamble sentence that says what it stands for. `tests/skills.test.mjs` checks this.
- A step that hands work to a sub-agent passes the resolved `$AISDLC` command: the sub-agent doesn't see the skill's folder.
- Frontmatter must parse as strict YAML: quote a value that contains `: `. Claude Code accepts it unquoted, but Copilot skips the skill.

## Commands

- `npm test`: runs every `plugins/*/tests/*.test.mjs` with `node:test`.
- Single test: `node --test --test-name-pattern "hooks: precedence" plugins/aisdlc/tests/aisdlc.test.mjs`
- `npm run validate`: runs `claude plugin validate` on the marketplace and on each plugin.
- `AISDLC_ESLINT=<dir> npm test`: also checks `aisdlc-nodejs`'s ESLint template against a real ESLint 9+ that resolves from `<dir>` (any project with ESLint installed). Without it those tests are skipped, because this repo has no dependencies. Run it when the template changes.
- `npm run bench [-- 10,100,500]`: measures what skills read and what commands print (approximate tokens) as a project grows. Run it when a change touches what skills read or what the script prints.
- Try the script by hand: `node plugins/aisdlc/scripts/aisdlc.mjs <cmd>` from inside any scratch project.

There is no build step and there are no npm dependencies. Keep it that way.

## Releases

Each plugin has its own version and `CHANGELOG.md` (Keep a Changelog format).
- When a change alters a plugin's behavior, add it to that plugin's changelog.
- Bump the version in the plugin's `.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`, and keep them identical. Then copy `.claude-plugin/marketplace.json` to `.github/plugin/marketplace.json`: Claude Code and Copilot CLI read the first, VS Code only the second. `npm test` enforces both.
- Changes that make existing `.aisdlc/` state refuse, fail or mean something different go under **Breaking**, with an upgrade step in the README's Upgrading section.
- Before 1.0.0, a breaking change bumps the minor version.

## Architecture

**Split of responsibilities.** Skills (`plugins/aisdlc/skills/*/SKILL.md`) handle the judgment and the user interaction. `plugins/aisdlc/scripts/aisdlc.mjs` handles every deterministic state change:
- ID allocation
- goal state moves
- DAG validation and ordering
- gates
- hook resolution and execution
- registry regeneration and search
- review scaffolds (`governance review`), pre-switch checks (`goal preflight`), a goal's changes (`goal diff`) and pushing its branch (`goal push`)
- the code graph: Graphify setup, freshness and queries
- the coverage check (`coverage check`) against the report each active stack's manifest declares

Skills call the script (written `$AISDLC` in the skill files) and should never hand-edit state the script owns. Every `$AISDLC …` span in a skill must be a complete, runnable invocation. Write placeholders as `<G-id>`, `<T-id>`, `<ADR-id>`, `<GOV-id>`, `<keywords>` or `<name>`, alternatives as `a|b`, optional parts as `[...]`, and `…` only as an option's value. `tests/skills.test.mjs` runs each one and fails if the script no longer understands it. The script rejects unknown options, so every option must be in `OPTIONS`. The state the script owns: `status`, `gate_*`, `govern_fingerprint` and `cancel_reason` fields, the `## Cancellations` and `## Removed tasks` logs in `goal.md`, the rules table in `governance.md`, `registry.md`, `registry-archive.md`, `tasks.md`, and goal folder moves. When adding workflow behavior, put invariants in the script with tests, and keep instructions in the skill.

**State model.** Everything lives in the target project's `.aisdlc/`, stored as markdown with flat frontmatter. The parser only supports `key: value` scalars and inline `[a, b]` arrays; there is no nested YAML.
- A goal's status is the folder it sits in: `goals/<status>/G-NNN-slug/`.
- Gates are the `gate_challenge`, `gate_adr` and `gate_govern` fields in `goal.md`.
- Tasks are `tasks/T-NN-*.md` files with `depends_on` and `risk`. They change only through `task new|edit|remove`, and a task ID is never reused.
- `registry.md`, `registry-archive.md` and `tasks.md` are generated views. Rebuild them rather than editing them. `registry.md` holds unfinished goals and every ADR. Finished goals go to the archive, so the file skills read whole only grows with open work.
- Skills must not read an index that grows without bound (the archive, `GRAPH_REPORT.md`, unfiltered `goal list`) in full. Filter it with the script, search it, or query it.

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

**Hooks.** Each point resolves in the order env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` `hooks` > `.aisdlc/stacks/<stack>.json` (every active stack, merged) > `plugins/aisdlc/defaults/hooks.json`. `{"use":"stack"|"default"}` delegates to another layer, and `null` disables the hook. The list of hook points is `HOOK_POINTS` in the script. When adding a workflow step, add it to `STEPS` so it gets `pre_`/`post_` points.

**Stack plugins** follow `plugins/aisdlc/docs/stack-plugin-contract.md`:
- a `stack.json` manifest, including `quality_gate.coverage_report`, the report its test command writes on every run
- a `<stack>-register` skill that copies the manifest into the project's `.aisdlc/stacks/`
- a `<stack>-standards` skill that `/aisdlc:implement` loads (both names carry the stack, because Copilot keeps only one of two plugin skills with the same name)
- `markers`: the root files that show a project uses the stack
- optionally, a zero-dependency script for the plugin's deterministic steps, as `aisdlc-nodejs` has in `scripts/nodejs.mjs` (written `$NODEJS` in its skills). It reads the plugin's own `stack.json` and project-local files, never the core's. Its `OLDEST_COMPATIBLE_MANIFEST` names the oldest installed manifest the plugin still accepts: raise it with any release that changes what the manifest must contain. Its `TEMPLATE_HISTORY` holds the hash of every earlier committed template, so unedited copies update; a test fails until a changed template's old hash is added.

The core script finds installed stack plugins (`stackPluginDirs`): plugins next to it, Claude Code's `installed_plugins.json`, and Copilot CLI's `config.json` and `installed-plugins/`. From each it reads only `stack.json` and the plugin manifest, never runs its code, and uses them to detect the stack (`markers`) and name the register skill. Everything else it reads is project-local. `STACK_MARKERS` covers stacks whose plugin isn't installed. Tests set `AISDLC_STACK_PLUGINS`, which replaces the search.

**Several stacks.** Every detected stack with a manifest in `.aisdlc/stacks/` is active, plus the ones `stack` in config names. Registering a stack activates it, so a plugin installed later needs no config change. The stack hook layer runs each active stack's commands in turn (`mergeStackHooks`), and `coverage check` checks every active stack's report.

## Product decisions to preserve

These were settled with the repo owner:
- Branch creation and per-task auto-commit are always **asked**, never forced.
- The `before_goal` default only pulls the base branch (default `develop`).
- The `after_goal` default runs `coverage check`, then `goal push`, which pushes the goal branch to `origin`. `goal push` never pushes the base branch. It runs before the goal completes, so a failed check can stop completion. The user may retry, finish anyway or stop.
- On a verify failure, `/aisdlc:implement` asks the user to retry, skip or block. It does not auto-retry.
- No skill assumes. Anything unclear or under-documented that the code doesn't answer is asked, never guessed or defaulted silently.
- `/aisdlc:create-goal` first checks for unfinished goals (pending, in-progress, blocked). It asks whether to merge into a pending goal, finish or cancel an unfinished one first, or create a separate goal, and never picks for the user. Merge is offered only for `pending` goals, because in-progress and blocked goals can't be re-challenged. A merge resets the challenge and adr gates.
- `/aisdlc:create-goal` then asks intake questions about the gaps in the description, before writing the goal. Answers go under Clarifications so challenge doesn't repeat them.
- `/aisdlc:challenge` is clarification Q&A, one question at a time. It is not a critique.
- There is no governance waiver.
- Governance has two stages. `plan` rules gate implementation. `final` rules gate completion, and `/aisdlc:implement` runs the final review itself.
- `init` seeds GOV-06 (`must`, `final`, check `criteria-met`), so finished code is reviewed against its acceptance criteria by default. Init also offers `/aisdlc:govern` for the project's own rules.
- Every review row needs a note, and a `pass` note cites evidence. Reviews run in a sub-agent or fresh session when the agent supports one.
- The plan review fails GOV-05 only for an open question about behavior inside Scope (In), or a contradiction between goal, tasks, ADRs and standards. Other details go under Readings. Questions for the user stay a `fail` (no separate result value): the review lists them under `## Questions for the user`, the calling session asks them, and the answers go under Clarifications, which later reviewers treat as settled.
- Unanswered questions are recorded as `- **Open:** …` under Risks & Unknowns, and the `questions-resolved` check on GOV-05 fails while any remain.
- Goals can be cancelled and reopened. A cancel always records the user's reason, and the `## Cancellations` log keeps every one for good. A started goal never returns to `pending`. It takes new scope only as new tasks, which reset governance. Several goals may be in progress at once: `/aisdlc:implement` warns before `before_goal` switches branches under another goal and asks, but never refuses.
- A task added after governance passed (including one discovered mid-implement) resets governance. Implement stops until the goal is re-governed.
- `/aisdlc:govern` offers `templates/governance-catalog.md` rules as choices and never adds one silently. `governance add` requires an explicit severity and stage.
- `/aisdlc:implement` runs one task per invocation unless `--all` or `implement.mode: "auto"` is set.
- A goal auto-completes once all tasks pass.
- Stacks are detected, not chosen. Init registers every detected stack whose plugin is installed without asking, and `/aisdlc:create-goal` and `/aisdlc:implement` register a stack plugin installed later (mid-goal, implement asks first). A repository can have several active stacks.
- Graphify is optional and used only to save tokens. Init offers it. The script runs it code-only (no model calls), and `graph query` rebuilds it whenever the code changed, so no skill asks about rebuilding. A missing or failing Graphify never blocks the workflow: skills fall back to searching the code. `registry.md` indexes goals and ADRs, never code.
- When a skill step is deterministic (a lookup, a git check, a scaffold, a mapping), it goes in the script. Skills keep only judgment and user interaction.
