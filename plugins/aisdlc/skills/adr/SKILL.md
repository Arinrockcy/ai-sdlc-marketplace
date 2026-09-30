---
name: adr
description: Record Architecture Decision Records (ADRs) for an AI-SDLC goal in .aisdlc/adr/, link existing ADRs, or record that no architectural decision is needed. Use when the user runs /aisdlc:adr <goal-id>.
argument-hint: "<G-id>"
---

# aisdlc: adr

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run it from the project root.

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. If the context a decision depends on (scale, constraints, who owns what) isn't recorded, ask before you write options.

Input: `$ARGUMENTS` is the goal ID. If it is missing, ask the user which goal.

ADRs are project-wide and live in `.aisdlc/adr/ADR-NNN-slug.md` (Nygard format). One ADR can serve many goals.

## Steps
1. Run `$AISDLC gate require <G-id> adr`. If it exits non-zero, show the `problems` and stop.
2. Run `$AISDLC hooks run pre_adr`.
3. Read `goal.md`, including its Clarifications section. Read the ADR rows in `.aisdlc/registry.md` and open only the ADRs whose titles bear on this goal. To see the patterns already in place in the modules a decision would touch, run `$AISDLC graph query "<keywords>"` before searching the code.
4. Identify candidate decisions. A decision is architectural when it is hard to reverse, affects several modules or teams, adds a dependency or technology, or changes data models, APIs or security.
5. For each candidate, decide one of these:
   - **An existing ADR already covers it.** Run `$AISDLC adr link <ADR-id> <G-id>`.
   - **It needs a new ADR.** Present two or three options with their trade-offs and let the user choose. Don't decide for them. Then run `$AISDLC adr new "<title>" --goal <G-id>` and fill in Context, Decision, Alternatives Considered and Consequences. Set `status: accepted` once the user agrees. If the new ADR replaces an old one, set `supersedes:` on the new ADR and change the old one's `status:` to `superseded`.
6. If there are no candidates, confirm with the user. Then run `$AISDLC adr none <G-id> --reason "<why>"`. This also removes the goal from any ADRs it was linked to before.
7. Update the tasks the decisions affect, then run `$AISDLC dag write <G-id>`.
8. Run `$AISDLC gate set <G-id> adr done`. Linking a new ADR (or recording `none`) on a goal whose adr gate was already done resets that gate and every gate after it. The command's `notes` say so, so always finish with this step. The script refuses if no ADR is linked and no `none` reason is recorded, or if a linked ADR is not `accepted` (or `superseded`). A `proposed` ADR means the user hasn't agreed yet; settle it with them first.
9. Run `$AISDLC hooks run post_adr`. The next step is `/aisdlc:govern <G-id>`.
