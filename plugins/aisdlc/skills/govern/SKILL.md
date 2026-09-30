---
name: govern
description: Manage AI-SDLC governance. With no argument, create or update the project's governance rules and definition of done (.aisdlc/governance.md). With a goal ID, run the governance gate for that goal, write governance-review.md, and pass or fail the gate that /aisdlc:implement requires. Use when the user runs /aisdlc:govern.
argument-hint: "[G-id]"
---

# aisdlc: govern

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

Run `$AISDLC hooks run post_govern` last in both modes.

## Mode A: no argument (edit the rules)
1. Run `$AISDLC hooks run pre_govern`. Read `.aisdlc/governance.md`. `init` seeds it with baseline rules GOV-01 to GOV-05.
2. Ask the user, one question at a time, what to add or change. Topics: coding standards, security and compliance constraints, testing requirements, review or approval needs, performance budgets and definition of done. If a stack is active (`$AISDLC detect-stack` returns `standards_skill`), suggest pointing a rule at that skill instead of copying its content.
3. Keep rules as table rows with stable IDs (`GOV-NN`) and a severity of `must` or `should`. Never renumber existing rules, because reviews reference them. To remove a rule, set its Severity to `retired` instead of deleting the row.

## Mode B: `<G-id>` (the gate)
1. Run `$AISDLC gate require <G-id> govern`. If it exits non-zero, show the `problems` and stop. Otherwise run `$AISDLC hooks run pre_govern`.
2. Gather these inputs:
   - `$AISDLC goal show <G-id>` (gates, tasks, progress, DAG status)
   - `goal.md`, the task files and the linked ADRs
   - `.aisdlc/governance.md`
3. Check each rule that is not retired, strictly. Give each a result:
   - `pass`
   - `fail`, with a concrete reason and the fix
   - `n/a`, with a reason
   Base every result on evidence in the files, not assumptions.
4. Write `governance-review.md` in the goal folder, from `${CLAUDE_PLUGIN_ROOT}/templates/governance-review.md`. Fill in the rule table with one row per active rule: the rule ID in the Rule column, `pass`, `fail` or `n/a` in the Result column, and the reason in Notes (required for `fail` and `n/a`). Add a Required Fixes list. Set `result: pass` only if no `must` rule failed. A failed `should` rule is listed but does not block.
   The script checks the review when the gate is set: it refuses `passed` if an active rule is missing from the table, a `must` rule failed, or a note is missing. If an earlier review exists as `governance-review.stale.md` (re-running challenge or adr moves it there), use it only as a reference; review every rule again.
5. Set the gate:
   - **Pass:** run `$AISDLC gate set <G-id> govern passed`. The next step is `/aisdlc:implement <G-id>`.
   - **Fail:** run `$AISDLC gate set <G-id> govern failed`. Show the Required Fixes and point to the command that addresses each one (`/aisdlc:challenge` for unclear requirements, `/aisdlc:adr` for missing decisions). The user then re-runs `/aisdlc:govern <G-id>`.

There is no waiver. A failed `must` rule blocks implementation until it is fixed.
