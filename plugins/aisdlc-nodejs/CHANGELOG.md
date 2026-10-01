# Changelog: aisdlc-nodejs

All notable changes to the `aisdlc-nodejs` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.9.0] - 2026-10-01

### Added
- `sonar` skill for SonarQube Server/Cloud setup, LCOV import, credential handling, CI quality gates, and finding remediation.
- `vulnerabilities` skill for npm, pnpm, Yarn, and Bun audits, dependency remediation, advisory triage, and explicit exception handling.
- Opt-in `manifest scans --package-manager <manager> --sonar on|off --vulnerabilities on|off` wiring for project `sonar` and `security:audit` scripts. Enabled scans run after coverage, fail task verification on nonzero exit, and survive stack re-registration.
- Project inspection reports Sonar scanner dependencies/configuration and both scan scripts. Regression tests cover gate ordering, missing scripts, persistence, and scanner failure propagation.

### Fixed
- GitHub Copilot: `register`, `standards` and `express-rest-api` say to load a skill by its bare name (`standards`, not `aisdlc-nodejs:standards`), and to give the user unprefixed commands. Copilot's skill tool matches names exactly, so the prefixed name wasn't found.
- Aligned `stack.json` with the plugin release version so newly registered manifests report the release that wrote them. Older compatible manifests continue to work.

## [0.8.0] - 2026-10-01

### Added
- Dedicated JWT best-practices guidance for mutually exclusive token profiles, JOSE algorithm and header policy, claim validation, trusted JWKS lookup, issuance, rotation, revocation, browser storage, Express middleware integration, and adversarial tests.
- Explicit protection against ID/access/refresh-token substitution, algorithm and key-type confusion, attacker-directed key lookup, unbounded unknown-`kid` refresh, and treating a valid token as sufficient authorization.

## [0.7.2] - 2026-10-01

### Added
- GitHub Copilot support (`copilot plugin install aisdlc-nodejs@aisdlc-marketplace`). `register` and `standards` say what `${CLAUDE_PLUGIN_ROOT}` and `/plugin:skill` names stand for where the agent leaves them as written.

### Fixed
- `standards` failed to load in GitHub Copilot: its frontmatter `description` held an unquoted `: `, which strict YAML rejects. It is quoted now.

## [0.7.1] - 2026-10-01

### Removed
- `detect` and `"before_task": null` from `stack.json`. The core never read `detect` (stack detection uses its own marker list), and the `null` only repeated the core default while hiding any later one. Installed manifests that still have them work as before.

### Added
- Tests that `stack.json` sets only real hook points, and that `standards_skill` names this plugin's standards skill.

## [0.7.0] - 2026-09-30

### Added
- `standards` has Security, Process lifecycle, Logging and Package hygiene sections, with matching done-checklist items:
  - security: no shell or evaluator on input, parameterized queries, contained paths, prototype-safe merges, `node:crypto` for tokens and `timingSafeEqual` for secrets, bounded input, TLS verification always on, no secrets in logs
  - lifecycle: one class owns `SIGTERM`/`SIGINT` shutdown, `AbortSignal` with configured deadlines, a fatal handler only at the entry point, no `process.exit()` in library code, `pipeline` for streams
  - logging: the project's logger (asked for when there is none), structured events, levels by meaning, each error logged once with its cause
  - packages: `exports` with `types`, dependency placement, committed lockfile with frozen CI installs, no install scripts without approval
- The ESLint template also reports `eval`, `new Function` and string timers, `exec`/`execSync` from `node:child_process`, and `rejectUnauthorized: false`.

### Changed
- `standards` draws the line with the planned `dependency-guardian` plugin: these rules decide whether to take on a dependency, and the guardian decides whether a package version is safe. Without it, a package is checked for deprecation and advisories before it is offered.
- `$NODEJS template eslint` replaces an unedited copy from an earlier release (`inspect` reports it as `outdated`) instead of refusing it as modified. `register` asks first, because the newer rules can fail code that passed before.

## [0.6.0] - 2026-09-30

### Added
- `templates/eslint.aisdlc.mjs`, the lintable part of the standards as ESLint 9+ flat-config objects, using core rules only: inline arrow and anonymous functions, `process.env` outside `config/` and tests, built-ins without the `node:` prefix, CommonJS globals in ES modules, thrown literals, empty blocks, `console` calls, executor misuse and unused disable comments. Projects append `aisdlcStandards({ sourceType })` to their configuration, and add their own entries for the restriction rules through its options.
- `$NODEJS template eslint` copies the template to the project root, leaves a current copy alone, and refuses to overwrite a copy that differs. `inspect` reports it as `eslint_template`.

### Changed
- `register` offers the ESLint template as the recommended default and shows how to append it to the project's configuration. It asks before turning off `no-console` for a CLI, and before moving an `.eslintrc` project to flat config.
- `standards` tells the agent to fix code the template reports, not the template.

## [0.5.1] - 2026-09-30

### Added
- `inspect` reports `workspaces` (from `package.json` or `pnpm-workspace.yaml`) and `yarn_pnp`.

### Changed
- `register` asks how to gate a monorepo: one gate for the whole repository with a merged coverage report (recommended), or one package only. Before, it assumed a single package.
- `register` runs Jest with ES modules through `yarn node … $(yarn bin jest)` under Yarn Plug'n'Play, where `node_modules/jest` doesn't exist, and advises against `NODE_OPTIONS=…` in scripts because it fails in Windows shells.
- `register` names the ES module trade-off between Jest (experimental flag, its own mocking API) and Vitest or node:test (native) when it offers test runners. Jest stays the default.
- `register` makes the ignored coverage folder and the manifest's report path follow a custom coverage directory (Jest's `coverageDirectory`, Vitest's `coverage.reportsDirectory`).

