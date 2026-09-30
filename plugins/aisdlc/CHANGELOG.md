# Changelog: aisdlc

All notable changes to the `aisdlc` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0.0, a minor version may include breaking changes; each one is listed under **Breaking** with its upgrade step.

## [0.6.1] - 2026-09-30

### Fixed
- `task verify` records the test count for node:test's default spec reporter (`ℹ tests 21`), not only its TAP output (`# tests 21`). Before, `verify_evidence` for a node:test suite held only the exit codes.

## [0.6.0] - 2026-09-30

Fixes from a dogfood run, in which a plan review took seven rounds to pass. Reviews now separate questions for the user from real defects, carry earlier answers forward, and see the stack's standards at plan time. See [Upgrading to 0.6.0](../../README.md#upgrading) for a review that hasn't passed yet.

### Breaking
- `gate set govern|final passed` refuses a review row with more than three cells. A literal `|` in a note has to be written as `\|`. Before, the text after it was silently dropped.

### Added
- `task edit <G-id> <T-id> title|depends|risk|verify <value>` changes a task's planned fields. It validates the DAG, renames the file with the title, clears the verify result when the command changes, and resets governance.
- `task remove <G-id> <T-id> --reason "<why>"` removes a task before the goal starts. It refuses while another task depends on it, logs the removal under `## Removed tasks` in `goal.md`, and resets governance.
- `goal diff <G-id>` returns the goal's `committed` changes (`<base>...<branch>`), plus `uncommitted` and `untracked` files outside `.aisdlc/`. `warnings` says when no branch is recorded, the goal was built on the base branch, or the current branch isn't the goal's branch.
- `gate set <G-id> govern|final pending` and `governance review` return `stale_reviews`, the earlier reviews oldest first.
- `gate set <G-id> govern|final passed|failed` returns `checked`, `warnings`, `questions` and `readings`. For `failed`, the review is checked the same way as for `passed`, and its problems come back as `warnings` instead of a refusal. `goal show` includes a failed review's `questions`.
- The review template has `## Questions for the user` and `## Readings` sections. The goal template has an optional `## Standards deviations` section.
- `dag write` returns `warnings`, also written to `tasks.md`, when tasks in the same wave list the same file under Files.
- `task verify` records a one-line summary in `verify_evidence`: each command, its exit code and the test count it printed. Manual evidence is kept, followed by the summary of the `after_task` hook.
- `goal show` returns `next_hint` once every task is done: whether `/aisdlc:implement` still runs the final review or only completes the goal.
- Catalog rule: a `plan`-stage companion to Stack standards. The plan's tasks carry the criteria the standards skill requires, or the goal records the user's deviation.
- `goal preflight` warns when `.aisdlc/stacks/<stack>.json` has uncommitted changes, so a manifest edit stays out of the goal's changes.

### Changed
- `/aisdlc:govern <G-id>` defines when the unconfirmed-assumptions rule (GOV-05) fails: an open question about behavior inside Scope (In), or a contradiction between the goal, tasks, ADRs and standards. Other edge cases and implementation details go under Readings. Questions go under Questions for the user, and the session that started the review asks them and records the answers under Clarifications. The reviewer reads the latest archived review, treats Clarifications and Standards deviations as settled, and loads the stack's standards skill.
- `/aisdlc:govern <G-id> --final` reviews `goal diff` (committed, uncommitted and untracked changes together), cites `verify_evidence`, and lets a recorded standards deviation take precedence over the standards skill.
- `/aisdlc:govern` (no argument) offers the catalog by topic first, then asks about what it doesn't cover. Before, it asked about topics and then offered the catalog, which covered the same ground.
- `/aisdlc:create-goal` and `/aisdlc:challenge` load the stack's standards skill before splitting tasks, add the criteria it implies, and ask about conflicts with the repo. `/aisdlc:challenge` changes tasks with `task edit` and `task remove`, and re-checks task criteria after a goal criterion changes. `/aisdlc:implement` follows recorded standards deviations.
- `/aisdlc:implement` asks whether to commit the goal's work after completing it, when auto-commit is off and `goal diff` shows uncommitted files.
- Skills write `graph query "<keywords>"` and say to pass identifiers, not a sentence: Graphify matches node names, not prose. When nothing matches, `graph query` suggests retrying with identifiers.
- `governance review --stage final` leaves the `criteria-met` row empty and returns `to_check` (for example "1 goal and 2 task criteria to check"). Before, it pre-filled the row as `fail` with every unticked criterion, although criteria start unticked by design. `gate set final passed` still runs the check.
- `task verify` prints each command's output when it finishes, instead of streaming it, so the output can be summarized.

### Fixed
- `task new` never reuses a removed task's ID. IDs come from the existing tasks and the Removed tasks log.
- `init` lists `registry.md` and `registry-archive.md` in `created`.
- Editing `.gitignore`, `.gitattributes` or `.editorconfig` no longer makes the code graph stale.

## [0.5.1] - 2026-09-30

