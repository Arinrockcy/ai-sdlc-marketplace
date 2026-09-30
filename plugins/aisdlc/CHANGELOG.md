# Changelog: aisdlc

All notable changes to the `aisdlc` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0.0, a minor version may include breaking changes; each one is listed under **Breaking** with its upgrade step.

## [0.3.1] - 2026-09-30

### Changed
- `/aisdlc:init` no longer presents `registry.md` as an alternative to a code graph. The option is now **No graph**: skills search the code directly, and the registry, which indexes goals and ADRs only, is kept either way.
- `/aisdlc:implement` asks whether to rebuild the Graphify graph once a goal completes, and `/aisdlc:create-goal` asks whether to rebuild it first when it is missing or older than the latest commit. Before, the graph was built once at init and went stale.

### Fixed
- `graph.path` is now honored. `/aisdlc:create-goal` read `graphify-out/` whatever the setting, and `/aisdlc:init` suggested ignoring `graphify-out/` instead of the configured directory.

## [0.3.0] - 2026-09-30

Finished work is now reviewed by default, reviews must show their evidence, and goals can be cancelled. See [Upgrading to 0.3.0](../../README.md#upgrading) before updating a project that already has goals.

### Breaking
- A governance review needs a note on every row, `pass` included, citing the evidence. `gate set govern|final passed` refuses a review with an empty note.
- A completed goal can no longer change: `state move`, `goal set`, `gate set`, `task new`, `adr link|none` and `adr new --goal` refuse it. Before, `state move` could move it back to another state.
- `state move` fails when `--reason` is given for any state other than `cancelled`, instead of ignoring it.
- `state move` follows a fixed set of transitions. A goal is `pending` only while none of its tasks has started, so an in-progress goal returns to `pending` only before its first task starts, and a blocked goal never does. `pending` can't move straight to `blocked`. Before, any move was accepted, which let a started goal be re-challenged or merged into, and made `/aisdlc:implement` re-run `before_goal` on it.
- `challenge` no longer runs on a `blocked` goal, matching the rule that a started goal can't be re-challenged.

### Added
- `cancelled` goal state. `state move <G-id> cancelled --reason "<why>"` requires a reason, records it as `cancel_reason`, and moves the goal to `goals/cancelled/`. Every cancel and reopen is also appended to a `## Cancellations` log in `goal.md`, which reopening never clears and the plan fingerprint ignores. `goal show` lists it as `cancellations`. A cancelled goal takes no changes until it is reopened: `state move <G-id> pending` if none of its tasks had started, otherwise `state move <G-id> blocked`, which `/aisdlc:implement` resumes. `/aisdlc:create-goal` offers to cancel an unfinished goal, or reopen an overlapping cancelled one, and `/aisdlc:implement` offers to cancel a blocked goal.
- `questions-resolved` check: fails while the goal's Risks & Unknowns lists an `- **Open:** …` item. New projects attach it to GOV-05. `/aisdlc:create-goal` and `/aisdlc:challenge` record unanswered questions in that form and remove them once the user answers.
- `criteria-met` check: fails while an acceptance criterion of the goal, or of a task that isn't skipped, is unticked. `/aisdlc:govern --final` ticks goal criteria only when the code shows they are met.
- New projects get GOV-06, a `must` `final` rule with the `criteria-met` check, so every goal gets a final review before it completes.
- `/aisdlc:init` shows the governance rules, says when no `final` rule is active, and offers to run `/aisdlc:govern`. `/aisdlc:govern` offers the two new checks to projects that lack them.
- `/aisdlc:govern` runs its reviews in a sub-agent or fresh session when the agent supports one, so the context that wrote the plan doesn't review it.
- Before `before_goal` switches branches, `/aisdlc:implement` warns when another goal is in progress, or when the goal's planning files aren't on the branch it checks out, and asks whether to continue.

## [0.2.0] - 2026-09-30

Governance now checks what it reviewed and stays tied to it. See [Upgrading to 0.2.0](../../README.md#upgrading) before updating a project that already has goals.

### Breaking
- A goal that passed governance under 0.1.0 has no plan fingerprint. Its next task start, `state move in-progress` or completion is refused until `/aisdlc:govern <G-id>` runs again.
- Adding a task (`task new`) after governance passed resets the governance gate. `/aisdlc:implement` now finishes the current task, adds the extra work, and stops for a re-govern.
- Linking another ADR (`adr new --goal`, `adr link`) or changing the `adr none` reason after the adr gate passed resets the adr gate and every later gate.
- `task verify` needs `--evidence` when a task has no verify command and no `after_task` hook runs, instead of passing with nothing run.
- An invalid rule in `governance.md` (a duplicate ID, or an unknown severity, stage or check) now fails loudly. Before, an unknown severity quietly made the rule non-blocking.
- Archived reviews are named `governance-review.stale-N.md` instead of `governance-review.stale.md`.
- The script fails on unknown options (for example `--reson`) instead of ignoring them.

### Added
- Rules have **Stage** (`plan` or `final`) and **Check** columns. `init` seeds the five baseline rules with automatic checks: `goal-defined`, `tasks-verifiable`, `dag-valid` and `adr-recorded`. A review can't mark a rule `pass` or `n/a` while its check fails.
- Plan fingerprint: `gate set govern passed` records `govern_fingerprint`. Editing the goal, a task's planned fields or text, a linked ADR's status or a plan rule afterwards blocks the next task until the goal is re-governed. Ticked boxes, task Notes and task status don't count as edits.
- Final review: `/aisdlc:govern <G-id> --final` checks `final`-stage rules against the finished code and writes `governance-final.md`. When active final rules exist, `gate_final` must pass before a goal completes, and `/aisdlc:implement` runs the review itself. Any task change resets it.
- `governance list|add|set|checks` script commands. `/aisdlc:govern` now edits rules only through them, and `add` requires an explicit severity and stage.
- `templates/governance-catalog.md`: optional rules that `/aisdlc:govern` offers as choices (tests, secrets, stack standards, scope, docs, dependencies, sensitive areas, migrations, observability).
- `goal show` reports `gates.final`, `final_review_required`, and a `governance` summary that lists `should` rules that failed without blocking. `/aisdlc:implement` includes them in its completion summary.
- Commands that reset gates return `notes` saying what was reset and which command to re-run.
- `/aisdlc:create-goal` first checks for unfinished goals (pending, in-progress, blocked). It asks whether to merge the new description into a pending goal, finish an unfinished goal first, or create a separate goal. A merge reopens the goal's challenge and adr gates, so the new scope is clarified and decided before governance.
- Test that every `$AISDLC …` invocation written in a skill is still understood by the script.

### Fixed
- Archiving a review never overwrites an earlier archive.
- A `|` inside a governance rule's text no longer breaks the rules table.

## [0.1.0] - 2026-09-30

### Added
- Core workflow skills: `init`, `create-goal`, `challenge`, `adr`, `govern`, `implement`.
- `scripts/aisdlc.mjs`, which owns all state changes: ID allocation, goal state folders, the task DAG with waves ordered by risk, strict gates (challenge → adr → govern → implement), hooks resolved from env > config > stack > defaults, and generated `registry.md` and `tasks.md` views.
- Tasks become `done` only after `task verify` passes, which runs the verify command (or takes evidence for a `manual:` check) and the `after_task` hook.
- Governance gate backed by `governance-review.md`, with baseline rules GOV-01 to GOV-05 and no waiver.
- Every skill asks when something is unclear instead of assuming. `create-goal` starts with intake questions, and `challenge` asks one question at a time.
