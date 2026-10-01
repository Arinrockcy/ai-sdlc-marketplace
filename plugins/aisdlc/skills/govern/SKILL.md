---
name: govern
description: Manage AI-SDLC governance. With no argument, create or update the project's governance rules (.aisdlc/governance.md). With a goal ID, run the plan review that /aisdlc:implement requires. With a goal ID and --final, run the final review of the finished work that goal completion requires. Use when the user runs /aisdlc:govern.
argument-hint: "[G-id] [--final]"
---

# aisdlc: govern

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are written `/<plugin>:<skill>`; in an agent without plugin namespaces, such as GitHub Copilot, call them `/<skill>` (`/aisdlc:govern` is `/govern`).

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. If a rule's wording leaves unclear how it applies to this goal, ask the user how to read it and record that reading in the Notes column.

Run `$AISDLC hooks run post_govern` last in every mode.

Each rule in `.aisdlc/governance.md` has:
- an ID (`GOV-NN`)
- a **severity**: `must` blocks, `should` is reported but doesn't block, `retired` is off
- a **stage**: `plan` rules are reviewed before implementation, `final` rules against the finished work
- an optional **check**: an automatic check the script runs (`goal-defined`, `tasks-verifiable`, `dag-valid`, `adr-recorded`, `questions-resolved` or `criteria-met`)

**Review with fresh eyes.** In Modes B and C, if your agent can hand work to a sub-agent or a fresh session, run the review there. Give it the goal ID and the steps of that mode, not your own reasoning about the plan. A review by the context that wrote the plan tends to confirm it. The reviewer can't ask the user, so it writes what it would ask under `## Questions for the user` in the review file. The session that started the review asks them once the gate is set (Mode B step 6).

The script owns the rules table. Change it only through the `governance add` and `governance set` commands (Mode A), never by editing the table by hand.

## Mode A: no argument (edit the rules)
1. Run `$AISDLC hooks run pre_govern`, then `$AISDLC governance list`. `init` seeds the baseline rules GOV-01 to GOV-05 (`must`, `plan`) and GOV-06 (`must`, `final`, check `criteria-met`). If the list fails, the file has an invalid rule (a duplicate ID, or an unknown severity, stage or check). Show the error and ask the user how to fix it.
   Projects initialized before aisdlc 0.3.0 lack two baseline checks. If no active rule uses `questions-resolved`, offer to set it on the rule about open questions (GOV-05 in the baseline). If no active rule uses `criteria-met`, tell the user that nothing checks the finished code against its acceptance criteria and offer that rule (`final`, check `criteria-met`). Change nothing they don't accept.
2. Offer the optional rules in `${CLAUDE_PLUGIN_ROOT}/templates/governance-catalog.md` that aren't already covered, grouped by topic. Present them as choices, and let the user pick, reword and set severity and stage for each one. Never add a rule the user didn't choose.
   If a stack is active (`$AISDLC detect-stack` returns `standards_skill`), offer the catalog's two Stack standards rules, pointing at that skill (for example "Code follows `aisdlc-nodejs:standards`", stage `final`) instead of copying its content. The `plan` one catches a plan that can't meet the standard before any code is written.
3. Then ask, one question at a time, about anything the catalog doesn't cover that the project needs: coding standards, security and compliance, testing, review or approval needs, performance budgets, and what "done" means.
4. For each agreed change:
   - Add a rule: `$AISDLC governance add "<rule>" --severity must|should --stage plan|final [--check <name>]`. Ask the user which severity and stage they want. The script refuses to guess them.
   - Change a rule: `$AISDLC governance set <GOV-id> rule|severity|stage|check <value>`.
   - Remove a rule: `$AISDLC governance set <GOV-id> severity retired`. IDs are never deleted or renumbered, because reviews reference them.
   - Put anything that "done" has to mean in a `final` rule. That is what makes it checked.
