# Changelog: dependency-guardian

All notable changes to the `dependency-guardian` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-07

### Added
- `parseCommandLine(line, { cwd })`, exported from `guardian.mjs`, the command parser that pre-install enforcement builds on. It is a pure function: it runs nothing, reads no file and expands nothing. It answers `{ actions, unjudgeable }`: each dependency-changing npm command with the directory it runs in, `global`, `workspaces`, `allWorkspaces`, `includeWorkspaceRoot`, `force` and its packages (`spec`, `name`, `range`, `alias`), and everything the hook must fail closed on, each with a `kind`, a `reason` and the command's text.
- Commands covered: `npm install` (`i`, `add`, `isntall`, `install-test` and every other alias or unique abbreviation npm resolves), `update`, `ci` (`clean-install`, `install-ci-test`), `audit fix`, `npx`, `npm exec` (`x`) and `npm init <initializer>` (checked as `create-<initializer>`). `npm install && npm test` yields the install alone; `npm test`, `npm run`, `npm uninstall` and every other command yield nothing.
- Options: `-w` and `--workspace` (repeatable, before or after the subcommand), `-ws`, `--include-workspace-root`, `--prefix` and `-C` (resolved against the working directory), `-g`, `--global` and `--location=global`, `--force`, `-p` and `--package` for `npx`, `-c` and `--call`, and `--no` and `-n`, which make `npx` download nothing. `npm_config_*` variables set the same things, and an option on the command line wins over one in the environment. Scoped packages, ranges, tags and `alias@npm:real@range` all parse, however they are quoted.
- Shell syntax: quoting and escapes, `;` `&&` `||` `|` `&` and newlines, `( … )` subshells, `$(…)`, backticks and `<(…)` (each parsed as commands of their own, so `echo $(npm i x)` is seen), redirections, here-documents, comments, `cd`, `pushd` and `popd` (tracked across a chain, undone by a subshell, a pipe or `&`), `NAME=value` prefixes, `export` and `unset`, the wrappers `env` (with `-C`), `sudo`, `doas`, `time`, `command`, `exec`, `nohup`, `nice`, `timeout`, `setsid`, `stdbuf` and `corepack`, `xargs` (its packages come from standard input), `bash -c` and its siblings, and `eval`.
- Fail closed (`unjudgeable`) on: a package name or version the shell expands (`$PKG`, `$(…)`, a glob, a brace list, `~`), an expanded `--workspace`, `--prefix`, `--registry` or `--global`, an npm subcommand that is a variable, packages from git, URLs, GitHub shorthands, local paths or tarballs, a name that is not a package name, an unknown option that comes straight before a word it might swallow (an unknown option anywhere else is read as a flag), a working directory that `cd` left unknown (`$DIR`, `~`, `-`), a wrapper option the parser does not know in front of npm, a dynamic command name next to a dependency verb, and a command line that does not parse. Dynamic values that do not decide what is installed (`--loglevel $L`, `npm test -- $FILE`, `eval "$(ssh-agent)"`) pass.

### Notes
- Out of scope, because they run code the command line does not show: scripts, `npm run`, aliases, `curl | sh`, and `npm link`, `npm dedupe` and `npm pkg set`. `scan --ci` backs these up.
- Nothing calls the parser yet: `hook` and `preflight` arrive in a later release.
- A `$(…)` or backtick inside a `bash -c` or `eval` string is read twice and reported once.

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
