# Changelog: goal

All notable changes to the `goal` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-04

### Added
- The `goal` plugin: its manifest and its entry in `aisdlc-marketplace`.
- Skill `goal-workflow`: triages every task as simple or complex with the user, and runs a complex one as a goal. A planner drafts ordered sub-tasks and finds the project's commands, a governor checks the plan against the project's instructions, and the user approves it and chooses the branch, how commits are made and how review fixes are handled. Each sub-task is then implemented, reviewed, checked against a commit gate and committed, one at a time, by role agents started fresh for it. Wherever the next step needs none of the session's context, the workflow stops for the user to clear the session and resumes from the ledger.
- A ledger template next to the skill. The ledger lives at `.agent-goals/<slug>.md` in the project and records the plan, the project commands, the test baseline, every decision and each sub-task's result.
