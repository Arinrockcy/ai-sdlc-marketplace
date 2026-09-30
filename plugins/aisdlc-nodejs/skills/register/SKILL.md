---
name: register
description: Register the Node.js stack with the aisdlc workflow in the current project. Installs .aisdlc/stacks/nodejs.json and configures the required ESLint and coverage quality gate for the project's package manager. Invoked by /aisdlc:init when the stack is nodejs, or directly with /aisdlc-nodejs:register.
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

2. **Inspect the quality tooling.** Read `scripts`, `dependencies`, and `devDependencies` in `package.json`, plus the ESLint and Jest configuration files.
   - ESLint is required. The `lint` script must lint the maintained source and test files and exit non-zero on errors. It must not use `--no-eslintrc`, ignore all source, or suppress errors globally.
   - The default test runner is Jest. The `test:coverage` script must run the suite with coverage enabled and enforce global minimums of 80% for branches, functions, lines, and statements. The thresholds may live in the Jest configuration or the command, but the command must fail below any threshold.
   - If either script or tool is absent, do not install or select a dependency silently. Continue to step 3.

3. **Ask before changing third-party tooling.** Present concrete choices, with the detected setup first:
   - **Recommended default:** use ESLint and Jest; show the packages, configuration, script changes, and exact install command that would be used.
   - **Use the project's alternative:** accept the lint or test/coverage library the user names. Preserve its conventions and require an equivalent zero-error lint gate plus 80% branches/functions/lines/statements coverage.
   - **User-owned implementation:** use or build the user's replacement only after they choose it. Its own module must have 100% unit coverage for branches, functions, lines, and statements, including negative cases. Add a deterministic performance test or benchmark when performance is one of the reasons for replacing the library.

   Explain briefly what each option handles and its trade-offs. Never install packages, rewrite configuration, or replace the user's selected library before they choose. ESLint remains required unless the user explicitly overrides this plugin policy.

4. **Configure scripts with approval.** After the user selects the tools, add or update `lint` and `test:coverage` only as authorized. Use the selected package manager so its lockfile is updated; never edit a lockfile by hand. If Jest is selected, configure `coverageThreshold.global` to at least:

   ```json
   { "branches": 80, "functions": 80, "lines": 80, "statements": 80 }
   ```

   Existing stricter thresholds win. Do not reduce them to 80%. Keep `test` available for fast local runs if the project already distinguishes it from the coverage gate.

5. **Write the stack manifest.** Copy `${CLAUDE_PLUGIN_ROOT}/stack.json` to `.aisdlc/stacks/nodejs.json` (create the folder if needed). Adapt both commands in `hooks.after_task.run` to the detected package manager:
   - npm: `npm run lint`, `npm run test:coverage`
   - pnpm: `pnpm run lint`, `pnpm run test:coverage`
   - yarn: `yarn run lint`, `yarn run test:coverage`
   - bun: `bun run lint`, `bun run test:coverage`

   If the user selected an alternative, keep the stable script names and make those scripts invoke it. This keeps the hook independent of the underlying tool.

6. **Keep the gate active.** Remove any `.aisdlc/config.json` `hooks.after_task` override that would shadow the stack hook. If one exists, show it to the user and ask before removing or changing it. Do not offer `None` as a normal setup choice: disabling this required gate needs an explicit user override.

7. **Report the result.** Show the two resolved `after_task` commands, selected lint and test tools, coverage thresholds, and any missing setup. Remind the user that `AISDLC_HOOK_AFTER_TASK="<cmd>"` (or `none`) is an explicit one-run override, not a change to the registered standard.
