# Changelog: dependency-guardian

All notable changes to the `dependency-guardian` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-07

### Added
- `scan [--ci] [--json] [--workspace <name>] [--signatures] [--offline]` assesses the project's locked dependency tree and exits 0 (pass), 1 (blocking findings) or 2 (invalid configuration, unreadable lockfile, unsupported npm output or an incomplete assessment). It reads `package-lock.json` (lockfile v2 or v3) for every package and its version, runs `npm audit --json --audit-level=<level>`, `npm outdated --json` and, for each direct dependency, `npm view <name>@<version> deprecated --json` (4 at a time), all without a shell, and never runs anything that changes the project. A missing lockfile is an error that names the safe command to create one.
- Findings carry an ID, rule, source, package and version, direct or transitive relationship, dependency type, severity, action, evidence, remediation, alternatives and waiver state. The result is `schemaVersion`, `status`, `projectRoot`, `toolVersions`, `summary`, `findings`, plus `offline`, `complete` and `errors`. A scan that cannot start still answers in JSON when `--json` was given.
- Blocking by default: catalog and organization `deny` rules, direct dependencies whose resolved version is deprecated, `npm audit` findings at `moderate` or above (`auditLevel` is configurable; lower ones are informational), packages installed from git or a bare tarball, which `npm audit` cannot assess (`GUARD-SOURCE`), invalid registry signatures, and expired waivers (`GUARD-WAIVER`, which cannot itself be waived). Warnings: outdated direct dependencies (`outdated` can be set to `deny` or `off`), deprecated transitive dependencies (read from the lockfile, which npm fills in), catalog `warn` rules such as a transitive Moment.js, and missing signatures unless `signatures` is enforced in the configuration.
- Active waivers make a finding non-blocking and stay visible on it, scoped to their rule and package. An expired waiver blocks again.
- `--offline` runs no npm: it checks the catalog, the lockfile's deprecations and sources, and says what it skipped. It can report `pass` but with `complete: false`, and `--ci --offline` always exits 2.
- A blocking finding takes precedence over an incomplete assessment (exit 1 with `errors` listed); with no blocking finding, an incomplete assessment exits 2.
- Credentials never reach the report: npm's error text is redacted for `_authToken` lines, `user:password@` URLs and `npm_` tokens, and `.npmrc` is never read.

### Notes
- `--signatures` (or `signatures: true`) calls `npm audit signatures`, which needs installed packages: run it after `npm ci`.
- Tested against deterministic fakes of `npm`, with the npm 11 audit report and lockfile captured from a real run as fixtures. npm 7 to 10 use the same audit report format (`auditReportVersion` 2) but their output was not captured. Output from npm 6 is rejected as unsupported.
- Windows is not supported yet: npm is run as `npm` without a shell.

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
