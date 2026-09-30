---
name: create-goal
description: Create a new AI-SDLC goal and split it into small, verifiable tasks with an explicit dependency graph (DAG), parallel waves and risk-first ordering. Use when the user runs /aisdlc:create-goal or asks to plan a feature or goal in an aisdlc project.
argument-hint: "<goal description>"
---

# aisdlc: create-goal

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

Input: `$ARGUMENTS` is the goal description. If it is empty, ask the user for one.

## 0. Context (keep it cheap)
- Run `$AISDLC hooks run pre_create_goal`.
- Read `.aisdlc/registry.md` to see existing goals and ADRs. Avoid duplicates and reuse existing ADRs.
- Run `$AISDLC config get graph.provider`. If it is `graphify`, query the graph (for example `graphify-out/GRAPH_REPORT.md` or the `/graphify` query tooling) to find the modules involved, instead of grepping broadly. If it is `none`, read only the files you need.

## 1. Goal
- Run `$AISDLC goal new <short title>`. Open the `file` it returns.
- Fill in Problem, Outcome / Acceptance Criteria (measurable), Scope In/Out, and Risks & Unknowns. List open questions under Risks & Unknowns. Do **not** guess answers; `/aisdlc:challenge` resolves them.

## 2. Split into tasks
Apply these rules in order.

1. **Vertical and independently verifiable.** Each task delivers a slice that can be checked on its own. Each task has its own acceptance criteria and a `verify` command (a test, build, lint or script). If no command exists, write a concrete manual check prefixed with `manual:` (for example `--verify "manual: GET /health returns 200"`). `/aisdlc:implement` then records evidence for it instead of running it.
2. **Size cap.** One concern per task, touching about 5 files or fewer, and finishable in one focused session. If a task is bigger, split it again until it fits.
3. **Explicit dependencies.** A task depends on another only if it truly needs that task's output. Don't chain tasks just to force an order. Fewer edges means more parallel waves.
4. **Risk first.** Mark each task `high`, `medium` or `low` risk. Unknowns, spikes, integrations and irreversible changes are `high`. If an unknown blocks the design, add a spike task first and make other tasks depend on it.

Create tasks in dependency order, because `--depends` may only reference tasks that already exist:
```
$AISDLC task new <G-id> "<title>" --risk high|medium|low --depends T-01,T-02 --verify "<command>"
```
Then fill in each task file's What, Acceptance Criteria and Files sections.

## 3. Validate and write the plan
- Run `$AISDLC dag write <G-id>`. It rejects cycles and unknown dependencies and writes `tasks.md` with waves. Fix any errors it reports.
- Review the waves. If one wave holds one huge task, or the graph is a single long chain, reconsider the split.

## 4. Finish
- Run `$AISDLC registry sync`, then `$AISDLC hooks run post_create_goal`.
- Show the user the goal ID, the wave table from `tasks.md` and the open questions.
- Next step: `/aisdlc:challenge <G-id>`. The gated order is challenge → adr → govern → implement.
