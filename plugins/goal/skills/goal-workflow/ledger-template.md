# Goal: <one-line goal>

- **Slug:** `<slug>`
- **Status:** draft | approved | in-progress | done | abandoned
- **Requested:** <YYYY-MM-DD>, source: <request or task document path>
- **Branch:** <branch name>, <new, created for this goal | the branch the goal started on>
- **Commits:** <automatic once a sub-task's gate holds | ask before each commit>
- **Fix loop:** <automatic, up to 2 rounds | ask after every review>
- **Plan approved by user:** <YYYY-MM-DD, or "not yet">

## Goal

<What done looks like, in two or three sentences. What is explicitly out of scope.>

## Project commands

Confirmed by the user <YYYY-MM-DD, or "not yet">. A command the project does not have is recorded as "none".

- **Test:** <command, or "none">
- **Lint:** <command, or "none">
- **Build:** <command, or "none">
- **Project validation:** <command, or "none">
- **Browser check:** <how a screen change is exercised, or "none">

## Test baseline

Recorded on `<commit>`: <tests already failing before any sub-task, "none failing", or "no test command">.

## Sub-tasks

Run strictly in this order, one at a time.

### 1. <title>

- **Status:** pending | in-progress | in-review | blocked | done | dropped
- **Scope:** <what changes>
- **Source document:** <task document this sub-task came from, or "none">
- **Areas:** <files, modules, packages>
- **Changes a screen:** yes | no
- **Depends on:** <sub-task numbers, or "none">
- **Acceptance:** <checks that prove it is done>
- **Governor notes:** <project rules that apply; work owned by another repository or owner>
- **Review:** <verdict, fix rounds used>
- **Verification:** <tests against the baseline, lint, build, project validation, browser check>
- **Commit:** <hash>
- **Task detail:** <appended to the source document, or written here when there is none>

## Decision log

| Date | Question | Decision | Sub-task |
|---|---|---|---|

## Deferred and open

- <work left out, with the reason and where it is tracked>
