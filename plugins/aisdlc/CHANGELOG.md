# Changelog: aisdlc

All notable changes to the `aisdlc` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0.0, a minor version may include breaking changes; each one is listed under **Breaking** with its upgrade step.

## [0.2.0] - 2026-09-30

Governance now checks what it reviewed and stays tied to it. See [Upgrading to 0.2.0](../../README.md#upgrading) before updating a project that already has goals.

### Breaking
- A goal that passed governance under 0.1.0 has no plan fingerprint. Its next task start, `state move in-progress` or completion is refused until `/aisdlc:govern <G-id>` runs again.
- Adding a task (`task new`) after governance passed resets the governance gate. `/aisdlc:implement` now finishes the current task, adds the extra work, and stops for a re-govern.
- Linking another ADR (`adr new --goal`, `adr link`) or changing the `adr none` reason after the adr gate passed resets the adr gate and every later gate.
- `task verify` needs `--evidence` when a task has no verify command and no `after_task` hook runs, instead of passing with nothing run.
- An invalid rule in `governance.md` (a duplicate ID, or an unknown severity, stage or check) now fails loudly. Before, an unknown severity quietly made the rule non-blocking.
- Archived reviews are named `governance-review.stale-N.md` instead of `governance-review.stale.md`.

### Added
- Rules have **Stage** (`plan` or `final`) and **Check** columns. `init` seeds the five baseline rules with automatic checks: `goal-defined`, `tasks-verifiable`, `dag-valid` and `adr-recorded`. A review can't mark a rule `pass` or `n/a` while its check fails.
- Plan fingerprint: `gate set govern passed` records `govern_fingerprint`. Editing the goal, a task's planned fields or text, a linked ADR's status or a plan rule afterwards blocks the next task until the goal is re-governed. Ticked boxes, task Notes and task status don't count as edits.
- Final review: `/aisdlc:govern <G-id> --final` checks `final`-stage rules against the finished code and writes `governance-final.md`. When active final rules exist, `gate_final` must pass before a goal completes, and `/aisdlc:implement` runs the review itself. Any task change resets it.
- `governance list|add|set|checks` script commands. `/aisdlc:govern` now edits rules only through them, and `add` requires an explicit severity and stage.
- `templates/governance-catalog.md`: optional rules that `/aisdlc:govern` offers as choices (tests, secrets, stack standards, scope, docs, dependencies, sensitive areas, migrations, observability).
- `goal show` reports `gates.final`, `final_review_required`, and a `governance` summary that lists `should` rules that failed without blocking. `/aisdlc:implement` includes them in its completion summary.
- Commands that reset gates return `notes` saying what was reset and which command to re-run.

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
