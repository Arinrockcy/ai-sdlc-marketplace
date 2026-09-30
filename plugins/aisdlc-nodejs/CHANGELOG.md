# Changelog: aisdlc-nodejs

All notable changes to the `aisdlc-nodejs` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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
