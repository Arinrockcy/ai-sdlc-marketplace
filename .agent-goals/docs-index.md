# Goal: a model-free index and search for project documentation in `aisdlc`

- **Slug:** `docs-index`
- **Status:** draft
- **Requested:** 2026-10-12, source: user request "draft the docs-index goal", after the question "what if we have 100K lines of knowledge documentation in MD files"
- **Revised:** 2026-11-06, against `master` at `d7851eb` (`aisdlc` 0.23.0), after a review found the draft stale and `docs.paths` undefined; the three answers of that date are in Decided
- **Branch:** `docs-index`, off `master` at `d7851eb`; not created yet
- **Plan approved by user:** yes, 2026-11-06
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

- `plugins/aisdlc/scripts/aisdlc.mjs`: `registrySync`, `registrySearch` and the
  `STOPWORDS` constant they share, the graph freshness stamp
  (`graphFreshness`, `graphUpdate`) and `graph query --budget`. Find them by
  name: line numbers move with every release.
- `AGENTS.md`: "Skills must not read an index that grows without bound in
  full", "`registry.md` indexes goals and ADRs, never code", no npm
  dependencies, deterministic steps go in the script.
- `scripts/bench.mjs`: the existing measurement of what skills read. Its one
  argument is a list of goal counts (`npm run bench [-- 10,100,500]`), checked
  as integers.
- `plugins/aisdlc/scripts/aisdlc.mjs`: `config` stores a value it is given as
  text, so a list cannot be set through it without the caller writing JSON.

## Project commands

Confirmed on `d7851eb`, 2026-11-06.

- **Test:** `npm test`
- **Project validation:** `npm run validate`
- **Bench:** `npm run bench`
- **Lint:** none
- **Build:** none
- **Browser check:** none; no sub-task changes a screen

## Test baseline

Recorded on `d7851eb`, 2026-11-06: `npm test` exits 0 with 152 tests, 150
pass, 0 fail, 2 skipped (the two ESLint template tests, which need
`AISDLC_ESLINT`; with it set all 152 pass). `npm run validate` passes and
`npm run bench` exits 0. Re-record this on the real base commit if `master`
moves before the branch is cut.

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
  `aisdlc` 0.24.0 (the next minor after 0.23.0; the new `docs` commands and
  `docs.paths` are additions, and nothing existing changes meaning, so there is
  no **Breaking** entry). This replaces the 0.16.0 of 2026-10-12, which has
  been released.
- **Init:** `/aisdlc:init` offers the documentation index, as it offers
  Graphify, and never sets it silently.
- **ADRs when `docs.paths` is unset:** ADR bodies are always indexed and
  searchable. Only the project's own documentation waits for `docs.paths`.

- **What a `docs.paths` entry is** (2026-11-06): a project-relative file or
  folder. A folder is searched recursively for `*.md`. No globs. An entry that
  is missing, outside the project (absolute or containing `..`), or not a
  string is an error that names it; `docs.paths` itself must be an array.
  Duplicate entries and entries that overlap, including a folder that contains
  `.aisdlc/adr/`, count each file once, and a file indexed as an ADR is not
  indexed again as documentation.
- **How staleness is detected** (2026-11-06): the stamp is the sorted list of
  indexed files with their size and modification time. No file is read to
  check it. An edit that keeps the same size within one file-system clock tick
  is not seen; the next `docs sync` (or any change that moves a size or time)
  catches it. That limit is stated in the README.
- **How `docs.paths` is set** (2026-11-06): a new command, `docs paths
  <path>...`, validates every path as above, stores the list and replaces the
  old one; with no paths it prints the current list. `/aisdlc:init` calls it.
  `config set docs.paths` is not the documented way.
