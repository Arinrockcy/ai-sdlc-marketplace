# Governance

Rules every goal must satisfy. Each rule has an ID so reviews can reference it.
Edit via `/aisdlc:govern` (no argument), which uses `aisdlc.mjs governance add|set`. Never delete or renumber a rule; set its severity to `retired` instead.

- **Severity:** `must` blocks the gate when it fails, `should` is reported but does not block, `retired` is no longer checked.
- **Stage:** `plan` rules are reviewed by `/aisdlc:govern <G-id>` before implementation. `final` rules are reviewed by `/aisdlc:govern <G-id> --final` against the finished work, before the goal completes.
- **Check:** an automatic check the script runs (`goal-defined`, `tasks-verifiable`, `dag-valid`, `adr-recorded`, `questions-resolved`, `criteria-met`), or `-`. A review cannot mark a rule `pass` or `n/a` while its check fails.

## Rules

| ID | Rule | Severity | Stage | Check |
|----|----|----|----|----|
| GOV-01 | Goal has a clear problem statement and measurable acceptance criteria. | must | plan | goal-defined |
| GOV-02 | Every task has its own acceptance criteria and a verify command (or a `manual: <check>` when no command exists). | must | plan | tasks-verifiable |
| GOV-03 | Task DAG is valid (no cycles, no unknown dependencies). | must | plan | dag-valid |
| GOV-04 | Architectural decisions are recorded as ADRs, or `adrs: none` has a reason. | must | plan | adr-recorded |
| GOV-05 | Open questions are resolved with the user, and the goal and tasks rest on no unconfirmed assumptions. | must | plan | questions-resolved |
| GOV-06 | The finished code meets every acceptance criterion of the goal and of each done task. | must | final | criteria-met |

## Definition of Done

The script enforces these:

- All tasks `done`, or `skipped` with a recorded reason.
- `task verify` passed for every done task (its verify command, or evidence when there is only a manual check or nothing to run, plus the `after_task` hook).
- If any `final` rule is active, the final review passed.

Anything else "done" has to mean belongs in a `final` rule, so it is actually checked.
