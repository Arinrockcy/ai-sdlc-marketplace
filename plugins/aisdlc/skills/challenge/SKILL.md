---
name: challenge
description: Clarify an AI-SDLC goal by asking the user one question at a time until ambiguities, open questions and assumptions are resolved, then update the goal and tasks. Use when the user runs /aisdlc:challenge <goal-id>.
argument-hint: "<G-id>"
---

# aisdlc: challenge

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are named `<plugin>:<skill>` (`/aisdlc:govern`, `aisdlc-nodejs:nodejs-standards`); in an agent without plugin namespaces, such as GitHub Copilot, use only the `<skill>` part, both to load a skill and when you tell the user what to run (`/aisdlc:govern` is `/govern`, `aisdlc-nodejs:nodejs-standards` is `nodejs-standards`).

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. Resolve a question only with the user's answer, never with your own inference.

Input: `$ARGUMENTS` (the text after the skill's name) is the goal ID. If it is missing, run `$AISDLC goal list --status pending` and ask the user which goal.

## Steps
1. Run `$AISDLC gate require <G-id> challenge`. If it exits non-zero, show the `problems` and stop.
2. Run `$AISDLC hooks run pre_challenge`.
3. Run `$AISDLC goal show <G-id>`. Read `goal.md` and the task files. The Clarifications section already holds the answers from `/aisdlc:create-goal`'s intake questions; don't ask those again.
4. Build an internal list of ambiguities. Sources:
   - the goal's Risks & Unknowns section, especially its `- **Open:** …` items
   - statements in the goal or tasks that rest on an assumption, not on the user's words, a Clarification or the code
   - vague acceptance criteria (not measurable)
   - unclear scope boundaries
   - assumptions hidden in tasks
   - missing verify commands
   - dependencies that look wrong
   - decisions that sound architectural (note these for `/aisdlc:adr`)
   - the stack's standards: run `$AISDLC detect-stack`. If `standards_skill` is set, load that skill. Check that the tasks carry the criteria it requires (for example declaration files, test layers, lint and coverage). Where the repo conflicts with it (another test runner, a threshold the tooling can't enforce), ask the user which way to go. Record a chosen departure under `## Standards deviations` in `goal.md` with the reason, so reviewers don't rebuild it from the Clarifications.
5. Ask the user **one question at a time**. Use a structured question tool with 2 to 4 concrete options when one is available. Put the most important question first. After each answer:
   - Append it under `## Clarifications` in `goal.md` as `- **Q:** … **A:** …`.
   - If it answers an `- **Open:** …` item under Risks & Unknowns, remove that item. Only the user's answer resolves it.
   - Update the affected goal sections and task files right away. After changing a goal criterion, check that the task criteria and Files still match it. Change tasks only through the script, never by renaming or deleting task files, so IDs are never reused:
     - add one: `$AISDLC task new <G-id> "<title>" --risk … --depends … --verify "…"`
     - change a planned field: `$AISDLC task edit <G-id> <T-id> title "<title>"`, `$AISDLC task edit <G-id> <T-id> depends T-01,T-02|none`, `$AISDLC task edit <G-id> <T-id> risk high|medium|low` or `$AISDLC task edit <G-id> <T-id> verify "<command>"`. A new title renames the file too.
     - remove one: `$AISDLC task remove <G-id> <T-id> --reason "<why>"`. It refuses while another task depends on it; change that dependency first. The removal is logged under `## Removed tasks` in `goal.md`.
     - split one: add the new tasks, move the dependencies over, then remove the old one.
   - Don't ask what the codebase or an earlier decision already answers. Look it up instead, as cheaply as you can: the `accepted` ADR rows in `.aisdlc/registry.md` for decisions already made, and `$AISDLC graph query "<keywords>"` rather than a broad search of the code. Open only the ADRs and files that bear on the question.
6. Stop when there are no open questions left, or when the user says to stop. Record each unresolved question under Risks & Unknowns as `- **Open:** <question>`, and tell the user that `/aisdlc:govern` will fail rule GOV-05 until they are answered (its `questions-resolved` check finds them).
7. Run `$AISDLC dag write <G-id>` to revalidate the DAG. Then run `$AISDLC gate set <G-id> challenge done`. If the output includes `notes` (governance reset, stale review), relay them to the user.
8. Run `$AISDLC hooks run post_challenge`. Tell the user which architectural decisions came up and that the next step is `/aisdlc:adr <G-id>`.
