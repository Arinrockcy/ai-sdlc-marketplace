---
name: register
description: Register the Node.js stack with the aisdlc workflow in the current project. Checks for Node.js 24+, settles the module system (ES modules unless the user overrides), installs .aisdlc/stacks/nodejs.json, and configures the required ESLint and coverage quality gate for the project's package manager, including the coverage report that the after-goal check reads. Invoked by /aisdlc:init when the stack is nodejs, or directly with /aisdlc-nodejs:register.
---

# aisdlc-nodejs: register

`$NODEJS` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/nodejs.mjs"`. Run it from the project root. It prints JSON.

Prerequisite: `.aisdlc/` must exist. If it doesn't, tell the user to run `/aisdlc:init` first and stop.

1. **Inspect the project.** Run `$NODEJS inspect`. It reports the facts the next steps decide on: `package_manager`, `workspaces`, `yarn_pnp`, `node`, `engines`, `version_pins`, `module`, `scripts`, `tools`, `config_files`, `coverage_dir_ignored`, `eslint_template`, `workflow` and `manifest`. Run it again after a change, rather than re-reading the files.

2. **Package manager.** Use `package_manager.name`. It comes from the `packageManager` field first, then from the lockfiles, and is npm when there is neither. If `name` is null (lockfiles for several managers, or a `packageManager` the plugin doesn't support), ask the user which manager the project uses. Show any `notes`, for example a lockfile that disagrees with `packageManager`.

   **Workspaces.** If `workspaces` is set, the project is a monorepo. The hooks run from the project root, and the manifest names a single coverage report, so ask the user how to gate it, with the first option as the recommended default:
   - **One gate for the whole repository:** root `lint` and `test:coverage` scripts that cover every package and write one merged report, for example Jest's `projects` or Vitest's `projects`, with coverage collected at the root. Thresholds then apply to the repository as a whole.
   - **One package only:** the root scripts run that package's commands (for example `npm run lint -w <package>`, `pnpm --filter <package> run test:coverage`), and the report path points inside it (`packages/<package>/coverage/...`). The other packages get no gate.

   Record the choice for the report in step 10. Don't pick one for the user.

3. **Runtime and module system.**
   - **Node.js 24+ is required.** If `node.ok` is false, tell the user this stack needs Node.js 24 or later and stop until they upgrade. If `engines.ok` or a `version_pins` entry's `ok` is false, show the change to `>=24` (or `24` for a pin) and apply it once the user approves. When `ok` is null, the script couldn't read the range or pin (for example `lts/*`): show it and ask the user whether it resolves to Node.js 24 or later.
   - **ES modules are the default.** Use `module.type`:
     - `"module"`: record `module`.
     - Null or `"commonjs"`, with `module.commonjs_files` at 0: ask the user, with adding `"type": "module"` as the recommended default and keeping CommonJS as the override. Record the choice.
     - Null or `"commonjs"`, with CommonJS source (`module.commonjs_examples` names some): ask the user whether to keep CommonJS (the override) or move to ES modules. Moving is a code change, not part of registration: offer it as the first goal (`/aisdlc:create-goal`, once `/aisdlc:init` has finished), record `commonjs` for now, and tell the user to re-run this skill once the conversion lands.
     - `"module"` with CommonJS source in `.js` files: the two disagree. Show the examples and ask the user how to resolve it before going on.

4. **Check the quality tooling.** Start from `scripts`, `tools` and `config_files`, and read the configuration files they name.
   - ESLint is required. The `lint` script must lint the maintained source and test files and exit non-zero on errors. It must not use `--no-eslintrc`, ignore all source, or suppress errors globally.
   - The default test runner is Jest. The `test:coverage` script must run the suite with coverage enabled and enforce global minimums of 80% for branches, functions, lines, and statements. The thresholds may live in the Jest configuration or the command, but the command must fail below any threshold.
   - Coverage must count every maintained source file, including files no test imports. By default, runners measure only the files the tests load, so a new module without any test leaves the percentage unchanged. Check for Jest's `collectCoverageFrom` (or Vitest's `coverage.include`, or c8/nyc `--all` with `--include`) covering the source folders and leaving out tests, fixtures and generated files.
   - Every `test:coverage` run must also write a coverage report file, which the core `after_goal` hook checks before a goal completes. Supported formats: Istanbul's `json-summary` (`coverage/coverage-summary.json`) or an LCOV file. Check the runner's reporter configuration (Jest's `coverageReporters` and `coverageDirectory`) for one of them.
   - The coverage output directory must be ignored by git (`.gitignore`), so reports never show up in a goal's changes. `coverage_dir_ignored` says whether `coverage/` is. When the runner writes elsewhere (Jest's `coverageDirectory`, Vitest's `coverage.reportsDirectory`, a workspace package's folder), that folder is the one to ignore, and the report path in step 7 follows it.
   - If either script or tool is absent, do not install or select a dependency silently. Continue to step 5.

