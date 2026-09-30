# Stack Plugin Contract

The core `aisdlc` plugin is stack-agnostic. Stack knowledge (standards and verification commands) comes from separate plugins named `aisdlc-<stack>`, for example `aisdlc-nodejs`.

## Required contents

```
plugins/aisdlc-<stack>/
  .claude-plugin/plugin.json
  stack.json                 # manifest (below)
  skills/register/SKILL.md   # installs the manifest into a project
  skills/standards/SKILL.md  # coding/testing standards loaded by /aisdlc:implement
```

## `stack.json`

```json
{
  "name": "<stack>",
  "version": "0.1.0",
  "detect": ["<marker file>"],
  "standards_skill": "aisdlc-<stack>:standards",
  "hooks": {
    "after_task": { "run": "<test command>" }
  }
}
```

- `name` must match the value `aisdlc.mjs detect-stack` reports and the `stack` value in `.aisdlc/config.json`. To detect a new stack, add its marker file to `STACK_MARKERS` in `scripts/aisdlc.mjs`.
- `hooks` can set any hook point listed in `defaults/hooks.json`. Each value has the same form as in config: `{"run": "cmd" | ["cmd", ...]}`, `{"use": "default"}`, or `null`.
- Hook commands can use these variables: `{base_branch}`, `{branch_prefix}`, `{goal_id}`, `{goal_slug}`, `{goal_branch}` and `{task_id}`.

## How it is wired

1. `/aisdlc:init` detects the stack and invokes `aisdlc-<stack>:register` if that skill is installed.
2. `register` copies `stack.json` to `.aisdlc/stacks/<stack>.json` in the project. It can adapt the file first (for example, choosing the package manager). The core script only ever reads project-local files, so it doesn't need to know where plugins are installed.
3. `/aisdlc:implement` reads `standards_skill` via `detect-stack` and invokes it before coding.

## Hook precedence

Each hook point resolves in this order: env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` `hooks` > `.aisdlc/stacks/<stack>.json` `hooks` > core `defaults/hooks.json`. A `{"use": "stack"}` value defers to the stack manifest, and `{"use": "default"}` defers to core defaults.
