---
name: implement
description: Implement a governed AI-SDLC goal task by task in dependency (DAG) order. Loads the project's stack standards skill, runs lifecycle hooks (before/after goal and task, on_block), verifies each task, and moves the goal through in-progress, blocked and completed. Use when the user runs /aisdlc:implement <goal-id>.
argument-hint: "<G-id> [--all]"
---

# aisdlc: implement

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. This holds in `--all` mode too: stop and ask.

Input: `$ARGUMENTS` is `<G-id>`, optionally followed by `--all`.

The script enforces the order:
- A goal only starts once governance passed. Each task start re-checks that the plan hasn't changed since then.
- A task only starts once its dependencies are done or skipped.
- A task can only be marked done after `task verify` passed.
- If governance.md has `final` rules, a goal only completes after the final review passed.

If a command refuses, show its message; don't work around it.

Once `pre_implement` has run, every way this run ends (a finished task in single mode, a blocked goal, a stop the user asked for, or a completed goal) finishes with `$AISDLC hooks run post_implement`.

## 1. Gate and setup
1. Run `$AISDLC gate require <G-id> implement`. If it exits non-zero, show the `problems` and stop. Never bypass the gate.
2. Run `$AISDLC hooks run pre_implement`, then `$AISDLC goal show <G-id>`.
3. **Resuming a blocked goal** (status `blocked`): if no task is blocked, the goal was reopened after a cancel. Ask the user whether to resume it. If they agree, run `$AISDLC state move <G-id> in-progress`. If the gate refuses because the plan changed, show the message, run `post_implement` and stop; the user runs `/aisdlc:govern <G-id>` first.
   Otherwise list each blocked task with its `reason`. Ask the user which blockers are resolved. For each resolved one, run `$AISDLC task set <G-id> <T-id> pending`, then run `$AISDLC state move <G-id> in-progress`.
   If none are resolved, ask whether to leave the goal blocked or cancel it. To cancel, ask the user why and pass their answer in their own words: `$AISDLC state move <G-id> cancelled --reason "<why>"`. Never write a reason for them. Either way, run `post_implement` and stop.
4. **First run** (status `pending`):
   1. **Auto-commit.** If `auto_commit` is empty, ask the user whether to commit automatically after each passing task. Save the answer with `$AISDLC goal set <G-id> auto_commit true|false`.
   2. **Before-goal hook.** Run `$AISDLC goal preflight <G-id>`. It shows what the hook will run (`before_goal`; by default it fetches, checks out and pulls the base branch). When the hook switches branches, `warnings` says whether another goal is in progress or whether the checkout would leave this goal's planning files behind. If there are warnings, show them and ask whether to continue or stop. Don't refuse: the user may work in separate worktrees.

      Then run `$AISDLC hooks run before_goal --goal <G-id>`. If it fails, show the output and ask the user whether to retry, continue anyway or stop.
      Then run `$AISDLC goal show <G-id>` again. If the goal is no longer found, its planning files were committed on a different branch than the one the hook switched to. Tell the user to bring `.aisdlc/` onto this branch (or disable the hook), and stop.
   3. **Branch.** If `branch` is empty, ask the user to pick one:
      - create the goal branch `suggested_branch` from `goal show` (`git checkout -b <suggested_branch>`)
      - stay on the current branch
      - use a branch name they provide
      Save the result with `$AISDLC goal set <G-id> branch <name>`. Never force a branch the user didn't choose.
   4. **Start.** Run `$AISDLC state move <G-id> in-progress`.
5. **Interrupted task.** If `progress.in_progress` from `goal show` is not empty, an earlier run stopped mid-task. For each such task, ask the user whether to resume it (continue from the current state of the code and go to step 2.3 for it) or reset it with `$AISDLC task set <G-id> <T-id> pending`.
6. **Stack standards.** Run `$AISDLC detect-stack`. If `standards_skill` is set (for example `aisdlc-nodejs:standards`), invoke that skill now and follow it for all code in this run. If it isn't set, follow the conventions already in the repo.
7. **Mode.** Run the whole goal if `$ARGUMENTS` contains `--all` or `$AISDLC config get implement.mode` returns `"auto"`. Otherwise run **one task**, then stop.

## 2. Task loop
Repeat these steps for each task:

