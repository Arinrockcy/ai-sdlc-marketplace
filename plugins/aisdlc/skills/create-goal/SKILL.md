---
name: create-goal
description: Create a new AI-SDLC goal. First checks for unfinished goals and asks whether to merge into a pending one, finish one first, or create a separate goal. Then starts with clarifying questions that fill the gaps in the user's description, and split it into small, verifiable tasks with an explicit dependency graph (DAG), parallel waves and risk-first ordering. Use when the user runs /aisdlc:create-goal or asks to plan a feature or goal in an aisdlc project.
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

## 1. Unfinished goals (before anything else)
Run `$AISDLC goal list`. If every goal is `completed`, or there are none, go to section 2.

Otherwise tell the user which goals are unfinished: ID, title, status and gates. Say whether the new description overlaps any of them. Then ask what to do, one question, with these choices:

- **Merge into `<G-id>`.** Offer this only for `pending` goals, with one choice per pending goal. An in-progress or blocked goal can't be challenged again, so it can't take on new scope.
- **Finish `<G-id>` first.** Don't create anything. Tell the user the next command for that goal, from its gates and status:
  - `/aisdlc:challenge <G-id>` if the challenge gate isn't done
  - `/aisdlc:adr <G-id>` if the adr gate isn't done
  - `/aisdlc:govern <G-id>` if the govern gate hasn't passed
  - otherwise `/aisdlc:implement <G-id>`

  They re-run `/aisdlc:create-goal` afterwards. Run `$AISDLC hooks run post_create_goal` and stop.
- **Create a separate goal.** Continue with section 2. The new goal waits in `pending` alongside the others.

Never pick for the user, even when the overlap looks obvious.

### Merging into a pending goal
1. Read the goal's `goal.md` and tasks. Run the intake questions (section 2) against the new description, skipping what the goal already answers. Record the answers under the goal's `## Clarifications`.
2. Extend Problem, Outcome / Acceptance Criteria, Scope and Risks & Unknowns with the new scope. Don't remove or reword existing content unless the user agrees. If the title no longer fits, ask whether to change it (`$AISDLC goal set <G-id> title "<title>"`).
3. Add the new tasks as in section 4 (`task new` resets the govern gate if it had passed).
4. The merged scope hasn't been through challenge or ADRs yet. If `gates.challenge` is `done`, run `$AISDLC gate set <G-id> challenge pending`. If `gates.adr` is `done`, run `$AISDLC gate set <G-id> adr pending`. Relay the `notes`.
5. Continue with section 5, then section 6 for the merged goal. The next step is `/aisdlc:challenge <G-id>`.

## 2. Intake questions (before writing the goal)
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

## 3. Goal
- Run `$AISDLC goal new <short title>`. Open the `file` it returns.
- Record each intake answer under `## Clarifications` as `- **Q:** … **A:** …`, so `/aisdlc:challenge` doesn't ask it again.
- Fill in Problem, Outcome / Acceptance Criteria (measurable), Scope In/Out, and Risks & Unknowns, using only the description, the answers and what the code shows. Anything the user deferred or couldn't answer goes under Risks & Unknowns as an open question. Do **not** guess answers; `/aisdlc:challenge` resolves them.

## 4. Split into tasks
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

## 5. Validate and write the plan
- Run `$AISDLC dag write <G-id>`. It rejects cycles and unknown dependencies and writes `tasks.md` with waves. Fix any errors it reports.
- Review the waves. If one wave holds one huge task, or the graph is a single long chain, reconsider the split.

## 6. Finish
- Run `$AISDLC registry sync`, then `$AISDLC hooks run post_create_goal`.
- Show the user the goal ID, the wave table from `tasks.md` and the open questions.
- Next step: `/aisdlc:challenge <G-id>`. The gated order is challenge → adr → govern → implement.
