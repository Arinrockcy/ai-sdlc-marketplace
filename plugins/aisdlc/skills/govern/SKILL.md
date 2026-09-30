---
name: govern
description: Manage AI-SDLC governance. With no argument, create or update the project's governance rules (.aisdlc/governance.md). With a goal ID, run the plan review that /aisdlc:implement requires. With a goal ID and --final, run the final review of the finished work that goal completion requires. Use when the user runs /aisdlc:govern.
argument-hint: "[G-id] [--final]"
---

# aisdlc: govern

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. If a rule's wording leaves unclear how it applies to this goal, ask the user how to read it and record that reading in the Notes column.

Run `$AISDLC hooks run post_govern` last in every mode.

Each rule in `.aisdlc/governance.md` has:
- an ID (`GOV-NN`)
- a **severity**: `must` blocks, `should` is reported but doesn't block, `retired` is off
- a **stage**: `plan` rules are reviewed before implementation, `final` rules against the finished work
- an optional **check**: an automatic check the script runs (`goal-defined`, `tasks-verifiable`, `dag-valid`, `adr-recorded`, `questions-resolved` or `criteria-met`)

**Review with fresh eyes.** In Modes B and C, if your agent can hand work to a sub-agent or a fresh session, run the review there. Give it the goal ID and the steps of that mode, not your own reasoning about the plan. A review by the context that wrote the plan tends to confirm it.

The script owns the rules table. Change it only through the `governance add` and `governance set` commands (Mode A), never by editing the table by hand.

## Mode A: no argument (edit the rules)
1. Run `$AISDLC hooks run pre_govern`, then `$AISDLC governance list`. `init` seeds the baseline rules GOV-01 to GOV-05 (`must`, `plan`) and GOV-06 (`must`, `final`, check `criteria-met`). If the list fails, the file has an invalid rule (a duplicate ID, or an unknown severity, stage or check). Show the error and ask the user how to fix it.
   Projects initialized before aisdlc 0.3.0 lack two baseline checks. If no active rule uses `questions-resolved`, offer to set it on the rule about open questions (GOV-05 in the baseline). If no active rule uses `criteria-met`, tell the user that nothing checks the finished code against its acceptance criteria and offer that rule (`final`, check `criteria-met`). Change nothing they don't accept.
2. Ask the user, one question at a time, what to add or change. Topics: coding standards, security and compliance, testing, review or approval needs, performance budgets, and what "done" means.
3. Offer the optional rules in `${CLAUDE_PLUGIN_ROOT}/templates/governance-catalog.md` that aren't already covered. Present them as choices, and let the user pick, reword and set severity and stage for each one. Never add a rule the user didn't choose.
4. If a stack is active (`$AISDLC detect-stack` returns `standards_skill`), suggest a rule that points at that skill (for example "Code follows `aisdlc-nodejs:standards`", stage `final`) instead of copying its content.
5. For each agreed change:
   - Add a rule: `$AISDLC governance add "<rule>" --severity must|should --stage plan|final [--check <name>]`. Ask the user which severity and stage they want. The script refuses to guess them.
   - Change a rule: `$AISDLC governance set <GOV-id> rule|severity|stage|check <value>`.
   - Remove a rule: `$AISDLC governance set <GOV-id> severity retired`. IDs are never deleted or renumbered, because reviews reference them.
   - Put anything that "done" has to mean in a `final` rule. That is what makes it checked.
6. Tell the user that changing a `plan` rule makes the plan review of every goal it applies to stale. Those goals have to be re-governed before their next task starts.

## Mode B: `<G-id>` (the plan review)
1. Run `$AISDLC gate require <G-id> govern`. If it exits non-zero, show the `problems` and stop. Otherwise run `$AISDLC hooks run pre_govern`.
2. Run `$AISDLC gate set <G-id> govern pending`. This starts a fresh review and archives any earlier `governance-review.md` as `governance-review.stale-N.md`. Use the archived reviews only as a reference, and review every rule again.
3. Run `$AISDLC governance review <G-id>`. It writes `governance-review.md` with one row per active plan rule and returns each rule's text and automatic check result. A rule whose check failed is already filled in as `fail`, with the check's problems in Notes. Then read `goal.md`, the task files and the linked ADRs.
4. Check each active plan rule strictly, and base every result on evidence in the files:
   - `pass`
   - `fail`, with a concrete reason and the fix
   - `n/a`, with a reason

   Every result needs a note. For `pass`, cite the evidence: the file and section, task or ADR that shows the rule holds. "Looks fine" is not evidence. A rule whose automatic check failed stays `fail`; add the fix to its Notes. A passing check only proves structure (for example, that criteria exist). Still judge the content yourself.
