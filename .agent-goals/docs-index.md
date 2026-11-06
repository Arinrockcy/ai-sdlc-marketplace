# Goal: a model-free index and search for project documentation in `aisdlc`

- **Slug:** `docs-index`
- **Status:** draft
- **Requested:** 2026-10-12, source: user request "draft the docs-index goal", after the question "what if we have 100K lines of knowledge documentation in MD files"
- **Branch:** `docs-index`, off `master` at `37daa18`; not created yet
- **Plan approved by user:** not yet
- **Orchestrated from:** a session in `/Users/arins/work/aisdlc-demo`; every changed file is in this repo

## Goal

Today the workflow has two indexes. `registry.md` holds one row per goal and
per ADR, and `registry search` matches only the words in those rows. The code
graph is built code-only, so Markdown is never in it. A project's own
documentation (architecture notes, runbooks, domain knowledge) is in neither,
so skills find it by searching and reading files. On a project with 100K
lines of Markdown that is the cost the indexes exist to avoid.

`aisdlc` gains a third index for the project's documentation. The script
builds it with local parsing and no model calls, one entry per heading
section. A `docs search` command returns the best-matching sections as path,
heading and line range, within a token budget, so a skill reads a section
rather than a file. The same search covers ADR bodies, which today are
findable only by title. The index is searched and never read whole.

Done means: the commands exist with tests, the skills that look things up
call `docs search` before reading documentation, `npm run bench` reports what
a search prints at 1K, 10K and 100K lines of documentation, and `aisdlc` is
released with a changelog entry.

Out of scope: any model-based or embedding search; Graphify's LLM `extract`
path; indexing code (the graph does that); file types other than Markdown;
goal bodies; bounding the ADR rows that `registry.md` keeps (a separate
goal); changes to `aisdlc-nodejs`, `dependency-guardian` or the `goal`
plugin; the demo deck; pushing; tagging.

## Source material

- `plugins/aisdlc/scripts/aisdlc.mjs`: `registrySync` and `registrySearch`
  (lines 606-660), the graph freshness stamp (`graphFreshness`, `graphUpdate`)
  and `graph query --budget`.
- `AGENTS.md`: "Skills must not read an index that grows without bound in
  full", "`registry.md` indexes goals and ADRs, never code", no npm
  dependencies, deterministic steps go in the script.
- `scripts/bench.mjs`: the existing measurement of what skills read.

## Project commands

To confirm at plan approval.

- **Test:** `npm test`
- **Project validation:** `npm run validate`
- **Bench:** `npm run bench`
- **Lint:** none
- **Build:** none
- **Browser check:** none; no sub-task changes a screen

## Test baseline

Recorded on `37daa18`, 2026-10-12: `npm test` exits 0 with 139 tests, 137
pass, 0 fail, 2 skipped. `npm run validate` and `npm run bench` were not run.

## Decided

Answered by the user on 2026-10-12.

- **Which files are documentation:** the paths listed in
  `.aisdlc/config.json` under `docs.paths`. The feature is off until it is
  set.
- **Where the index lives:** `.aisdlc/cache/`, rebuilt when the indexed files
  change and never committed.
- **ADR bodies:** `docs search` also covers the body of every ADR in
  `.aisdlc/adr/`, as a second source in the same command. Goal bodies are not
  covered.
- **ADR rows in `registry.md`:** a separate goal, not part of this one.
- **Ranking:** the rule `registry search` uses, counting matched keywords,
  with a heading match weighted above a body match. No BM25.
- **Branch and version:** a new `docs-index` branch off `master`, released as
  `aisdlc` 0.16.0.
- **Init:** `/aisdlc:init` offers the documentation index, as it offers
  Graphify, and never sets it silently.
- **ADRs when `docs.paths` is unset:** ADR bodies are always indexed and
  searchable. Only the project's own documentation waits for `docs.paths`.

## Open questions

None. All eight were answered on 2026-10-12; see Decided and the Decision log.

## Sub-tasks

Run in this order, one at a time. Every sub-task's acceptance also includes:
`npm test` exits 0 with at least 137 passing and 0 failing; `npm run validate`
exits 0; no npm dependency is added; `git status --short` shows only that
sub-task's files.

### 1. Build the index: `docs sync` and `docs status`

- **Status:** pending
- **Scope:** Read the documentation paths from `docs.paths` in config, and add every ADR file in `.aisdlc/adr/`. Split each Markdown file into heading sections (path, heading trail, first and last line), ignoring headings inside fenced code. Write the index and a content stamp under `.aisdlc/cache/` so an unchanged tree is not re-parsed. `docs status` reports whether it is configured, built and stale. With `docs.paths` unset, the index holds the ADRs only, and `docs status` says documentation is not configured.
- **Areas:** `plugins/aisdlc/scripts/aisdlc.mjs`, `plugins/aisdlc/tests/aisdlc.test.mjs`
- **Changes a screen:** no
- **Depends on:** none
- **Acceptance:** tests cover `docs.paths` unset with ADRs still indexed, no ADRs and no paths, an empty folder, nested headings, a file with no heading, a heading inside a code fence, a deleted file, a changed file marking the index stale, and an ADR indexed with its ID; line ranges in the index match the files; nothing is written outside `.aisdlc/cache/`
- **Governor notes:**
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 2. Search it: `docs search <keywords> [--budget N]`