1. **Pick.** Run `$AISDLC dag next <G-id>` and take the first ID in `ready`. The list is already sorted by wave, then risk.
2. **Start.** Run `$AISDLC task set <G-id> <T-id> in-progress`, then `$AISDLC hooks run before_task --goal <G-id> --task <T-id>`.
   If `task set` refuses because governance is pending or the plan changed after governance passed, show the message, run `post_implement` and stop. The user runs `/aisdlc:govern <G-id>`, then `/aisdlc:implement <G-id>` again.
3. **Implement** against the task's acceptance criteria and its linked ADRs.
   - Read only what the task needs. Run `$AISDLC graph query "<question>"` before searching broadly. It refreshes the graph when the code changed, including in earlier tasks, and says so when no graph is set up.
   - If the task, its acceptance criteria and its ADRs don't settle a choice you have to make (behavior, a public name, error handling, data shape), and the repo's conventions don't either, stop and ask the user. Record the answer in the task file's Notes.
   - Stay inside the task's scope. If you discover extra work, don't do it. Write it down and add it after this task is done (step 6). Adding a task resets governance, and a task can't be marked done while governance is pending.
4. **Verify.**
   - Run `$AISDLC task verify <G-id> <T-id>`. It runs the task's `verify` command and then the `after_task` hook (for example, the stack's test command), and records the result.
   - If `verify` is a manual check (`manual: …`), carry out the check first, then pass what you observed: `$AISDLC task verify <G-id> <T-id> --evidence "<what you checked and saw>"`.
   - Check every acceptance criterion honestly. A passing command doesn't excuse an unmet criterion; treat that as a failure.
5. **On failure,** show the failing output and ask the user to pick one:
   - **Retry:** fix the problem and go back to step 4.
   - **Skip:** run `$AISDLC task set <G-id> <T-id> skipped --reason "<why>"`.
   - **Block:** run `$AISDLC task set <G-id> <T-id> blocked --reason "<why>"`, then `$AISDLC hooks run on_block --goal <G-id> --task <T-id>`. Dependent tasks wait. Independent tasks can still run.
6. **On success:**
   - Tick the acceptance criteria in the task file.
   - Run `$AISDLC task set <G-id> <T-id> done`.
   - If `auto_commit` is true, commit now, so the commit includes the task's state. Stage only the files this task changed plus the `.aisdlc/` files the script updated (the task file, the goal's `tasks.md` and `registry.md`). Use the message `<G-id>/<T-id>: <task title>`.
   - **Extra work.** If you wrote down extra work in step 3, show it to the user and ask whether to add it as tasks. For each one they approve:
     1. Run `$AISDLC task new <G-id> "<title>" --risk … --depends … --verify "…"` and fill in the task file.
     2. Run `$AISDLC dag write <G-id>`.
     3. Relay the `notes` from `task new`: governance was reset, because a new task hasn't been reviewed.

     Then run `post_implement` and stop. The user runs `/aisdlc:govern <G-id>`, then `/aisdlc:implement <G-id>`.
7. **Check progress.** Read the `progress` object that `task set` returns:
   - `complete: true`: go to section 3.
   - `stuck: true` (only blocked or waiting tasks remain): run `$AISDLC state move <G-id> blocked`, report the blockers, run `post_implement` and stop.
   - Otherwise, in single mode, run `post_implement`, then stop and show the next ready task. In auto mode, continue the loop.

## 3. Complete the goal
All tasks are done or skipped at this point.
1. **Final review.** Run `$AISDLC goal show <G-id>`. If `final_review_required` is true and `gates.final` isn't `passed`, run the govern skill's final review (`/aisdlc:govern <G-id> --final`, Mode C) now. If it fails, show the Required Fixes, handle them as Mode C describes, run `post_implement` and stop.
2. Run `$AISDLC hooks run after_goal --goal <G-id>`. If it fails, show the output and ask the user whether to retry or finish anyway.
3. Run `$AISDLC state move <G-id> completed`. The goal completes automatically once every task passes and, if there are final rules, the final review passes. The registry updates itself.
4. Run `$AISDLC hooks run post_implement`. Summarize:
   - the tasks completed
   - any skipped tasks, with their reasons
   - the commits made
   - every `should` rule that failed without blocking, from `governance.plan.failed` and `governance.final.failed` in `goal show`, so the user sees them before moving on