### Added
- `graph setup` and `graph update` return Graphify's warnings as `warnings`, and `graph status` shows those from the last build. They name files left out of the graph, for example SQL files when Graphify's `sql` extra isn't installed. `/aisdlc:init` shows them and offers the install.
- `graph query` adds "search the code directly" when nothing in the graph matches. The graph holds code structure, not data fields or text, so a miss is common.

### Changed
- `graph setup` always rebuilds the graph, so running it again after installing a Graphify extra picks up the files it can now parse.

### Fixed
- An edit that changes no symbol or edge in the code graph (a comment, or a change inside a function body) no longer leaves the graph stale for good. Graphify leaves `graph.json` untouched in that case because the graph is still current. `graph update` used to take that as a refused write: it warned, and every later `graph query` ran the rebuild again (about 1.7 s on a 100-file repo). Now it marks the graph fresh.

## [0.5.0] - 2026-09-30

Work the agent used to do by hand now happens in the script, where it costs no tokens. Graphify is driven by the script as a token saver only: code-only, with no model calls, and refreshed automatically. See [Upgrading to 0.5.0](../../README.md#upgrading) if the project uses Graphify.

### Breaking
- `graph.path` is no longer supported. Graphify's `update` can only write `graphify-out/` in the project root, so `graph` commands fail while `graph.path` names another directory. Remove it from `.aisdlc/config.json`.

### Added
- `graph status` reports whether Graphify is installed and new enough (it needs `update`, `query` and `--budget`), whether `.aisdlc/` is kept out of the graph, and whether the graph is stale.
- `graph setup` adds `.aisdlc/` to `.graphifyignore`, sets `graph.provider` to `graphify`, and builds the graph with `graphify update .`: local parsing, no model calls, no API key.
- `graph update` rebuilds the graph only when the code changed. It compares a fingerprint of file contents, so committing code already in the graph, or changing `.aisdlc/`, doesn't trigger a rebuild. If Graphify leaves the graph untouched, the graph stays marked stale and a warning says so.
- `graph query "<question>" [--budget N]` refreshes a stale graph, then answers from it within a token budget (default 1500). Without a graph, or when Graphify is missing or fails, it says so and exits 0, so the workflow falls back to searching the code instead of stopping.
- `registry search <keywords>` returns the matching rows of `registry.md` and `registry-archive.md`, best match first. It replaces reading or grepping the archive, and works where `grep` doesn't.
- `goal preflight <G-id>` shows what `before_goal` runs and warns when it switches branches while another goal is in progress, or away from planning files committed only on the current branch.
- `governance review <G-id> [--stage plan|final]` writes the review file with one row per active rule, fills in rules whose automatic check failed, and returns each rule's text and check result.
- `goal list` and `goal show` return `next`: the step that moves the goal on (`challenge`, `adr`, `govern`, `implement` or `reopen`).

### Changed
- `/aisdlc:init` checks and sets up Graphify through `graph status` and `graph setup`, instead of `graphify install` and `/graphify .`.
- `/aisdlc:create-goal`, `/aisdlc:adr`, `/aisdlc:challenge`, `/aisdlc:implement` and `/aisdlc:govern --final` look up code with `graph query`. `/aisdlc:implement` and `/aisdlc:create-goal` no longer ask about rebuilding the graph.
- `/aisdlc:create-goal` uses `registry search` and the `next` field. `/aisdlc:implement` uses `goal preflight` in place of its own git checks. `/aisdlc:govern` fills in the file that `governance review` writes, in place of `governance list`, `governance checks` and the template.

## [0.4.0] - 2026-09-30

Skills read less as a project grows. Before, `/aisdlc:create-goal` read the whole registry and listed every goal, about 64k tokens at 500 goals, most of it finished work. See [Upgrading to 0.4.0](../../README.md#upgrading) if anything outside the workflow reads `registry.md`.

### Breaking
- `registry.md` lists only unfinished goals (`pending`, `in-progress`, `blocked`) and every ADR. Completed and cancelled goals move to the new `registry-archive.md`, which skills search instead of reading whole.
- The registry's Path column is gone. `goal show <G-id>` gives a goal's folder, and ADR files are `adr/<ADR-id>-*.md`. `registry sync` returns `rows`, `archived`, `file` and `archive` instead of a single row count.

### Added
- `goal list --status` takes several comma-separated states (`--status pending,in-progress,blocked`) and fails on an unknown state, which used to match nothing.
- `adr list [--status …]` lists ADRs as JSON with their ID, title, status, goals and file, for tooling. Skills read the ADR rows in `registry.md`, which are about half the size.
- `registry.md` says where the rest lives: the archive, each goal's folder and tasks, and `governance.md`.

### Changed
- `/aisdlc:create-goal` lists only unfinished goals and searches the archive for overlapping finished goals. It queries the graph instead of reading `GRAPH_REPORT.md` whole.
- `/aisdlc:adr` opens only the ADRs whose registry rows bear on the goal. With Graphify, it queries the graph for the modules a decision touches.
- `/aisdlc:challenge` checks the accepted ADRs in `registry.md` and, with Graphify, the graph before asking something an earlier decision or the code already answers.
- `/aisdlc:govern --final` starts from the goal's diff and queries the graph for code outside it, but cites the files themselves.

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