- **Bench sizes** (the author's choice, not a product decision): `bench.mjs`
  keeps its positional goal counts unchanged and gains `--docs <line counts>`,
  default `1000,10000,100000`, which runs the documentation section.

## Open questions

None. The eight of 2026-10-12 and the three of 2026-11-06 are in Decided and
the Decision log. The plan stays unapproved until the user approves it.

## Sub-tasks

Run in this order, one at a time. Every sub-task's acceptance also includes:
`npm test` exits 0 with at least 150 passing (the baseline, plus the tests the sub-task adds) and 0 failing; `npm run validate`
exits 0; no npm dependency is added; `git status --short` shows only that
sub-task's files.

### 1. Build the index: `docs sync` and `docs status`

- **Status:** done, 2026-11-06
- **Scope:** Read the documentation paths from `docs.paths` in config (rules in Decided), and add every ADR file in `.aisdlc/adr/`. Add `docs paths <path>...` to validate and store the list. Split each Markdown file into heading sections (path, heading trail, first and last line), ignoring headings inside fenced code, both backtick and tilde fences. Write the index and the stamp (file list with size and mtime) under `.aisdlc/cache/` so an unchanged tree is not re-parsed. `docs status` reports whether it is configured, built and stale. With `docs.paths` unset, the index holds the ADRs only, and `docs status` says documentation is not configured. `docs` with no or an unknown subcommand prints its usage and exits non-zero.
- **Areas:** `plugins/aisdlc/scripts/aisdlc.mjs`, `plugins/aisdlc/tests/aisdlc.test.mjs`
- **Changes a screen:** no
- **Depends on:** none
- **Acceptance:** tests cover `docs.paths` unset with ADRs still indexed, no ADRs and no paths, an empty folder, nested headings, a file with no heading, a heading inside a backtick fence and inside a tilde fence, an indented code block, a deleted file, a changed file marking the index stale, and an ADR indexed with its ID; `docs paths` refusing a missing path, an absolute path, a `..` path and a non-string, replacing the old list, and printing it with no arguments; a `docs.paths` that is a string or other non-array in config being reported by name, not iterated; duplicate and overlapping entries, including one that contains `.aisdlc/adr/`, indexing each file once; an unknown `docs` subcommand failing with usage; line ranges in the index match the files; nothing is written outside `.aisdlc/cache/`
- **Governor notes:**
- **Review:** none run; the author checked the acceptance list against the tests only
- **Verification:** `npm test` exits 0 with 155 tests, 153 pass, 0 fail, 2 skipped (the ESLint template tests; the baseline was 152, 150, 0, 2, so three tests were added); `npm run validate` passes. The three new tests cover the acceptance list. Only `aisdlc.mjs`, `aisdlc.test.mjs` and this ledger changed.
- **Commit:** the commit on branch `docs-index` that holds this line
- **Task detail:** `docs paths|sync|status` in `aisdlc.mjs`. Folder entries skip `.git`, `node_modules`, symlinks and everything under `.aisdlc/` except `adr/`; a file entry under `.aisdlc/` other than `adr/` is refused. Not yet decided by the user, listed for approval: those skips.

### 2. Search it: `docs search <keywords> [--budget N]`

- **Status:** done, 2026-11-06
- **Scope:** Refresh the index when stale, as `graph query` does. Rank sections for the keywords and print path, line range and heading for the best matches, stopping at the budget and reporting how many more matched. An ADR match also prints its ID and status. Reuse the keyword and `STOPWORDS` handling of `registry search`. Rank by the number of matched keywords, a heading match counting above a body match. With `docs.paths` unset it searches ADR bodies and adds a note that project documentation is not configured, so the skill searches those files directly.
- **Areas:** `plugins/aisdlc/scripts/aisdlc.mjs`, `plugins/aisdlc/tests/aisdlc.test.mjs`
- **Changes a screen:** no
- **Depends on:** 1
- **Acceptance:** tests cover a heading match ranking above a body match, a prefix match, no match, the budget cutting the output, a word found only in an ADR body, an ADR found with `docs.paths` unset, a stale index refreshed by the search, a bad `--budget`, and a same-size edit within one clock tick staying unseen until the next sync (the limit in Decided, pinned so a change to it is deliberate); output never includes section bodies
- **Governor notes:** `--budget` is already in `OPTIONS`.
- **Review:** none run; the author checked the acceptance list against the tests only
- **Verification:** `npm test` exits 0 with 156 tests, 154 pass, 0 fail, 2 skipped (the ESLint template tests); `npm run validate` passes. One new test covers the acceptance list, including the pinned same-size edit.
- **Commit:** the commit on branch `docs-index` that holds this line
- **Task detail:** `docs search <keywords> [--budget N]`. A heading match counts 2 and a body match 1, ties go to more matched keywords then file order. The heading weight uses the section's own heading, not its trail, so a child of a matching section does not match on the parent's name; the trail is printed. `--budget` is whole tokens, 100 or more, default 1500 (the graph query default). The stamp now floors mtime to whole milliseconds.

### 3. Skills call it

- **Status:** done, 2026-11-06
- **Scope:** `create-goal`, `challenge`, `adr`, `implement` and `govern` gain one instruction each: run `$AISDLC docs search <keywords>` before reading project documentation or opening ADRs by title alone, and read only the sections it returns. `init` offers the documentation index next to Graphify: it asks for the paths, passes them to `$AISDLC docs paths <path>...`, and leaves `docs.paths` unset if the user declines. Wording stays agent-neutral.
- **Areas:** `plugins/aisdlc/skills/{init,create-goal,challenge,adr,implement,govern}/SKILL.md`, `plugins/aisdlc/tests/skills.test.mjs`
- **Changes a screen:** no
- **Depends on:** 2
- **Acceptance:** the skills tests pass, including the check that every `$AISDLC …` span runs; no skill tells the agent to read the index file; `init` asks and never sets `docs.paths` without an answer; `docs paths <path>` appears in `init` as a complete, runnable invocation
- **Governor notes:** AGENTS.md: every `$AISDLC` span must be a complete, runnable invocation.
- **Review:** none run; the author checked the acceptance list against the tests only
- **Verification:** `npm test` exits 0 with 156 tests, 154 pass, 0 fail, 2 skipped (the ESLint template tests); `npm run validate` passes. The skills test ran every new `$AISDLC` span, and `skill-contracts.test.mjs` now pins the `docs search` line in the five skills and the `docs paths` ask in `init`.
- **Commit:** the commit on branch `docs-index` that holds this line
- **Task detail:** `init` gets a new step 4b after the knowledge graph, so the later step numbers are unchanged. Every other skill got one sentence in the place it already looks things up. No skill reads the index; each says never to.

### 4. Measure it

- **Status:** done, 2026-11-06
- **Scope:** `scripts/bench.mjs` keeps its positional goal counts and gains `--docs <line counts>` (default `1000,10000,100000`). For each size it builds a documentation corpus and reports build time, search time, and the approximate tokens a search prints against the tokens of the corpus. The numbers are recorded in this ledger.
- **Areas:** `scripts/bench.mjs`, this ledger
- **Changes a screen:** no
- **Depends on:** 2
- **Acceptance:** `npm run bench` exits 0 and prints the three rows, and `npm run bench -- 10,100,500` prints the same goal-scaling output as before this goal (compared with the baseline run); search output at 100K lines stays within the default budget; the recorded numbers are the ones the run printed
- **Governor notes:** These are the first measured figures for the "lower token cost" claim. Nothing is claimed before this runs.
- **Review:** none run; the author checked the acceptance list only
- **Verification:** `npm test` exits 0 with 156 tests, 154 pass, 0 fail, 2 skipped (the ESLint template tests); `npm run validate` passes; `npm run bench` exits 0 and prints the three rows below; the goal-scaling rows are unchanged from the baseline run (`create-goal up front` ~651, ~1,386, ~4,645). A bad argument prints the usage and exits 1.
- **Commit:** the commit on branch `docs-index` that holds this line
- **Task detail:** `bench.mjs` gained `--docs <line counts>`. The numbers below are the ones the run printed on this machine (times vary run to run; the token figures are exact for this corpus). The corpus is synthetic, 200 lines per file with a heading every ~12 lines, and the query `retention policy` matches about one section in forty, so a search always has more matches than the budget holds.

  ```
  measure | 1,000 lines | 10,000 lines | 100,000 lines
  files / sections | 5 / 85 | 50 / 850 | 500 / 8500
  corpus (tokens) | ~24,216 | ~242,000 | ~2,422,668
  index file (tokens, never read) | ~28,543 | ~285,337 | ~2,872,123
  docs sync, first build | 36 ms | 59 ms | 290 ms
  docs search, index fresh | 33 ms | 39 ms | 99 ms
  docs search after one edit | 37 ms | 66 ms | 316 ms
  search output (tokens) | ~1,473 | ~1,457 | ~1,475
  matches printed / more | 43 / 34 | 41 / 750 | 41 / 7764
  search output vs corpus | 6.08% | 0.60% | 0.06%
  ```

  Reading the numbers: a search prints about 1,470 tokens at every size, which is the default budget of 1,500 working, not a property of the index; at 1,000 lines that is 6% of the corpus, at 100,000 lines 0.06%. A rebuild after one edit re-parses every file (0.3 s at 100K lines), because the index is rebuilt whole. The index file is larger than the corpus and is never read by a skill.

  **Defect found by this sub-task:** the first run printed ~2,000 tokens against the 1,500 budget, because `docs search` counted each match as compact JSON while the output is indented. The cost now counts the printed form (fixed fields plus each match as indented), and a test checks that the printed output stays within the budget.

### 5. Documentation and release

- **Status:** pending
- **Scope:** README section for the documentation index and its config; AGENTS.md architecture and product-decision lines (the script owns the index; it is never read whole; `registry.md` still indexes only goals and ADRs); `aisdlc` changelog entry; version bump in the plugin manifest and both marketplace files.
- **Areas:** `README.md`, `AGENTS.md`, `plugins/aisdlc/CHANGELOG.md`, `plugins/aisdlc/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.github/plugin/marketplace.json`
- **Changes a screen:** no
- **Depends on:** 3, 4
- **Acceptance:** the release tests pass; the two marketplace files are identical; the README states that ADR bodies are always searchable, that project documentation is indexed only once `docs.paths` is set (with `docs paths`), what an entry may be, and the same-size-edit limit of the stamp, and quotes only the bench numbers from sub-task 4
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
| 2026-10-12 | Branch and version | New `docs-index` branch off `master`; `aisdlc` 0.16.0 (version superseded 2026-11-06) | all, 5 |
| 2026-10-12 | Does init offer it | Yes, as it offers Graphify | 3 |
| 2026-10-12 | ADRs with `docs.paths` unset | Always searchable | 1, 2 |
| 2026-11-06 | What a `docs.paths` entry is | Files and folders, folders recursive, no globs; bad entries are errors | 1 |
| 2026-11-06 | How staleness is detected | File list with size and mtime; same-size edit in one tick is a stated limit | 1, 2 |
| 2026-11-06 | How `docs.paths` is set | New `docs paths <path>...` command, used by init | 1, 3 |
| 2026-11-06 | Version after review | 0.24.0, replacing the released 0.16.0 | 5 |
