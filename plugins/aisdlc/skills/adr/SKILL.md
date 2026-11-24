---
name: adr
description: Record Architecture Decision Records (ADRs) for an AI-SDLC goal in .aisdlc/adr/, link existing ADRs, or record that no architectural decision is needed. Use when the user runs /aisdlc:adr <goal-id>.
argument-hint: "<G-id>"
---

# aisdlc: adr

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are named `<plugin>:<skill>` (`/aisdlc:govern`, `aisdlc-nodejs:nodejs-standards`); in an agent without plugin namespaces, such as GitHub Copilot, use only the `<skill>` part, both to load a skill and when you tell the user what to run (`/aisdlc:govern` is `/govern`, `aisdlc-nodejs:nodejs-standards` is `nodejs-standards`).

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. If the context a decision depends on (scale, constraints, who owns what) isn't recorded, ask before you write options.

**Who decided.** The script logs every change it makes in the goal's `decisions.md`, with the time and who made it (the name from `git config user.name`, or `AISDLC_ACTOR`). When the user made the choice in this conversation, add `--by user` to the command that carries it out, so the log shows it as theirs. When no command carries it out (merge or create, retry, which option to take), record it with `$AISDLC decision add <G-id> "<the choice>" --by user`. Never pass `--by user` for a choice you made yourself.

Input: `$ARGUMENTS` (the text after the skill's name) is the goal ID. If it is missing, ask the user which goal.

ADRs are project-wide and live in `.aisdlc/adr/ADR-NNN-slug.md` (Nygard format). One ADR can serve many goals.

## Steps
1. Run `$AISDLC gate require <G-id> adr`. If it exits non-zero, show the `problems` and stop.
2. Run `$AISDLC hooks run pre_adr`.
3. Read `goal.md`, including its Clarifications section. Read the ADR rows in `.aisdlc/registry.md` and open only the ADRs whose titles bear on this goal. Run `$AISDLC docs search <keywords>` before you read project documentation or open an ADR, and read only the sections it returns (each has a path and a line range). It searches the bodies of ADRs too. If it says project documentation is not configured, search those files directly. Never read the index in `.aisdlc/cache/`. To see the patterns already in place in the modules a decision would touch, run `$AISDLC graph query "<keywords>"` before searching the code.
4. Identify candidate decisions. A decision is architectural when it is hard to reverse, affects several modules or teams, adds a dependency or technology, or changes data models, APIs or security.
5. For each candidate, decide one of these:
   - **An existing ADR already covers it.** Run `$AISDLC adr link <ADR-id> <G-id>`.
   - **It needs a new ADR.** Present two or three options with their trade-offs and let the user choose. Don't decide for them. Then run `$AISDLC adr new "<title>" --goal <G-id>` and fill in Context, Decision, Alternatives Considered and Consequences. Once the user agrees, run `$AISDLC adr status <ADR-id> accepted --reason "<why, in the user's words>" --by user`: it records who decided (`decided_by`) on the ADR and in the decision log of the project and of every linked goal. Never edit `status:` by hand. If the new ADR replaces an old one, set `supersedes:` on the new ADR and run `$AISDLC adr status <ADR-id> superseded --reason "<new ADR-id> replaces it" --by user` for the old one. An option the user turns down goes under Alternatives Considered; an ADR they turn down as a whole is `$AISDLC adr status <ADR-id> rejected --reason "<why>" --by user`.
6. If there are no candidates, confirm with the user. Then run `$AISDLC adr none <G-id> --reason "<why>"`. This also removes the goal from any ADRs it was linked to before.
7. Update the tasks the decisions affect, then run `$AISDLC dag write <G-id>`.
8. Run `$AISDLC gate set <G-id> adr done`. Linking a new ADR (or recording `none`) on a goal whose adr gate was already done resets that gate and every gate after it. The command's `notes` say so, so always finish with this step. The script refuses if no ADR is linked and no `none` reason is recorded, or if a linked ADR is not `accepted` (or `superseded`). A `proposed` ADR means the user hasn't agreed yet; settle it with them first.
9. Run `$AISDLC hooks run post_adr`. The next step is `/aisdlc:govern <G-id>`.
