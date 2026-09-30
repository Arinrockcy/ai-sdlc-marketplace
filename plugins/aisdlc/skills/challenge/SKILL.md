---
name: challenge
description: Clarify an AI-SDLC goal by asking the user one question at a time until ambiguities, open questions and assumptions are resolved, then update the goal and tasks. Use when the user runs /aisdlc:challenge <goal-id>.
argument-hint: "<G-id>"
---

# aisdlc: challenge

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. Resolve a question only with the user's answer, never with your own inference.

Input: `$ARGUMENTS` is the goal ID. If it is missing, run `$AISDLC goal list --status pending` and ask the user which goal.

## Steps
1. Run `$AISDLC gate require <G-id> challenge`. If it exits non-zero, show the `problems` and stop.
2. Run `$AISDLC hooks run pre_challenge`.
3. Run `$AISDLC goal show <G-id>`. Read `goal.md` and the task files. The Clarifications section already holds the answers from `/aisdlc:create-goal`'s intake questions; don't ask those again.
4. Build an internal list of ambiguities. Sources:
   - the goal's Risks & Unknowns section
   - statements in the goal or tasks that rest on an assumption, not on the user's words, a Clarification or the code
   - vague acceptance criteria (not measurable)
   - unclear scope boundaries
   - assumptions hidden in tasks
   - missing verify commands
   - dependencies that look wrong
   - decisions that sound architectural (note these for `/aisdlc:adr`)
5. Ask the user **one question at a time**. Use a structured question tool with 2 to 4 concrete options when one is available. Put the most important question first. After each answer:
   - Append it under `## Clarifications` in `goal.md` as `- **Q:** … **A:** …`.
   - Update the affected goal sections and task files right away. Add, split or remove tasks as needed, using `$AISDLC task new …` for new tasks.
   - Don't ask what the codebase already answers. Look it up instead.
6. Stop when there are no open questions left, or when the user says to stop. If questions remain unresolved, record them under Risks & Unknowns and tell the user that `/aisdlc:govern` will fail rule GOV-05.
7. Run `$AISDLC dag write <G-id>` to revalidate the DAG. Then run `$AISDLC gate set <G-id> challenge done`. If the output includes `notes` (governance reset, stale review), relay them to the user.
8. Run `$AISDLC hooks run post_challenge`. Tell the user which architectural decisions came up and that the next step is `/aisdlc:adr <G-id>`.