5. **Ask before changing third-party tooling.** Present concrete choices, with the detected setup first:
   - **Recommended default:** use ESLint and Jest; show the packages, configuration, script changes, and exact install command that would be used.
   - **Use the project's alternative:** accept the lint or test/coverage library the user names. Preserve its conventions and require an equivalent zero-error lint gate plus 80% branches/functions/lines/statements coverage.
   - **User-owned implementation:** use or build the user's replacement only after they choose it. Its own module must have 100% unit coverage for branches, functions, lines, and statements, including negative cases. Add a deterministic performance test or benchmark when performance is one of the reasons for replacing the library.

   Explain briefly what each option handles and its trade-offs. With ES modules, include this one: Jest runs them only behind Node's experimental `--experimental-vm-modules` flag, with its own mocking API (`jest.unstable_mockModule`), while Vitest and node:test run them natively. Jest stays the default unless the user picks another. Never install packages, rewrite configuration, or replace the user's selected library before they choose. ESLint remains required unless the user explicitly overrides this plugin policy.

6. **Configure scripts with approval.** After the user selects the tools, add or update `lint` and `test:coverage` only as authorized. Use the selected package manager so its lockfile is updated; never edit a lockfile by hand. If Jest is selected, configure `coverageThreshold.global` to at least:

   ```json
   { "branches": 80, "functions": 80, "lines": 80, "statements": 80 }
   ```

   Existing stricter thresholds win. Do not reduce them to 80%.

   **ESLint rules for the standards.** The plugin ships `eslint.aisdlc.mjs`, which turns the lintable part of the standards into errors using core ESLint rules only: inline callbacks, `process.env` outside `config/` and tests, built-ins without the `node:` prefix, CommonJS globals in ES modules, thrown literals, empty `catch` blocks, `console` calls and unused disable comments. It needs ESLint 9 or later with a flat config (`eslint.config.*`). Offer it, as the recommended default, and add it only once the user agrees:
   - Run `$NODEJS template eslint`. It copies the template to the project root, leaves a current copy alone, and refuses to overwrite a copy that differs (`eslint_template` is `modified`). Show the user that difference, and replace the copy only with their approval.
   - Append it to the project's configuration, with `sourceType` set to the module system from step 3. In an ES module config: `import aisdlcStandards from './eslint.aisdlc.mjs';` and `...aisdlcStandards({ sourceType: 'module' })` at the end of the exported array. In a CommonJS config: `const aisdlcStandards = require('./eslint.aisdlc.mjs').default;`. Without any ESLint configuration, create `eslint.config.mjs` with it, plus `@eslint/js`'s recommended rules if the user wants them (that's another package to approve).
   - If the project already sets `no-restricted-syntax`, `no-restricted-imports`, `no-restricted-properties` or `no-restricted-globals`, pass its entries through the template's matching option (`restrictedSyntax`, `restrictedImports`, `restrictedProperties`, `restrictedGlobals`), because ESLint replaces a rule's options instead of merging them. Pass `files`, `configFiles` or `testFiles` when the project's layout differs from the defaults in the template.
   - A project that prints to the console on purpose (a CLI) needs `no-console` turned off for those files, with a comment giving the reason. Ask before adding it.
   - With `.eslintrc*` (ESLint 8 or earlier), the template doesn't load. Ask whether to move to flat config first, or leave these rules to review for now.

   Existing code often breaks these rules. The baseline in step 8 shows how much; don't weaken a rule to make it pass.

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

   If `.gitignore` doesn't cover the coverage directory, show the line to add and add it once the user approves. With ES modules, Jest needs Node's `--experimental-vm-modules` flag, so run it as, for example, `node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage`. Under Yarn Plug'n'Play (`yarn_pnp` is true) there is no `node_modules/jest`: use `yarn node --experimental-vm-modules $(yarn bin jest) --coverage` instead. Don't use `NODE_OPTIONS=... jest`, which fails in Windows shells unless another dependency sets the variable. Keep `test` available for fast local runs if the project already distinguishes it from the coverage gate.

7. **Write the stack manifest.** Run:

   `$NODEJS manifest write --package-manager npm|pnpm|yarn|bun --module-type module|commonjs --format json-summary|lcov --report <path> [--linter <name>] [--test-runner <name>] [--thresholds lines=80,branches=80,functions=80,statements=80]`

   It copies `${CLAUDE_PLUGIN_ROOT}/stack.json` to `.aisdlc/stacks/nodejs.json` and fills in what was chosen, because the hooks run it and reviewers read it as the project's standard:
   - `--package-manager`: from step 2. The `after_task` commands become `<manager> run lint` and `<manager> run test:coverage`. If the user selected an alternative tool, keep these script names and make the scripts invoke it, so the hook stays independent of the tool.
   - `--module-type`: the value recorded in step 3.
   - `--report` and `--format`: the file the `test:coverage` command writes, relative to the project root. That is `coverage/coverage-summary.json` with `json-summary` for Jest, Vitest, c8 or nyc (under a custom `coverageDirectory`, that folder instead), or `coverage/lcov.info` with `lcov` for node:test.
   - `--linter` and `--test-runner`: the selected tools when they aren't ESLint and Jest (for example `--test-runner node:test`).
   - `--thresholds`: the thresholds the `test:coverage` command actually enforces, when they differ from the 80% floor (for example a stricter project setting, or a metric the runner can't enforce). Without it, the manifest gets the floor for every metric the report format measures.

   The script refuses a threshold below the floor, or one the format can't measure. Tell the user about each metric in `left_out` and why (node:test's coverage options cover lines, branches and functions, but not statements).

8. **Check the baseline.** Run `$NODEJS baseline --clean`. It deletes the coverage report's folder (only what git ignores, like a fresh clone), runs the manifest's `after_task` commands once on the current code, and checks that the report was written by this run, parses, and meets the thresholds. If it refuses to delete the folder because git doesn't ignore it, go back to step 6's `.gitignore` change, or run `$NODEJS baseline` without cleaning if the user declined it.
   - If the report is missing or wasn't rewritten, the reporter configuration from step 6 is wrong: fix it (with the user's approval) and run the baseline again.
   - If a command fails or coverage is below a threshold, show the `problems` and the failing command's `output_tail`, and tell the user that every task's verify will fail on it until it is fixed, whatever the task changes. Offer to make that fix the first goal (`/aisdlc:create-goal`, once `/aisdlc:init` has finished), so later goals don't inherit the failure. Don't fix it as part of registration, and don't lower a threshold to make it pass.

