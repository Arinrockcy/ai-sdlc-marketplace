---
name: create-goal
description: Create a new AI-SDLC goal, starting with clarifying questions that fill the gaps in the user's description, and split it into small, verifiable tasks with an explicit dependency graph (DAG), parallel waves and risk-first ordering. Use when the user runs /aisdlc:create-goal or asks to plan a feature or goal in an aisdlc project.
argument-hint: "<goal description>"
---

# aisdlc: create-goal

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default.

Input: `$ARGUMENTS` is the goal description. If it is empty, ask the user for one.

## 0. Context (keep it cheap)
- Run `$AISDLC hooks run pre_create_goal`.
- Read `.aisdlc/registry.md` to see existing goals and ADRs. Avoid duplicates and reuse existing ADRs.
- Run `$AISDLC config get graph.provider`. If it is `graphify`, query the graph (for example `graphify-out/GRAPH_REPORT.md` or the `/graphify` query tooling) to find the modules involved, instead of grepping broadly. If it is `none`, read only the files you need.

## 1. Intake questions (always first)
Before you write anything, find the gaps in the description and ask the user about them. Don't write a goal the user didn't describe.

1. Check the description against what a goal needs:
   - **Problem:** who is affected, and what is wrong or missing today
   - **Outcome:** what "done" looks like, in terms that can be measured or checked
   - **Scope:** what is in, and what is explicitly out
   - **Constraints:** compatibility, deadlines, performance, security, and technology that must or must not be used
   - **Integrations and data:** the systems, APIs and data the goal touches, and whether existing data needs migrating
   - **Behavior at the edges:** errors, limits, permissions, empty states
   A point the description, the registry or the code already answers is not a gap. Look it up instead of asking.
2. Ask about each gap **one question at a time**, most important first. Use a structured question tool with 2 to 4 concrete options when one is available. Keep going until you can write every goal section without guessing, or the user says to stop.
3. If you find no gaps, summarize your understanding in a few lines and ask the user to confirm it before continuing.

## 2. Goal
- Run `$AISDLC goal new <short title>`. Open the `file` it returns.
- Record each intake answer under `## Clarifications` as `- **Q:** … **A:** …`, so `/aisdlc:challenge` doesn't ask it again.
- Fill in Problem, Outcome / Acceptance Criteria (measurable), Scope In/Out, and Risks & Unknowns, using only the description, the answers and what the code shows. Anything the user deferred or couldn't answer goes under Risks & Unknowns as an open question. Do **not** guess answers; `/aisdlc:challenge` resolves them.

## 3. Split into tasks
Apply these rules in order. If a split depends on something the user hasn't said (for example, whether existing data needs migrating), ask; don't assume.

1. **Vertical and independently verifiable.** Each task delivers a slice that can be checked on its own. Each task has its own acceptance criteria and a `verify` command (a test, build, lint or script). If you can't tell how a slice would be checked, ask the user. If no command exists, write a concrete manual check prefixed with `manual:` (for example `--verify "manual: GET /health returns 200"`). `/aisdlc:implement` then records evidence for it instead of running it.
2. **Size cap.** One concern per task, touching about 5 files or fewer, and finishable in one focused session. If a task is bigger, split it again until it fits.
3. **Explicit dependencies.** A task depends on another only if it truly needs that task's output. Don't chain tasks just to force an order. Fewer edges means more parallel waves.
4. **Risk first.** Mark each task `high`, `medium` or `low` risk. Unknowns, spikes, integrations and irreversible changes are `high`. If an unknown blocks the design, add a spike task first and make other tasks depend on it.

Create tasks in dependency order, because `--depends` may only reference tasks that already exist:
```
$AISDLC task new <G-id> "<title>" --risk high|medium|low --depends T-01,T-02 --verify "<command>"
```
Then fill in each task file's What, Acceptance Criteria and Files sections.

## 4. Validate and write the plan
- Run `$AISDLC dag write <G-id>`. It rejects cycles and unknown dependencies and writes `tasks.md` with waves. Fix any errors it reports.
- Review the waves. If one wave holds one huge task, or the graph is a single long chain, reconsider the split.

## 5. Finish
- Run `$AISDLC registry sync`, then `$AISDLC hooks run post_create_goal`.
- Show the user the goal ID, the wave table from `tasks.md` and the open questions.
- Next step: `/aisdlc:challenge <G-id>`. The gated order is challenge → adr → govern → implement.
