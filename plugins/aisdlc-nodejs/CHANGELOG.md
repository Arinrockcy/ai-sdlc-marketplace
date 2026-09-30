# Changelog: aisdlc-nodejs

All notable changes to the `aisdlc-nodejs` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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
