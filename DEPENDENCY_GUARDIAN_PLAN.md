# Dependency Guardian — npm Maintenance and Vulnerability Plugin

## Summary

Create a standalone Claude Code plugin named `dependency-guardian` in this marketplace. It will:

- Detect vulnerable, deprecated, outdated, or explicitly discouraged npm packages.
- Block unsafe agent-issued installs before they modify the project.
- Support manual and automatic invocation through `/dependency-guardian:audit`.
- Provide a dependency-free scanner that can be committed into adopting repositories and run in CI.
- Suggest alternatives and apply fixes only after explicit approval.
- Use an ecosystem-adapter design so Maven, Gradle, and other package managers can be added later.

V1 is Claude-first. The skill instructions and scanner output remain agent-neutral so later Codex and other Agent Skills adapters can reuse them. Claude skills support both direct slash-command and automatic invocation, while `PreToolUse` hooks provide deterministic blocking. ([Claude skills](https://code.claude.com/docs/en/skills), [Claude hooks](https://code.claude.com/docs/en/hooks))

## Implementation Changes

### Plugin packaging

Add `plugins/dependency-guardian/` with:

- Claude plugin manifest, version `0.1.0`.
- One `audit` skill, automatically discoverable and callable as `/dependency-guardian:audit`.
- Claude `PreToolUse` and `PostToolUse` hooks.
- A dependency-free Node.js 24+ scanner.
- A versioned npm policy catalog, tests, and changelog.
- Marketplace entry and README installation/usage documentation.

The skill supports:

- `/dependency-guardian:audit` — read-only full scan.
- `/dependency-guardian:audit setup` — with approval, vendor the scanner and policy catalog into the current repository and add an `npm run deps:check` script.
- `/dependency-guardian:audit fix` — prepare remediation, request approval, apply the approved changes, run project tests, and rescan.

Keep setup and remediation mutations approval-gated. Automatic invocation may inspect and recommend but must not silently install, uninstall, or upgrade packages.

### Shared scanner and public contract

The vendored scanner exposes:

```text
node .dependency-guardian/guardian.mjs scan [--ci] [--json] [--workspace <name>] [--signatures]
node .dependency-guardian/guardian.mjs preflight -- <npm-subcommand-and-arguments>
node .dependency-guardian/guardian.mjs validate-policy
```

Exit codes:

- `0`: scan passed.
- `1`: blocking policy findings.
- `2`: invalid configuration, unsupported npm output, registry failure, or incomplete assessment.

JSON output uses a stable versioned result:

```text
schemaVersion
status: pass | fail | error
projectRoot
toolVersions
summary
findings[]
```

Each finding includes an ID, source, package and version, direct/transitive relationship, dependency type, severity, action, evidence, remediation options, alternatives, and waiver state.

The scanner must never print `.npmrc` credentials, registry tokens, or environment secrets.

### Strict npm policy

Default blocking rules:

- Curated catalog entries marked `deny`.
- Direct dependencies whose resolved npm version is deprecated.
- `npm audit` findings at moderate, high, or critical severity.
- Invalid or expired waivers.
- Package sources that cannot be safely assessed, including unresolved shell substitutions or unsupported Git/tarball installs.

Warnings:

- Outdated direct dependencies.
- Transitive deprecated packages.
- Packages categorized as legacy or maintenance-only when the catalog does not make them a hard transitive failure.
- Missing optional registry signatures unless signature enforcement was explicitly requested.

Use:

- `npm audit --json --audit-level=moderate` for known vulnerabilities. npm audit evaluates the locked dependency tree, and `audit-level` changes the failure threshold rather than filtering the report. ([npm audit](https://docs.npmjs.com/cli/audit.html/))
- `npm outdated --json` for direct dependency freshness.
- `npm view <resolved-spec> deprecated --json` for direct-package deprecation metadata.
- `npm audit signatures` only when `--signatures` is requested because registry support varies.
- The local policy catalog for judgments npm metadata cannot express.

Document that npm audit does not cover peer dependencies and requires a lockfile. Missing lockfiles fail strict CI with instructions for creating one safely.

### Moment.js rule and suggestions

Seed the catalog with a reviewed Moment.js policy:

- Direct use: deny.
- Transitive use: warn.
- Rationale: Moment identifies itself as a legacy project in maintenance mode and discourages new adoption. ([Moment project status](https://momentjs.com/docs/))
- Suggestions:
  - Native `Intl`, `Date`, or Temporal where runtime support is sufficient.
  - `date-fns` for modular functional utilities.
  - Luxon for timezone and internationalization-oriented applications.
  - Day.js when a Moment-like API eases migration.

Do not automatically choose an alternative. The skill must inspect the project’s parsing, formatting, timezone, locale, mutability, and bundle requirements and ask the user to select from relevant options.

Catalog entries include a stable rule ID, package matcher, direct/transitive actions, rationale, alternatives with use-case notes, authoritative sources, and review date.

### Pre-install enforcement

The Claude `PreToolUse` hook inspects Bash calls involving:

- `npm install`, `npm i`, or `npm add`
- `npm update`
- `npm ci`
- `npm audit fix`
- `npm exec` and `npx` when a package is being downloaded

Before permitting a dependency-changing command:

1. Parse literal npm arguments without executing shell expansions.
2. Copy package manifests, lockfiles, and necessary workspace manifests into a temporary directory.
3. Reproduce the proposed resolution using `--package-lock-only`, `--ignore-scripts`, `--no-audit`, and `--no-fund`.
4. Run policy, deprecation, and audit checks against the candidate tree.
5. Compare it with the current baseline.
6. Deny commands that introduce or worsen blocking findings.

Existing findings do not prevent a remediation command that reduces them and introduces no new violations; full scans and CI still fail until all unwaived blockers are resolved.

Dynamic package names, command substitutions, or unsupported sources fail closed with a message explaining how to rerun using a literal package specification or a timed waiver. Temporary data must always be cleaned up, and preflight must never run dependency lifecycle scripts.

A `PostToolUse` hook rescans after successful npm mutations and returns findings to Claude. It is a verification layer, not the primary guard, because post-tool hooks cannot undo an installation.

### CI and cross-agent portability

`audit setup`, after approval:

- Creates `.dependency-guardian/guardian.mjs` and the managed npm catalog.
- Creates a project-owned configuration file.
- Adds `"deps:check": "node .dependency-guardian/guardian.mjs scan --ci"` unless that script name already exists.
- Preserves existing configuration on upgrades and replaces only versioned managed files.
- Reports, but does not automatically edit, the project’s CI-provider configuration.

Teams add `npm run deps:check` to their pipeline. This catches unsafe packages installed manually or by agents without Claude hooks and gives other agents a stable command to run.

### Configuration and waivers

Project configuration supports:

- Audit threshold, default `moderate`.
- Deprecation action, default `deny` for direct dependencies.
- Outdated action, default `warn`.
- Workspace selection.
- Optional signature enforcement.
- Organization-defined additional deny/warn rules.
- Timed waivers.

Every waiver requires:

```text
ruleId
package
owner
reason
expiresAt
```

A waiver applies only to the named rule and package. Missing, malformed, or expired waivers fail CI. Waivers cannot suppress scanner/configuration failures. The audit skill must request approval before creating or changing a waiver.

### Approved remediation workflow

For `/dependency-guardian:audit fix`:

1. Produce a read-only remediation plan first.
2. Group changes into:
   - Compatible `npm audit fix` updates.
   - Major or `--force` audit updates.
   - Deprecated or catalog-blocked package replacements.
   - Ordinary outdated-package updates.
3. Show exact packages, target versions, expected breaking risk, commands, source-code migration needs, and tests.
4. Ask for explicit approval for the proposed batch.
5. Require separate approval for `npm audit fix --force`, major upgrades, or library replacements.
6. Apply only the approved batch.
7. Run the repository’s existing tests and `deps:check`.
8. Report failures without automatically reverting unrelated or user-owned changes.

## Test Plan

- Unit-test npm audit normalization using npm 9, 10, and 11 JSON fixtures.
- Verify moderate/high/critical findings fail while low findings remain informational.
- Test Moment direct denial, transitive warning, alternatives, and authoritative evidence.
- Test direct deprecation blocking and outdated warnings.
- Validate waiver ownership, reasons, expiration boundaries, and rule/package scoping.
- Exercise command parsing for scoped packages, quoted versions, workspace flags, chained commands, aliases, and unsupported shell substitutions.
- Confirm preflight simulation never changes the real working tree or executes lifecycle scripts.
- Verify baseline comparison allows vulnerability-reducing fixes but blocks new or worsened findings.
- Test single-package repositories and npm workspaces.
- Test setup idempotency, managed-file upgrades, config preservation, and package-script conflicts.
- Test hook JSON responses: deny, allow, request confirmation, and operational failure.
- Verify CI text/JSON output and exit codes.
- Run existing repository tests plus Claude plugin and marketplace validation.
- Keep network-based registry smoke tests optional or scheduled; regular tests use deterministic npm fixtures/fakes.

Acceptance requires:

- `npm install moment` issued by Claude is denied before project files change and includes useful alternatives.
- A candidate dependency tree introducing a moderate-or-higher vulnerability is denied.
- `/dependency-guardian:audit` works manually and is selected automatically for npm dependency maintenance requests.
- `npm run deps:check` catches equivalent changes made outside Claude.
- No dependency mutation occurs through the skill without explicit approval.
- A valid timed waiver is visible in reports and stops working at expiration.

## Assumptions and Boundaries

- V1 supports npm projects and npm workspaces only; pnpm, Yarn, Bun, Maven, Gradle, license compliance, typosquatting detection, and external vulnerability services are deferred.
- V1 ships Claude packaging only. The scanner, JSON contract, and skill wording remain reusable for later Codex and other agent adapters.
- Registry access is required for complete strict scans. Registry or audit failures fail closed in CI and pre-install checks; an explicit offline scan may run local catalog checks but cannot report a strict pass.
- Manual terminal commands cannot be intercepted by a Claude plugin; the committed CI scanner is the enforcement backstop.
- The repository remains dependency-free and uses its existing version/changelog release discipline.
- Initial team rollout runs the scanner in report review first, records necessary timed waivers, then enables the required CI gate.