## [0.5.0] - 2026-09-30

### Added
- `express-rest-api` skill for production Express API design and review, including HTTP contracts, middleware/error boundaries, authentication and authorization, sessions and tokens, abuse resistance, operations, and security-focused tests.
- Focused references for REST semantics, OAuth/OIDC and JWT or cookie-based authentication, object/tenant authorization, API keys and webhooks, Express proxy/CORS/parser hardening, observability, and graceful shutdown.
- `scripts/nodejs.mjs`, a zero-dependency helper the skills call as `$NODEJS`:
  - `inspect` reports the package manager (`packageManager`, then lockfiles, including `npm-shrinkwrap.json`), the Node.js version, `engines.node` and version pins, the module system and any CommonJS source, the gate scripts, tools and configuration files, whether `coverage/` is ignored, and what could bypass the gate (`stack` setting, config and environment overrides).
  - `manifest write` writes `.aisdlc/stacks/nodejs.json` with the package manager's commands, the module type, the tools, the coverage report and the thresholds. It refuses a threshold below the 80% floor or one the report format can't measure, and lists the metrics it left out.
  - `manifest check` compares the installed manifest's version with the oldest one this plugin accepts (0.4.0).
  - `baseline [--clean]` runs the gate commands and checks that the report was written by this run, parses and meets the thresholds. `--clean` first deletes the report's folder, only when git ignores it, to start like a fresh clone.

### Changed
- `register` gets its facts from `inspect`, writes the manifest with `manifest write` before the baseline, and runs the baseline with `baseline --clean`, instead of following these steps by hand.
- `standards` checks the manifest with `manifest check`, by version, instead of looking for the `runtime` and `coverage_report` fields. A manifest from an older but still compatible release keeps working, with a note that re-registering picks up the changes.

## [0.4.1] - 2026-09-30

### Fixed
- `register`'s node:test command creates the `coverage` folder first. Node doesn't create it, so on a fresh clone the command failed before running a test.
- `register`'s node:test command enforces the thresholds with `--test-coverage-lines`, `--test-coverage-branches` and `--test-coverage-functions`. Before, it passed at any coverage.
- `register` makes coverage count every source file (Jest's `collectCoverageFrom`, Vitest's `coverage.include`, c8/nyc `--all`). Before, a module no test loaded was left out of the percentage. For node:test, which can't count such files, it tells the user.
- `register` checks that the workflow will use its manifest: the `stack` setting in a mixed repo, and an `AISDLC_HOOK_AFTER_TASK` override in the environment, besides the config override.

### Changed
- `standards` requires a test that loads every new source module, and forbids narrowing the coverage configuration to leave a file out.

## [0.4.0] - 2026-09-30

### Breaking
- The manifest declares the coverage report in `quality_gate.coverage_report` (`coverage/coverage-summary.json`, `json-summary`). aisdlc 0.8.0's `after_goal` hook fails for a manifest without it, and `standards` stops with a request to re-register.

### Changed
- `register` makes `test:coverage` write a coverage report file on every run: Jest's `json-summary` reporter by default, or LCOV for node:test. It checks that the file appears after the baseline run, records its path and format in the manifest, and offers to add the coverage directory to `.gitignore`.
- `standards` requires the coverage report to stay in place, and adds it to the done checklist.

## [0.3.0] - 2026-09-30

### Breaking
- Node.js 24 or later is required. `register` stops on an older `node`, and asks to set `engines.node` (and any `.nvmrc`, `.node-version` or Volta pin) to 24 or later.
- ES modules (`"type": "module"`) are the default. `register` asks when a project has no `type` or uses CommonJS, and CommonJS stays only as the user's recorded override. The choice goes in the manifest's new `runtime.module_type`, and `standards` stops with a request to re-register when a manifest has no `runtime`.

### Changed
- Declaration files are for editor completion only. JavaScript projects keep a handwritten `.d.ts` for each public module, but get no TypeScript tooling, `checkJs` or type-check gate, and ESLint no longer lints declarations there.
- `standards` covers Node 24 built-ins, file extensions in ESM import specifiers, `import.meta.dirname`, and mocking under Jest with ES modules. `register` runs Jest with `--experimental-vm-modules` for ES module projects.

## [0.2.1] - 2026-09-30

### Changed
- `register` runs `lint` and `test:coverage` once on the existing code. When the baseline fails, it says that every task's verify will fail until it is fixed, and offers to plan that fix as the first goal.
- `register` writes the chosen tools into the copied manifest's `quality_gate`: the selected `test_runner`, and only the coverage thresholds the command enforces. It says which metric was left out and why (node:test has no `statements` threshold). Before, the manifest kept `jest` and all four thresholds whatever was chosen.
- `register` asks the user to commit the manifest and tooling changes on their own, before a goal starts.

## [0.2.0] - 2026-09-30

### Breaking
- Replaced the optional `npm test --if-present` after-task hook with required `lint` and `test:coverage` scripts. Existing projects must re-register the Node.js stack and configure both scripts before task verification can pass.

### Added
- Required ESLint with zero errors and an 80% minimum for Jest coverage across branches, functions, lines, and statements.
- Class-oriented module design, named-function, purpose-grouped constant, external configuration, and JavaScript declaration-file standards.
- Dependency-choice prompts, 100% coverage for user-owned library replacements, and mock-based plus non-mocked data-driven test requirements.

## [0.1.0] - 2026-09-30

### Added
- `stack.json` manifest for the `nodejs` stack, with lifecycle hook overrides.
- `register` skill, which copies the manifest into the project's `.aisdlc/stacks/`.
- `standards` skill with Node.js coding and testing standards, loaded by `/aisdlc:implement`.