9. **Keep the gate active.** Anything that stops the workflow from using this manifest turns the gate off without an error, so check each of these:
   - **Active stack.** Run `$NODEJS inspect` again and read `workflow`. The workflow uses this manifest when `configured_stack` is `nodejs`, or when it is `auto` and either `package.json` is the only stack marker in the project or `nodejs` is the only entry in `installed_stack_manifests`. If `configured_stack` names another stack, or several stacks are installed, ask the user whether Node.js should be the project's stack, and set `stack` to `nodejs` in `.aisdlc/config.json` once they approve.
   - **Config override.** When `workflow.config_after_task.set` is true, `hooks.after_task` in `.aisdlc/config.json` shadows the stack hook. Show its `value` to the user and ask before removing or changing it.
   - **Environment override.** When `workflow.env_after_task.set` is true, `AISDLC_HOOK_AFTER_TASK` replaces this gate for as long as it is set. Tell the user.

   Do not offer `None` as a normal setup choice: disabling this required gate needs an explicit user override. When `/aisdlc:init` invoked this skill, it checks the resolved hook afterwards.

10. **Report the result.** Show the Node.js version and module system, the two resolved `after_task` commands, the selected lint and test tools, whether the ESLint template is in the configuration, the coverage report path and format, the coverage thresholds in the manifest (and any left out), which files coverage counts (and, for node:test, that untested modules aren't counted), the baseline result from step 8, how a monorepo is gated (step 2), and any missing setup. Tell the user to commit `.aisdlc/stacks/nodejs.json` and the tooling changes on their own, before a goal starts, so they don't end up in a goal's changes. Remind the user that `AISDLC_HOOK_AFTER_TASK="<cmd>"` (or `none`) is an explicit one-run override, not a change to the registered standard.