- **Status:** pending
- **Scope:** Refresh the index when stale, as `graph query` does. Rank sections for the keywords and print path, line range and heading for the best matches, stopping at the budget and reporting how many more matched. An ADR match also prints its ID and status. Reuse the keyword and stopword handling of `registry search`. Rank by the number of matched keywords, a heading match counting above a body match. With `docs.paths` unset it searches ADR bodies and adds a note that project documentation is not configured, so the skill searches those files directly.
- **Areas:** `plugins/aisdlc/scripts/aisdlc.mjs`, `plugins/aisdlc/tests/aisdlc.test.mjs`
- **Changes a screen:** no
- **Depends on:** 1
- **Acceptance:** tests cover a heading match ranking above a body match, a prefix match, no match, the budget cutting the output, a word found only in an ADR body, an ADR found with `docs.paths` unset, a stale index refreshed by the search, and a bad `--budget`; output never includes section bodies
- **Governor notes:** `--budget` is already in `OPTIONS`.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 3. Skills call it

- **Status:** pending
- **Scope:** `create-goal`, `challenge`, `adr`, `implement` and `govern` gain one instruction each: run `$AISDLC docs search <keywords>` before reading project documentation or opening ADRs by title alone, and read only the sections it returns. `init` offers the documentation index next to Graphify: it asks for the paths, sets `docs.paths` through the script, and leaves it unset if the user declines. Wording stays agent-neutral.
- **Areas:** `plugins/aisdlc/skills/{init,create-goal,challenge,adr,implement,govern}/SKILL.md`, `plugins/aisdlc/tests/skills.test.mjs`
- **Changes a screen:** no
- **Depends on:** 2
- **Acceptance:** the skills tests pass, including the check that every `$AISDLC …` span runs; no skill tells the agent to read the index file; `init` asks and never sets `docs.paths` without an answer
- **Governor notes:** AGENTS.md: every `$AISDLC` span must be a complete, runnable invocation.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 4. Measure it

- **Status:** pending
- **Scope:** `scripts/bench.mjs` builds a documentation corpus of 1K, 10K and 100K lines and reports, for each: build time, search time, and the approximate tokens a search prints against the tokens of the corpus. The numbers are recorded in this ledger.
- **Areas:** `scripts/bench.mjs`, this ledger
- **Changes a screen:** no
- **Depends on:** 2
- **Acceptance:** `npm run bench` exits 0 and prints the three rows; search output at 100K lines stays within the default budget; the recorded numbers are the ones the run printed
- **Governor notes:** These are the first measured figures for the "lower token cost" claim. Nothing is claimed before this runs.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

### 5. Documentation and release

- **Status:** pending
- **Scope:** README section for the documentation index and its config; AGENTS.md architecture and product-decision lines (the script owns the index; it is never read whole; `registry.md` still indexes only goals and ADRs); `aisdlc` changelog entry; version bump in the plugin manifest and both marketplace files.
- **Areas:** `README.md`, `AGENTS.md`, `plugins/aisdlc/CHANGELOG.md`, `plugins/aisdlc/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.github/plugin/marketplace.json`
- **Changes a screen:** no
- **Depends on:** 3, 4
- **Acceptance:** the release tests pass; the two marketplace files are identical; the README states that ADR bodies are always searchable and project documentation is indexed only once `docs.paths` is set, and quotes only the bench numbers from sub-task 4
- **Governor notes:** AGENTS.md Releases section.
- **Review:**
- **Verification:**
- **Commit:**
- **Task detail:**

## Decision log

| Date | Question | Decision | Sub-task |
|---|---|---|---|
| 2026-10-12 | Which files are documentation | Paths in `docs.paths`; off until set | 1 |
| 2026-10-12 | Where the index lives | `.aisdlc/cache/`, never committed | 1 |
| 2026-10-12 | Search goal and ADR bodies | ADR bodies yes; goal bodies no | 1, 2, 3 |
| 2026-10-12 | ADR rows in `registry.md` | Separate goal | none |
| 2026-10-12 | Ranking | Keyword count, headings above body | 2 |
| 2026-10-12 | Branch and version | New `docs-index` branch off `master`; `aisdlc` 0.16.0 | all, 5 |
| 2026-10-12 | Does init offer it | Yes, as it offers Graphify | 3 |
| 2026-10-12 | ADRs with `docs.paths` unset | Always searchable | 1, 2 |


