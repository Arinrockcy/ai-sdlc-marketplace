---
name: implement
description: Implement a governed AI-SDLC goal task by task in dependency (DAG) order. Loads the project's stack standards skill, runs lifecycle hooks (before/after goal and task, on_block), verifies each task, and moves the goal through in-progress, blocked and completed. Use when the user runs /aisdlc:implement <goal-id>.
argument-hint: "<G-id> [--all]"
---

# aisdlc: implement

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are named `<plugin>:<skill>` (`/aisdlc:govern`, `aisdlc-nodejs:nodejs-standards`); in an agent without plugin namespaces, such as GitHub Copilot, use only the `<skill>` part, both to load a skill and when you tell the user what to run (`/aisdlc:govern` is `/govern`, `aisdlc-nodejs:nodejs-standards` is `nodejs-standards`).

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. This holds in `--all` mode too: stop and ask.

Input: `$ARGUMENTS` (the text after the skill's name) is `<G-id>`, optionally followed by `--all`.

The script enforces the order:
- A goal only starts once governance passed. Each task start re-checks that the plan hasn't changed since then.
- A task only starts once its dependencies are done or skipped.
- A task can only be marked done after `task verify` passed and `task review` passed after it.
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
   1. **New stacks.** Run `$AISDLC detect-stack`. If `to_register` lists stacks, a stack plugin was installed after the plan was governed. Invoke each entry's `register_skill` (without plugin namespaces, the part after the `:`) now, before the goal starts, and skip one whose skill the agent doesn't have. The plan review didn't load that stack's standards, so tell the user and ask whether to continue or to run `/aisdlc:govern <G-id>` again first; if they choose governance, run `post_implement` and stop.
   2. **Auto-commit.** If `auto_commit` is empty, ask the user whether to commit automatically after each passing task. Save the answer with `$AISDLC goal set <G-id> auto_commit true|false`.
   3. **Before-goal hook.** Run `$AISDLC goal preflight <G-id>`. It shows what the hook will run (`before_goal`; by default it fetches, checks out and pulls the base branch). When the hook switches branches, `warnings` says whether another goal is in progress or whether the checkout would leave this goal's planning files behind. If there are warnings, show them and ask whether to continue or stop. Don't refuse: the user may work in separate worktrees.

      Then run `$AISDLC hooks run before_goal --goal <G-id>`. If it fails, show the output and ask the user whether to retry, continue anyway or stop.
      Then run `$AISDLC goal show <G-id>` again. If the goal is no longer found, its planning files were committed on a different branch than the one the hook switched to. Tell the user to bring `.aisdlc/` onto this branch (or disable the hook), and stop.
   4. **Branch.** If `branch` is empty, ask the user to pick one:
      - create the goal branch `suggested_branch` from `goal show` (`git checkout -b <suggested_branch>`)
      - stay on the current branch (on the base branch, the after-goal hook won't push: aisdlc never pushes the base branch)
      - use a branch name they provide
      Save the result with `$AISDLC goal set <G-id> branch <name>`. Never force a branch the user didn't choose.
   5. **Start.** Run `$AISDLC state move <G-id> in-progress`.
5. **Interrupted task.** If `progress.in_progress` from `goal show` is not empty, an earlier run stopped mid-task. For each such task, ask the user whether to resume it (continue from the current state of the code and go to step 2.3 for it) or reset it with `$AISDLC task set <G-id> <T-id> pending`.
6. **Stack standards.** Run `$AISDLC detect-stack`. Invoke every skill in `standards_skills` (for example `aisdlc-nodejs:nodejs-standards`) now, and follow each for the code of its stack in this run, except where the goal's `## Standards deviations` records a departure the user chose. If one isn't installed, tell the user that its stack plugin is missing or older than this workflow expects, and stop. If the list is empty, follow the conventions already in the repo. If the goal is already in progress and `to_register` lists stacks, a stack plugin was installed mid-goal: ask the user whether to register it now, so its gate applies to the remaining tasks, or after the goal.
7. **Mode.** Run the whole goal if `$ARGUMENTS` contains `--all` or `$AISDLC config get implement.mode` returns `"auto"`. Otherwise run **one task**, then stop.

## Roles
A task is worked by three roles. The explorer and the reviewer never edit the project.
- **task-explorer** (read-only): reads the task file, `goal.md`, the linked ADRs, the goal's `code-review.md` entries for this task and the current diff. It returns, per finding, what is wrong, where (file and line) and what to change, and puts anything the task and the ADRs don't settle under **Questions for the user**. It runs at the start of each fix round.
- **implementer**: applies the task, or the explorer's fix plan, inside the task's scope, and keeps the task file's Work log. It may be this session.
- **code-reviewer** (read-only on the project): reviews the diff as a reviewer would, not as its author: for each acceptance criterion it finds the code and the test or check that shows it is met (a criterion with nothing behind it is a defect), and looks for unhandled errors, missing edge cases, behavior changed outside the task, tests that can't fail and leftover debug code. It checks the diff against the task's ADRs and the stack standards, and that it stayed in scope. It reads the diff, not a summary of it. It records its verdict with `task review` (step 5), so a `pass` evidence cites files or tests, and "looks good" doesn't count.

Where your agent can hand work to a sub-agent, run the explorer and the reviewer as sub-agents. Where it can't, run each role in turn in this session. A sub-agent doesn't see this skill, the conversation or the skill's folder: give it the role text above, the goal ID and task ID, the task file's path, the stack standards you loaded, and the full `$AISDLC` command with the plugin folder written out as an absolute path. A role can't ask the user: it returns its questions under **Questions for the user**, and you ask them.

## 2. Task loop
Repeat these steps for each task:

1. **Pick.** Run `$AISDLC dag next <G-id>` and take the first ID in `ready`. The list is already sorted by wave, then risk.
2. **Start.** Run `$AISDLC task set <G-id> <T-id> in-progress`, then `$AISDLC hooks run before_task --goal <G-id> --task <T-id>`.
   If `task set` refuses because governance is pending or the plan changed after governance passed, show the message, run `post_implement` and stop. The user runs `/aisdlc:govern <G-id>`, then `/aisdlc:implement <G-id>` again.
3. **Implement** against the task's acceptance criteria and its linked ADRs.
   - Read only what the task needs. Run `$AISDLC graph query "<keywords>"` before searching broadly. It refreshes the graph when the code changed, including in earlier tasks, and says so when no graph is set up.
   - If the task, its acceptance criteria and its ADRs don't settle a choice you have to make (behavior, a public name, error handling, data shape), and the repo's conventions don't either, stop and ask the user. Record the answer in the task file's Notes.
   - Keep the task file's `## Work log` as you go: what you did, what failed and why, and what you discovered. Write plain bullets. Don't edit `## Review`, the script writes it.
   - Stay inside the task's scope. If you discover extra work, don't do it. Write it down in the Work log and add it after this task is done (step 7). Adding a task resets governance, and a task can't be marked done while governance is pending.
4. **Verify.**
   - Run `$AISDLC task verify <G-id> <T-id>`. It runs the task's `verify` command and then the `after_task` hook (for example, the stack's test command), and records the result.
   - If `verify` is a manual check (`manual: …`), carry out the check first, then pass what you observed: `$AISDLC task verify <G-id> <T-id> --evidence "<what you checked and saw>"`.
   - Check every acceptance criterion honestly. A passing command doesn't excuse an unmet criterion; treat that as a failure.
   - If verification fails, show the failing output and ask the user to pick one: **Retry** (fix the problem and verify again), **Skip** or **Block** (both as in step 6).
5. **Review.** Once verification passed, hand the task's change to the **code-reviewer** (see Roles). It records the result with `$AISDLC task review <G-id> <T-id> pass --evidence "<for each criterion, what shows it is met>"` or `$AISDLC task review <G-id> <T-id> fail --evidence "<the defects found, one per line, with file and line>"`. The script appends the round, with its full findings, to the goal's `code-review.md` and a one-line entry to the task's `## Review`, and prints `round` and `fails_in_a_row`. A task can't be marked done without a passing review. Running `task verify` again clears the review, so after any fix, verify and review again.
6. **Failed review: the fix loop.** On `fail`, read `fails_in_a_row` from the `task review` output and decide:
   - **Stuck.** If the defects the reviewer found are the ones the previous round already listed in `code-review.md` (a fix attempt changed nothing that matters), or the fixes keep breaking something else, stop the loop. Show the findings and ask the user to pick one: **Re-govern** (recommended: the task or its acceptance criteria may be wrong; run `$AISDLC gate set <G-id> govern pending`, then `post_implement`, and stop; the user runs `/aisdlc:govern <G-id>`, then `/aisdlc:implement <G-id>` resumes this task), **one more try**, **skip** or **block** (as below).
   - **Automatic retry.** If `fails_in_a_row` is 1 or 2, don't ask. Run one fix round: the **task-explorer** reads the findings and the code and returns a fix plan, the **implementer** applies it, then go back to step 4 (verify), and review again (step 5). At most 2 automatic retries.
   - **Ask the user.** If `fails_in_a_row` is 3 or more, the automatic retries are used up. Show the findings and ask how many more retries to run (0 stops the loop). Run that many fix rounds the same way without asking again, then ask again if the review still fails. If the user picks 0, ask whether to re-govern, skip or block.
   - A verify that fails inside the loop isn't a review failure: show its output and ask the user to pick retry, skip or block, as below.
   - **Skip:** run `$AISDLC task set <G-id> <T-id> skipped --reason "<why>"`.
   - **Block:** run `$AISDLC task set <G-id> <T-id> blocked --reason "<why>"`, then `$AISDLC hooks run on_block --goal <G-id> --task <T-id>`. Dependent tasks wait. Independent tasks can still run.
7. **On success:**
   - Tick the acceptance criteria in the task file, and make sure its Work log says what was done.
   - Run `$AISDLC task set <G-id> <T-id> done`.
   - If `auto_commit` is true, commit now, so the commit includes the task's state. Stage only the files this task changed plus the `.aisdlc/` files the script updated (the task file, the goal's `tasks.md` and `code-review.md`, and `registry.md`). Use the message `<G-id>/<T-id>: <task title>`.
   - **Extra work.** If you wrote down extra work in step 3, show it to the user and ask whether to add it as tasks. For each one they approve:
     1. Run `$AISDLC task new <G-id> "<title>" --risk … --depends … --verify "…"` and fill in the task file.
     2. Run `$AISDLC dag write <G-id>`.
     3. Relay the `notes` from `task new`: governance was reset, because a new task hasn't been reviewed.

     Then run `post_implement` and stop. The user runs `/aisdlc:govern <G-id>`, then `/aisdlc:implement <G-id>`.