5. Tell the user that changing a `plan` rule makes the plan review of every goal it applies to stale. Those goals have to be re-governed before their next task starts.

## Mode B: `<G-id>` (the plan review)
1. Run `$AISDLC gate require <G-id> govern`. If it exits non-zero, show the `problems` and stop. Otherwise run `$AISDLC hooks run pre_govern`.
2. Run `$AISDLC gate set <G-id> govern pending`. This starts a fresh review and archives any earlier `governance-review.md` as `governance-review.stale-N.md`. Its `stale_reviews` lists the archived reviews, oldest first.
3. Run `$AISDLC governance review <G-id>`. It writes `governance-review.md` with one row per active plan rule and returns each rule's text and automatic check result. A rule whose check failed is already filled in as `fail`, with the check's problems in Notes. Then read:
   - `goal.md`, including Clarifications and Standards deviations. Both are the user's answers: treat them as settled.
   - the task files and the linked ADRs
   - the last review in `stale_reviews`, if there is one. Check that its Required Fixes were addressed, and don't raise again what the user has since answered under Clarifications. Still review every rule again.
   - the stack's standards: if `$AISDLC detect-stack` returns `standards_skill`, load that skill. Check that the plan can meet it: the tasks carry the criteria it requires (for example declaration files, test layers, lint and coverage), or the goal records the user's deviation. A plan that can't meet the standard is a finding now, not at the final review.
4. Check each active plan rule strictly, and base every result on evidence in the files:
   - `pass`
   - `fail`, with a concrete reason and the fix
   - `n/a`, with a reason

   Every result needs a note. For `pass`, cite the evidence: the file and section, task or ADR that shows the rule holds. "Looks fine" is not evidence. A rule whose automatic check failed stays `fail`; add the fix to its Notes. A passing check only proves structure (for example, that criteria exist). Still judge the content yourself.

   **Unconfirmed assumptions** (GOV-05 in the baseline, the rule with the `questions-resolved` check). Fail it only for:
   - a question about behavior inside Scope (In) that the goal, tasks, ADRs, Clarifications and standards leave open, and that only the user can answer
   - a contradiction between the goal, the tasks, the ADRs and the standards

   Edge cases outside Scope (In), and details the implementer may reasonably settle within the criteria (an internal name, a private structure, how a test controls the clock), are not a fail. List them under `## Readings`: one `- ` item each, saying how you read the detail. Write each question for the user under `## Questions for the user` as a `- ` item the user can answer directly, with the options you see. Don't answer them yourself. The rule's note then points to the Questions section.
5. Fill in `governance-review.md`: the Result (`pass`, `fail` or `n/a`) and Notes of every empty row, with the evidence for `pass` or the reason for `fail` and `n/a`. The script refuses a row without a note. Don't add or remove rows. A literal `|` in a note breaks the table: write it as `\|`.

   Add a Required Fixes list for fixes other than the questions. Set `result: pass` only if no `must` rule failed. A failed `should` rule is listed but doesn't block.
