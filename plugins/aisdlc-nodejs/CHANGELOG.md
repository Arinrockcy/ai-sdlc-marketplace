# Changelog: aisdlc-nodejs

All notable changes to the `aisdlc-nodejs` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-09-30

### Added
- `express-rest-api` skill for production Express API design and review, including HTTP contracts, middleware/error boundaries, authentication and authorization, sessions and tokens, abuse resistance, operations, and security-focused tests.
- Focused references for REST semantics, OAuth/OIDC and JWT or cookie-based authentication, object/tenant authorization, API keys and webhooks, Express proxy/CORS/parser hardening, observability, and graceful shutdown.

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
