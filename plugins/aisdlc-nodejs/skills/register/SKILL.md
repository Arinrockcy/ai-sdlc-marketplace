---
name: register
description: Register the Node.js stack with the aisdlc workflow in the current project. Checks for Node.js 24+, settles the module system (ES modules unless the user overrides), installs .aisdlc/stacks/nodejs.json, and configures the required ESLint and coverage quality gate for the project's package manager, including the coverage report that the after-goal check reads. Invoked by /aisdlc:init when the stack is nodejs, or directly with /aisdlc-nodejs:register.
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

2. **Runtime and module system.**
   - **Node.js 24+ is required.** Run `node --version`. If the major version is below 24, tell the user this stack needs Node.js 24 or later and stop until they upgrade. If `package.json` `engines.node` is missing or allows a version below 24, or a `.nvmrc`, `.node-version` or Volta pin names an older version, show the change to `>=24` (or `24` for a pin) and apply it once the user approves.
   - **ES modules are the default.** Read `package.json` `type`:
     - `"module"`: record `module`.
     - Missing or `"commonjs"`, with no CommonJS source yet: ask the user, with adding `"type": "module"` as the recommended default and keeping CommonJS as the override. Record the choice.
     - Missing or `"commonjs"`, with existing `require`/`module.exports` source: ask the user whether to keep CommonJS (the override) or move to ES modules. Moving is a code change, not part of registration: offer it as the first goal (`/aisdlc:create-goal`, once `/aisdlc:init` has finished), record `commonjs` for now, and tell the user to re-run this skill once the conversion lands.