5. Fill in `governance-review.md`: the Result (`pass`, `fail` or `n/a`) and Notes of every empty row, with the evidence for `pass` or the reason for `fail` and `n/a`. The script refuses a row without a note. Don't add or remove rows.

   Add a Required Fixes list. Set `result: pass` only if no `must` rule failed. A failed `should` rule is listed but doesn't block.
6. Set the gate. The script re-checks the review: it refuses `passed` if an active rule is missing, a `must` rule failed, any row has no note, or a rule is marked `pass`/`n/a` while its automatic check fails.
   - **Pass:** run `$AISDLC gate set <G-id> govern passed`. The script records a fingerprint of the plan. Editing the goal, a task's planned fields or text, a linked ADR's status or a plan rule later makes the review stale, and adding a task resets the gate. Either way the goal has to be re-governed before the next task starts. Ticking boxes, task Notes and task status don't count as edits. The next step is `/aisdlc:implement <G-id>`.
   - **Fail:** run `$AISDLC gate set <G-id> govern failed`. Show the Required Fixes and point to the command that addresses each one: `/aisdlc:challenge` for unclear requirements, `/aisdlc:adr` for missing decisions, or an edit to the named task. The user then re-runs `/aisdlc:govern <G-id>`.

## Mode C: `<G-id> --final` (the final review)
Runs once every task is done or skipped, and only when governance.md has active `final` rules (`goal show` reports `final_review_required`). `/aisdlc:implement` runs this mode itself before it completes a goal.
1. Run `$AISDLC gate require <G-id> final`. If it exits non-zero, show the `problems` and stop. Otherwise run `$AISDLC hooks run pre_govern`.
2. Run `$AISDLC gate set <G-id> final pending`. This archives any earlier `governance-final.md`.
3. Gather these inputs:
   - `$AISDLC governance review <G-id> --stage final`. It writes `governance-final.md` with one row per active final rule, returns each rule's text and check result, and fills in rules whose check failed as `fail`.
   - `$AISDLC goal show <G-id>`, `goal.md`, the task files (including their Notes and `verify_evidence`) and the linked ADRs
   - the goal's changes. Use the diff between the goal's `branch` and `git.base_branch` (`$AISDLC config get git.base_branch`, default `develop`). If the goal was built on a branch shared with other work, or no branch was recorded, ask the user which commits or range belong to this goal. Don't guess.
4. Check each active final rule against the actual code. Cite files and lines as evidence. To find the code a rule concerns, start from the diff. For code outside it, run `$AISDLC graph query "<question>"` rather than searching broadly, and cite the files themselves, not the graph. If a rule names a skill (for example a stack's standards skill), load that skill and check against it.
   For a rule with the `criteria-met` check, go through each acceptance criterion in `goal.md` and in every done task. Tick a criterion (`- [x]`) only when the code shows it is met, and cite where. Untick any task criterion that turns out not to be met. The check fails while any criterion of the goal or a done task is unticked, so the rule must then be `fail`.
5. Fill in `governance-final.md` and its Required Fixes the same way as in Mode B.
6. Set the gate:
   - **Pass:** run `$AISDLC gate set <G-id> final passed`. The goal can now complete.
   - **Fail:** run `$AISDLC gate set <G-id> final failed`. Show the Required Fixes and ask the user how to handle each one:
     - add a fix task with `$AISDLC task new <G-id> "<title>" --risk … --verify "…"`. This resets the plan review, so the goal is re-governed before the task runs.
     - stop so they can fix it themselves.

     Either way, the final review runs again afterwards. Any task change resets the final gate.

There is no waiver in any mode. A failed `must` rule blocks until it is fixed.
