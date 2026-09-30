---
name: register
description: Register the Node.js stack with the aisdlc workflow in the current project. Installs .aisdlc/stacks/nodejs.json (standards skill and hook overrides) with the correct package manager and test command. Invoked by /aisdlc:init when the stack is nodejs, or directly with /aisdlc-nodejs:register.
---

# aisdlc-nodejs: register

Prerequisite: `.aisdlc/` must exist. If it doesn't, tell the user to run `/aisdlc:init` first and stop.

1. **Package manager.** Detect it from the lockfile in the project root:

   | Lockfile | Manager |
   |----------|---------|
   | `pnpm-lock.yaml` | pnpm |
   | `yarn.lock` | yarn |
   | `bun.lockb` or `bun.lock` | bun |
   | `package-lock.json` or none | npm |

   If `package.json` has a `packageManager` field, it takes priority.
   If there is no `packageManager` field and more than one lockfile exists, ask the user which manager the project uses.

2. **Test command.** Read `scripts` in `package.json` and pick the default after-task command:
   - If `scripts.test` exists and isn't npm's placeholder (`echo "Error: no test specified" && exit 1`), use `<pm> test` (for npm, `npm test`).
   - If there is no usable test script, the plugin default is `npm test --if-present`. That command does nothing useful, so point this out.

3. **Ask the user** which after-task verification to use:
   - **nodejs plugin default:** the command from step 2, stored in the stack manifest.
   - **Their own setup,** for example `npx jest --ci`, `npx vitest run`, or `npm run lint && npm test`. This goes into project config, so it overrides the stack.
   - **None:** disable the after-task hook.

   Mention the other scripts found in `package.json` (`lint`, `typecheck`, `build`) and offer to chain them.

4. **Write the stack manifest.** Copy `${CLAUDE_PLUGIN_ROOT}/stack.json` to `.aisdlc/stacks/nodejs.json` (create the folder if needed). If the default command from step 2 differs from the file's value, update `hooks.after_task.run` in the copy.

5. **Apply the user's choice** by editing `.aisdlc/config.json`. Keep all other keys.
   - **Own setup:** set `hooks.after_task` in `.aisdlc/config.json` to `{"run": "<their command>"}`.
   - **None:** set `hooks.after_task` to `null`.
   - **Default:** make sure `.aisdlc/config.json` has no `hooks.after_task` key, so the stack manifest applies.

6. Report the resolved `after_task` command. Remind the user they can override it for one run with `AISDLC_HOOK_AFTER_TASK="<cmd>"` (or `none`).