3. **Inspect the quality tooling.** Read `scripts`, `dependencies`, and `devDependencies` in `package.json`, plus the ESLint and Jest configuration files.
   - ESLint is required. The `lint` script must lint the maintained source and test files and exit non-zero on errors. It must not use `--no-eslintrc`, ignore all source, or suppress errors globally.
   - The default test runner is Jest. The `test:coverage` script must run the suite with coverage enabled and enforce global minimums of 80% for branches, functions, lines, and statements. The thresholds may live in the Jest configuration or the command, but the command must fail below any threshold.
   - Coverage must count every maintained source file, including files no test imports. By default, runners measure only the files the tests load, so a new module without any test leaves the percentage unchanged. Check for Jest's `collectCoverageFrom` (or Vitest's `coverage.include`, or c8/nyc `--all` with `--include`) covering the source folders and leaving out tests, fixtures and generated files.
   - Every `test:coverage` run must also write a coverage report file, which the core `after_goal` hook checks before a goal completes. Supported formats: Istanbul's `json-summary` (`coverage/coverage-summary.json`) or an LCOV file. Check the runner's reporter configuration (Jest's `coverageReporters` and `coverageDirectory`) for one of them.
   - The coverage output directory must be ignored by git (`.gitignore`), so reports never show up in a goal's changes.
   - If either script or tool is absent, do not install or select a dependency silently. Continue to step 4.

4. **Ask before changing third-party tooling.** Present concrete choices, with the detected setup first:
   - **Recommended default:** use ESLint and Jest; show the packages, configuration, script changes, and exact install command that would be used.
   - **Use the project's alternative:** accept the lint or test/coverage library the user names. Preserve its conventions and require an equivalent zero-error lint gate plus 80% branches/functions/lines/statements coverage.
   - **User-owned implementation:** use or build the user's replacement only after they choose it. Its own module must have 100% unit coverage for branches, functions, lines, and statements, including negative cases. Add a deterministic performance test or benchmark when performance is one of the reasons for replacing the library.

   Explain briefly what each option handles and its trade-offs. Never install packages, rewrite configuration, or replace the user's selected library before they choose. ESLint remains required unless the user explicitly overrides this plugin policy.

5. **Configure scripts with approval.** After the user selects the tools, add or update `lint` and `test:coverage` only as authorized. Use the selected package manager so its lockfile is updated; never edit a lockfile by hand. If Jest is selected, configure `coverageThreshold.global` to at least:

   ```json
   { "branches": 80, "functions": 80, "lines": 80, "statements": 80 }
   ```

   Existing stricter thresholds win. Do not reduce them to 80%.

   Make coverage count every source file, not just the ones the tests load:
   - **Jest:** set `collectCoverageFrom` to the source globs, for example `["src/**/*.{js,mjs,cjs,ts}", "!**/*.test.*", "!**/*.d.ts"]`, adapted to the project's folders.
   - **Vitest:** set `coverage.include` to the same globs.
   - **c8 or nyc:** pass `--all` with `--include` for the source folders.
   - **node:test:** it can't report a file that no test loads, and `--test-coverage-include` only filters the files that were loaded. Tell the user that its thresholds miss untested modules, so the standards' rule that every source module has a test that loads it is checked in review, not by the gate.

   Make the coverage command write a report file:
   - **Jest:** add `json-summary` to `coverageReporters`. Setting `coverageReporters` replaces Jest's defaults (`clover`, `json`, `lcov`, `text`), so keep the reporters the project already uses and keep `text` for the console table, for example `["text", "lcov", "json-summary"]`. The report lands in `coverageDirectory` (default `coverage`) as `coverage-summary.json`.
   - **Vitest, c8 or nyc:** add the `json-summary` reporter.
   - **node:test:** write LCOV next to the console output, and enforce the thresholds with its coverage flags. Node doesn't create the report's folder, and the folder is ignored by git, so a fresh clone has none: create it first, in a way that also works in Windows shells. For example:

     ```
     node -e "fs.mkdirSync('coverage', { recursive: true })" && node --test --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info
     ```

     Escape the inner double quotes when this goes in `package.json`.

   If `.gitignore` doesn't cover the coverage directory, show the line to add and add it once the user approves. With ES modules, Jest needs Node's `--experimental-vm-modules` flag, so run it as, for example, `node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage`. Keep `test` available for fast local runs if the project already distinguishes it from the coverage gate.

6. **Check the baseline.** Run the two gate commands once on the current code, with the selected package manager (for example `npm run lint`, then `npm run test:coverage`). Then check that the coverage report file exists and was just written. Check a clean state too: delete the coverage directory and run `test:coverage` again, because a fresh clone has none. If the report is missing, the reporter configuration from step 5 is wrong: fix it (with the user's approval) and run the command again. If either command fails, show the output and tell the user that every task's verify will fail on it until it is fixed, whatever the task changes. Offer to make that fix the first goal (`/aisdlc:create-goal`, once `/aisdlc:init` has finished), so later goals don't inherit the failure. Don't fix it as part of registration, and don't lower a threshold to make it pass.

7. **Write the stack manifest.** Copy `${CLAUDE_PLUGIN_ROOT}/stack.json` to `.aisdlc/stacks/nodejs.json` (create the folder if needed). Adapt both commands in `hooks.after_task.run` to the detected package manager:
   - npm: `npm run lint`, `npm run test:coverage`
   - pnpm: `pnpm run lint`, `pnpm run test:coverage`
   - yarn: `yarn run lint`, `yarn run test:coverage`
   - bun: `bun run lint`, `bun run test:coverage`

   If the user selected an alternative, keep the stable script names and make those scripts invoke it. This keeps the hook independent of the underlying tool.

   Set `runtime.module_type` in the copy to the value recorded in step 2 (`module` or `commonjs`). Leave `runtime.node` at `>=24`.

   Then make `quality_gate` in the copy say what was chosen, because reviewers read it as the project's standard:
   - `linter` and `test_runner`: the selected tools (for example `node:test` instead of `jest`).
   - `coverage_report`: the file the `test:coverage` command writes, relative to the project root, and its format: `{"path": "coverage/coverage-summary.json", "format": "json-summary"}` for Jest, Vitest, c8 or nyc, or `{"path": "coverage/lcov.info", "format": "lcov"}` for node:test. The `after_goal` hook fails without it.
   - `coverage_thresholds`: the thresholds the `test:coverage` command actually enforces. Leave out a metric the selected runner can't enforce (node:test's coverage options cover lines, branches and functions, but not statements), and tell the user which one was left out and why.

8. **Keep the gate active.** Anything that stops the workflow from using this manifest turns the gate off without an error, so check each of these:
   - **Active stack.** Read `stack` in `.aisdlc/config.json`. The workflow uses this manifest when `stack` is `nodejs`, or when it is `auto` (or missing) and either `package.json` is the only stack marker in the project or `nodejs` is the only stack with a manifest in `.aisdlc/stacks/`. If `stack` names another stack, or several stacks are installed, ask the user whether Node.js should be the project's stack, and set `stack` to `nodejs` in `.aisdlc/config.json` once they approve.
   - **Config override.** A `hooks.after_task` entry in `.aisdlc/config.json` shadows the stack hook. If one exists, show it to the user and ask before removing or changing it.
   - **Environment override.** Check whether `AISDLC_HOOK_AFTER_TASK` is set in the environment (for example `printenv AISDLC_HOOK_AFTER_TASK`). If it is, tell the user that it replaces this gate for as long as it is set.

   Do not offer `None` as a normal setup choice: disabling this required gate needs an explicit user override. When `/aisdlc:init` invoked this skill, it checks the resolved hook afterwards.

9. **Report the result.** Show the Node.js version and module system, the two resolved `after_task` commands, the selected lint and test tools, the coverage report path and format, the coverage thresholds in the manifest (and any left out), which files coverage counts (and, for node:test, that untested modules aren't counted), the baseline result from step 6, and any missing setup. Tell the user to commit `.aisdlc/stacks/nodejs.json` and the tooling changes on their own, before a goal starts, so they don't end up in a goal's changes. Remind the user that `AISDLC_HOOK_AFTER_TASK="<cmd>"` (or `none`) is an explicit one-run override, not a change to the registered standard.