6. Set the gate. The script re-checks the review for both results and returns `checked`, `warnings`, `questions` and `readings`. It refuses `passed` if an active rule is missing, a `must` rule failed, a row has no note or too many cells, or a rule is marked `pass`/`n/a` while its automatic check fails. For `failed`, those problems come back as `warnings`: fix the review file and set the gate again.
   - **Pass:** run `$AISDLC gate set <G-id> govern passed`. The script records a fingerprint of the plan. Editing the goal, a task's planned fields or text, a linked ADR's status or a plan rule later makes the review stale, and adding a task resets the gate. Either way the goal has to be re-governed before the next task starts. Ticking boxes, task Notes and task status don't count as edits. Show the user the `readings`, so they see how the reviewer read the details it left to the implementer. If they disagree with one, record their answer under Clarifications and run `/aisdlc:govern <G-id>` again, because that edits the goal. The next step is `/aisdlc:implement <G-id>`.
   - **Fail:** run `$AISDLC gate set <G-id> govern failed`. Then, in the session that started the review:
     1. **Questions.** Ask the user each of the `questions`, one at a time. Record each answer under `## Clarifications` in `goal.md` as `- **Q:** … **A:** …`, and update the goal sections and tasks it affects.
     2. **Readings.** Show the `readings` and ask the user to confirm or correct them, in one question (a multi-select works). Record each confirmed or corrected reading under Clarifications the same way, so the next reviewer treats it as settled.
     3. **Other fixes.** Show the Required Fixes and point to what addresses each one: `/aisdlc:adr` for a missing decision, or a change to the named task (`$AISDLC task edit <G-id> <T-id> verify "<command>"`, `task new` or `task remove`, as `/aisdlc:challenge` describes), or to its file. After changing a goal criterion, check that the task criteria still match it, so the change doesn't pull new files or behavior into scope.
     4. If the questions were the only fixes, run `/aisdlc:govern <G-id>` again now. Otherwise the user re-runs it once the fixes are made.

## Mode C: `<G-id> --final` (the final review)
Runs once every task is done or skipped, and only when governance.md has active `final` rules (`goal show` reports `final_review_required`). `/aisdlc:implement` runs this mode itself before it completes a goal.
1. Run `$AISDLC gate require <G-id> final`. If it exits non-zero, show the `problems` and stop. Otherwise run `$AISDLC hooks run pre_govern`.
2. Run `$AISDLC gate set <G-id> final pending`. This archives any earlier `governance-final.md`.
3. Gather these inputs:
   - `$AISDLC governance review <G-id> --stage final`. It writes `governance-final.md` with one row per active final rule, returns each rule's text and check result, and fills in rules whose check failed as `fail`. The `criteria-met` row is left empty for you, and `to_check` says how many criteria there are.
   - `$AISDLC goal show <G-id>`, `goal.md` (including Clarifications and Standards deviations), the task files and the linked ADRs. Each task's `verify_evidence` records what its verify ran, each command's exit code and the test count. Cite it rather than running the commands again, unless a rule needs more than their result.
   - the goal's changes: `$AISDLC goal diff <G-id>`. Review `committed` (the goal's branch against the base branch), `uncommitted` and `untracked` together: with auto-commit off, the work may not be committed yet. If `warnings` says no branch was recorded, the goal was built on the base branch, or the current branch isn't the goal's branch, ask the user which commits and files belong to this goal. Don't guess.
4. Check each active final rule against the actual code. Cite files and lines as evidence. To find the code a rule concerns, start from the diff. For code outside it, run `$AISDLC graph query "<keywords>"` with identifiers (function, file or module names) rather than searching broadly, and cite the files themselves, not the graph. If a rule names a skill (for example a stack's standards skill), load that skill and check against it. A deviation the user recorded under Standards deviations or Clarifications takes precedence over the skill.
   For a rule with the `criteria-met` check, go through each acceptance criterion in `goal.md` and in every done task. Tick a criterion (`- [x]`) only when the code shows it is met, and cite where. Untick any task criterion that turns out not to be met. The check fails while any criterion of the goal or a done task is unticked, so the rule must then be `fail`.
5. Fill in `governance-final.md` and its Required Fixes the same way as in Mode B, questions for the user included.
6. Set the gate:
   - **Pass:** run `$AISDLC gate set <G-id> final passed`. The goal can now complete.
   - **Fail:** run `$AISDLC gate set <G-id> final failed`. If it returns `warnings`, fix the review file and set the gate again. Ask the user any `questions`. Show the Required Fixes and ask the user how to handle each one:
     - add a fix task with `$AISDLC task new <G-id> "<title>" --risk … --verify "…"`. This resets the plan review, so the goal is re-governed before the task runs.
     - stop so they can fix it themselves.

     Either way, the final review runs again afterwards. Any task change resets the final gate.

There is no waiver in any mode. A failed `must` rule blocks until it is fixed.
