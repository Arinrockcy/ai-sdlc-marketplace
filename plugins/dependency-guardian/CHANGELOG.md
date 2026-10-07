# Changelog: dependency-guardian

All notable changes to the `dependency-guardian` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-07

### Added
- `scripts/guardian.mjs`, a zero-dependency Node.js 24+ script, with `validate-policy`: it checks the npm catalog, the project's `.dependency-guardian/config.json` and every waiver, and exits 0 when valid, 1 when a waiver has expired and 2 when anything is malformed. `scan`, `preflight` and `hook` exist as commands but exit 2 with "not implemented yet" until a later release.
- Strict option parsing: unknown options fail, `--ci`, `--json`, `--signatures` and `--offline` are flags, `--workspace` takes a value, and everything after `--` is passed through untouched.
- `catalog/npm.json`, the managed catalog, seeded with the reviewed Moment.js rule (`NPM-MOMENT`): direct use is denied, transitive use warns, and the alternatives (Intl and Date, Temporal, date-fns, Luxon, Day.js) say when each fits. Every catalog rule needs a rationale, https sources and a review date.
- The project's configuration (`.dependency-guardian/config.json`): audit level (`moderate` by default), deprecation action (`deny`), outdated action (`warn`), workspaces, signature enforcement, organization rules and timed waivers. Unknown fields are errors.
- Waivers need `ruleId`, `package`, `owner`, `reason` and `expiresAt`, name one known rule and one package (no patterns), and last through the end of their `expiresAt` day in UTC.

## [0.1.0] - 2026-10-07

### Added
- Initial scaffold of the plugin.