8. **Check progress.** Read the `progress` object that `task set` returns:
   - `complete: true`: go to section 3.
   - `stuck: true` (only blocked or waiting tasks remain): run `$AISDLC state move <G-id> blocked`, report the blockers, run `post_implement` and stop.
   - Otherwise, in single mode, run `post_implement`, then stop and show the next ready task. In auto mode, continue the loop.

## 3. Complete the goal
All tasks are done or skipped at this point.
1. **Final review.** Run `$AISDLC goal show <G-id>`. If `final_review_required` is true and `gates.final` isn't `passed`, run the govern skill's final review (`/aisdlc:govern <G-id> --final`, Mode C) now. If it fails, show the Required Fixes, handle them as Mode C describes, run `post_implement` and stop.
2. **Uncommitted work.** Run `$AISDLC goal diff <G-id>`. If `uncommitted` or `untracked` isn't empty, tell the user that the goal's work isn't committed yet and that the after-goal hook only pushes commits. List the files, and ask whether to commit them now together with `.aisdlc/`. Never commit without asking.
3. **After-goal hook.** Run `$AISDLC hooks run after_goal --goal <G-id>`. By default it runs `coverage check`, then `goal push`, which pushes the goal's branch to `origin`. `goal push` refuses when the goal was built on the base branch: aisdlc never pushes the base branch. `coverage check` reads the report the stack manifest declares (`quality_gate.coverage_report`). It fails when the report is missing, is older than a file the goal changed, or falls below `quality_gate.coverage_thresholds`. If the hook fails, show the output and ask the user whether to retry, finish anyway or stop:
   - **Retry:** for a missing or out-of-date report, run `$AISDLC hooks run after_task --goal <G-id>` first to write it again. Coverage below a threshold needs more tests, which is new work: offer to add it as a task (section 2, step 7). Adding a task resets governance, so run `post_implement` and stop.
   - **Finish anyway:** go on to step 4, and name the failure in the summary. The hook stops at its first failing command, so after a failed coverage check the branch wasn't pushed. A refused `goal push` (the goal is on the base branch) is also a finish-anyway case: tell the user the branch wasn't pushed.
   - **Stop:** run `post_implement` and stop. The goal stays in progress.
4. Run `$AISDLC state move <G-id> completed`. The goal completes automatically once every task passes and, if there are final rules, the final review passes. The registry updates itself.
5. **Completion state.** Completing the goal moves its folder and updates the registry in `.aisdlc/`, after the hook ran. Ask the user whether to commit these changes (`<G-id>: complete`), then whether to push the branch with `$AISDLC goal push <G-id>`, so the remote has the completed goal. Skip the push question when the goal was built on the base branch, because `goal push` refuses it. Never commit or push without asking.
6. Run `$AISDLC hooks run post_implement`. Summarize:
   - the tasks completed
   - any skipped tasks, with their reasons
   - the commits made, or the work left uncommitted
   - whether the branch was pushed, and the coverage figures from `coverage check` (or why it failed, if the user finished anyway)
   - every `should` rule that failed without blocking, from `governance.plan.failed` and `governance.final.failed` in `goal show`, so the user sees them before moving on
