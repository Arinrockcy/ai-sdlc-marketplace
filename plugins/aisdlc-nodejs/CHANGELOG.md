# Changelog: aisdlc-nodejs

All notable changes to the `aisdlc-nodejs` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-30

### Added
- `stack.json` manifest for the `nodejs` stack, with lifecycle hook overrides.
- `register` skill, which copies the manifest into the project's `.aisdlc/stacks/`.
- `standards` skill with Node.js coding and testing standards, loaded by `/aisdlc:implement`.
