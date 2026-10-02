# Governance Rule Catalog

Optional rules `/aisdlc:govern` (no argument) offers. The user picks which to add and can change the wording, severity or stage. Nothing here applies until it is added to `.aisdlc/governance.md`.

| Topic | Rule | Suggested severity | Stage |
|-------|------|--------------------|-------|
| Tests | New or changed behavior is covered by automated tests that run in the verify command or `after_task` hook. | must | final |
| Secrets | No secrets, keys, tokens or credentials are committed; config reads them from the environment or a secret store. | must | final |
| Stack standards | Code follows the standards skill of each active stack (`detect-stack` → `standards_skills`). | must | final |
| Stack standards | The plan's tasks carry the criteria the active standards skills require, or the goal records the user's deviation under Standards deviations. | must | plan |
| Scope | Changed files stay within the goal's Scope (In); extra work became new tasks instead of being done silently. | should | final |
| Docs | User-facing or API changes update the README, docs or changelog. | should | final |
| Dependencies | Every new third-party dependency is named in a task or ADR, with the reason it is needed. | should | plan |
| Sensitive areas | Tasks that touch authentication, authorization, payments or personal data are marked `risk: high`. | should | plan |
| Migrations | Data or schema migrations have a tested rollback path, or the plan records why none is possible. | should | plan |
| Observability | New failure paths are logged or reported with enough context to debug them. | should | final |
