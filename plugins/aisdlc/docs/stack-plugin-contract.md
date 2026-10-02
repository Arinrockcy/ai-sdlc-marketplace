# Stack Plugin Contract

The core `aisdlc` plugin is stack-agnostic. Stack knowledge (standards and verification commands) comes from separate plugins named `aisdlc-<stack>`, for example `aisdlc-nodejs`.

## Required contents

```
plugins/aisdlc-<stack>/
  .claude-plugin/plugin.json
  stack.json                 # manifest (below)
  skills/<stack>-register/SKILL.md   # installs the manifest into a project
  skills/<stack>-standards/SKILL.md  # coding/testing standards loaded by /aisdlc:implement
  scripts/                   # optional: the plugin's deterministic steps
```

A stack plugin can't run the core script (`${CLAUDE_PLUGIN_ROOT}` points to the stack plugin), so deterministic work in its skills (detecting the package manager, writing the manifest, running the baseline) goes in its own zero-dependency script, with tests. `aisdlc-nodejs/scripts/nodejs.mjs` is the reference. The manifest's `version` records the plugin release that wrote it; the plugin compares it with the oldest version it still accepts, instead of checking for individual fields.

Skills must work in GitHub Copilot too. It installs plugins from the same marketplace, but leaves `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` as written, calls and loads skills by their bare name only (`<stack>-standards`, not `aisdlc-<stack>:<stack>-standards`), and skips a skill whose frontmatter isn't strict YAML. With two installed plugins that have a skill of the same name, it keeps one and drops the other without a warning, so a stack plugin names its skills after its stack (`nodejs-register`, not `register`). Copy the preamble of `aisdlc-nodejs`'s skills, and quote a frontmatter value that contains `: `. The core's `tests/skills.test.mjs` checks every plugin's skills for both.

## `stack.json`

```json
{
  "name": "<stack>",
  "version": "0.1.0",
  "markers": ["<root file>", "*.<extension>"],
  "standards_skill": "aisdlc-<stack>:<stack>-standards",
  "quality_gate": {
    "coverage_report": { "path": "<report file>", "format": "json-summary" | "lcov" },
    "coverage_thresholds": { "lines": 80, "branches": 80, "functions": 80 }
  },
  "hooks": {
    "after_task": { "run": "<test command that writes the coverage report>" }
  }
}
```

- `name` must match the value `aisdlc.mjs detect-stack` reports and the `stack` value in `.aisdlc/config.json`.
- `markers` lists the files in a project's root that show it uses the stack: a file name, or `*.<extension>` for any root file with that extension. The core script finds installed stack plugins and reads their `stack.json` for these markers, so a new stack needs no core change. Markers add to the core's built-in `STACK_MARKERS`, which also report stacks whose plugin isn't installed. If two installed plugins declare the same `name`, the first one found is used.
- Every detected stack with a manifest in `.aisdlc/stacks/` is active, plus the stacks `stack` in `.aisdlc/config.json` names (a name or a list). With nothing registered or configured, a single detected stack is active. Several stacks can be active at once: each one's standards skill loads, the stack hook layer runs each one's commands in turn, and `coverage check` checks each one's report.
- `hooks` can set any hook point listed in `defaults/hooks.json`. Set only the points the stack changes: a point the manifest leaves out falls through to the core default, so a later core default still applies. Each value has the same form as in config: `{"run": "cmd" | ["cmd", ...]}`, `{"use": "default"}`, or `null`.
- Hook commands can use these variables: `{base_branch}`, `{branch_prefix}`, `{goal_id}`, `{goal_slug}`, `{goal_branch}`, `{task_id}` and `{aisdlc}` (the core script, run with the same Node).
- `quality_gate.coverage_report` is required. It names the coverage report, relative to the project root, that the stack's test command writes on every run. `format` is one of:
  - `json-summary`: Istanbul's summary (`coverage/coverage-summary.json`), written by Jest, Vitest, c8 and nyc. It measures lines, statements, functions and branches.
  - `lcov`: an LCOV tracefile, written by node:test, c8, pytest-cov and most other runners. It measures lines, functions and branches, but not statements.

  To support another format, add a parser to `COVERAGE_FORMATS` in `scripts/aisdlc.mjs`.
- `quality_gate.coverage_thresholds` maps each metric to its minimum percentage. List only metrics the report measures and the test command enforces.

## Coverage report

The stack's `after_task` hook (its test command) must write the report named in `coverage_report` each time it runs, also on a fresh clone where the coverage directory doesn't exist yet. Its `<stack>-register` skill configures the runner to do that, and checks that the file appears after the baseline run. The coverage directory belongs in `.gitignore`. Where the runner allows it, the report counts every source file, not only the ones the tests load, so an untested module lowers the figures.

The core `after_goal` default runs `aisdlc.mjs coverage check <G-id>` before a goal completes, then `aisdlc.mjs goal push <G-id>`, which pushes the goal branch (never the base branch). The check fails when:
- the manifest declares no `coverage_report`, or an unknown format
- the report is missing or can't be parsed
- the report is older than a file the goal changed, so it may not cover the finished code
- a metric in `coverage_thresholds` is missing from the report or below its minimum

Without a stack manifest, the check passes with a note, because nothing is declared.

## How it is wired

1. `/aisdlc:init` detects the project's stacks and invokes `aisdlc-<stack>:<stack>-register` for each one whose plugin is installed, without asking first. `/aisdlc:create-goal` and `/aisdlc:implement` do the same for a stack plugin installed later (`detect-stack` lists them under `to_register`).
2. `<stack>-register` copies `stack.json` to `.aisdlc/stacks/<stack>.json` in the project. It can adapt the file first (for example, choosing the package manager). From the plugin the core script reads only `stack.json` and the plugin manifest; it runs from the project's manifest. `<stack>-register` can't run the core script, so `/aisdlc:init` checks afterwards that the stack is active and that `after_task` resolves to the stack's hook.
3. `/aisdlc:implement` reads `standards_skills` via `detect-stack` and invokes each before coding.
4. `/aisdlc:implement` runs `after_task` (via `task verify`) after each task, and `after_goal` (coverage check, then push) before completing the goal.

## Hook precedence

Each hook point resolves in this order: env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` `hooks` > `.aisdlc/stacks/<stack>.json` `hooks` > core `defaults/hooks.json`. A `{"use": "stack"}` value defers to the stack manifest, and `{"use": "default"}` defers to core defaults.
