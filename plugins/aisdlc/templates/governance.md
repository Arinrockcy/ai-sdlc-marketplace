# Governance

Rules every goal must satisfy before `/aisdlc:implement`. Each rule has an ID so reviews can reference it.
Edit via `/aisdlc:govern` (no argument). Severity is `must`, `should` or `retired`. Never delete or renumber a rule; set it to `retired` instead.

## Rules

| ID | Rule | Severity |
|----|------|----------|
| GOV-01 | Goal has a clear problem statement and measurable acceptance criteria. | must |
| GOV-02 | Every task has its own acceptance criteria and a verify command (or a `manual: <check>` when no command exists). | must |
| GOV-03 | Task DAG is valid (no cycles, no unknown dependencies). | must |
| GOV-04 | Architectural decisions are recorded as ADRs, or `adrs: none` has a reason. | must |
| GOV-05 | Open questions from /challenge are resolved. | must |

## Definition of Done

- All tasks `done` (or `skipped` with a recorded reason).
- `task verify` passed for every done task (its verify command, or manual evidence, plus the `after_task` hook).
