# Dependency Guardian — npm Maintenance and Vulnerability Plugin

## Summary

Create a standalone plugin named `dependency-guardian` in this marketplace. It will:

- Detect vulnerable, deprecated, outdated, or explicitly discouraged npm packages.
- Block unsafe agent-issued installs before they modify the project.
- Support manual and automatic invocation through `/dependency-guardian:dependency-audit`.
- Provide a dependency-free scanner that can be committed into adopting repositories and run in CI.
- Suggest alternatives and apply fixes only after explicit approval.
- Use an ecosystem-adapter design so Maven, Gradle, and other package managers can be added later.

V1 supports Claude Code and GitHub Copilot from one set of files, as the other plugins do. The skill, hooks and scanner are shared, and nothing is written twice for each agent. Skills are invoked directly or picked automatically. `PreToolUse` hooks provide deterministic blocking: Copilot CLI and VS Code read a plugin's `hooks/hooks.json` in Claude Code's format, so one file serves both. The skill instructions and scanner output remain agent-neutral so later Codex and Cursor adapters can reuse them. ([Claude skills](https://code.claude.com/docs/en/skills), [Claude hooks](https://code.claude.com/docs/en/hooks), [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-configuration), [Copilot CLI plugins](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), [VS Code hooks](https://code.visualstudio.com/docs/copilot/customization/hooks))

## Implementation Changes

### Plugin packaging

Add `plugins/dependency-guardian/` with:

- `.claude-plugin/plugin.json`, version `0.1.0`. Copilot reads the same manifest.
- One `dependency-audit` skill, automatically discoverable. It isn't named `audit`, because Copilot doesn't namespace plugin skills and keeps only one of two that share a name. It keeps the preamble the other plugins' skills use, which says what `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` stand for and to drop the `<plugin>:` prefix where the agent doesn't namespace skills.
- `PreToolUse` and `PostToolUse` hooks in `hooks/hooks.json`, which both agents load.
- A dependency-free Node.js 24+ scanner.
- A versioned npm policy catalog, tests, and changelog.
- A marketplace entry, and the plugin added to the README's install commands, which already cover both agents.

The skill supports:

- `/dependency-guardian:dependency-audit` — read-only full scan.
- `/dependency-guardian:dependency-audit setup` — with approval, vendor the scanner and policy catalog into the current repository and add an `npm run deps:check` script.
- `/dependency-guardian:dependency-audit fix` — prepare remediation, request approval, apply the approved changes, run project tests, and rescan.

Keep setup and remediation mutations approval-gated. Automatic invocation may inspect and recommend but must not silently install, uninstall, or upgrade packages.

### Shared scanner and public contract

The vendored scanner exposes:

```text
node .dependency-guardian/guardian.mjs scan [--ci] [--json] [--workspace <name>] [--signatures]
node .dependency-guardian/guardian.mjs preflight -- <npm-subcommand-and-arguments>
node .dependency-guardian/guardian.mjs validate-policy
node .dependency-guardian/guardian.mjs hook pre|post
```

`hook` reads an agent's hook input on stdin and answers it (see [Agent hooks](#agent-hooks)). The plugin's `hooks/hooks.json` runs the plugin's own copy as `node "${CLAUDE_PLUGIN_ROOT}/scripts/guardian.mjs" hook pre|post`. Copilot also sets `${CLAUDE_PLUGIN_ROOT}` for plugin hooks.

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

The `PreToolUse` hook inspects shell commands involving:

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

A `PostToolUse` hook rescans after successful npm mutations and returns findings to the agent. It is a verification layer, not the primary guard, because post-tool hooks cannot undo an installation.

### Agent hooks

One `hooks/hooks.json` in Claude Code's format (`PreToolUse` and `PostToolUse`, each with a nested `hooks` array) runs `guardian.mjs hook`. Every agent-specific detail lives in `hook`, so the policy and preflight code see one normalized `{ event, command }`:

- **Input.** Read the command from `tool_input.command`, which Claude Code and Copilot's `PreToolUse` format send. Also accept `toolArgs.command`, which Copilot's own `preToolUse` format sends, so a repository hook file may use either.
- **Which tools.** Act only on shell tools: `Bash` in Claude Code, `bash` and `powershell` in Copilot CLI, and VS Code's terminal tool. Read VS Code's tool name from its agent debug log while implementing, then record it in the code and the tests. Every other tool passes through. Filter in `hook` itself, because VS Code ignores matchers.
- **Output.** Answer with `hookSpecificOutput.permissionDecision` (`allow`, `deny` or `ask`) and its reason. On a deny, also exit `2` with the reason on stderr, because every supported agent blocks the call on that exit code. The Copilot cloud agent treats `ask` as `deny`, which fails closed.
- **Timeout.** Set an explicit hook timeout. Have preflight stop at its own deadline before that timeout and deny the command: Copilot lets the command through when a hook times out.

### Repository hook

`audit setup` asks separately whether to add `.github/hooks/dependency-guardian.json`, which runs the vendored `guardian.mjs hook`. The Copilot cloud agent reads only repository hooks, and Copilot CLI and VS Code also run this file without the plugin installed. With both the file and the plugin, Copilot runs the guard twice. That's safe, because both runs reach the same decision, but it takes longer.

### CI and cross-agent portability

`audit setup`, after approval:

- Creates `.dependency-guardian/guardian.mjs` and the managed npm catalog.
- Creates a project-owned configuration file.
- Adds `"deps:check": "node .dependency-guardian/guardian.mjs scan --ci"` unless that script name already exists.
- Preserves existing configuration on upgrades and replaces only versioned managed files.
- Reports, but does not automatically edit, the project’s CI-provider configuration.

Teams add `npm run deps:check` to their pipeline. This catches unsafe packages installed manually or by agents without the guardian's hooks and gives other agents a stable command to run.

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

For `/dependency-guardian:dependency-audit fix`:

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

## Reuse from aisdlc

`guardian.mjs` is vendored into adopting repositories, so it cannot import `plugins/aisdlc/scripts/aisdlc.mjs`. Copy the patterns below instead. Look up each one by its function name, because line numbers drift.

### Works without changes

- `plugins/aisdlc/tests/release.test.mjs` iterates `marketplace.json`, so it checks the new plugin's version and changelog as soon as the marketplace entry exists.
- `npm test` globs `plugins/*/tests/*.test.mjs`, so it picks up the new tests.
- `npm run validate` lists each plugin by name. Add `claude plugin validate plugins/dependency-guardian`.

### Copy and adapt

- The preamble of `aisdlc-nodejs`'s skills (for example `skills/sonar/SKILL.md`): copy it into the `dependency-audit` skill.
- `plugins/aisdlc/tests/skills.test.mjs` checks every plugin's skills for strict YAML frontmatter and for the preamble about `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS`. Its check for `/plugin:skill` names only matches `aisdlc` prefixes. Widen it to the plugin names in `marketplace.json`, so it also covers `/dependency-guardian:`.

From `plugins/aisdlc/scripts/aisdlc.mjs`:

- `MIN_NODE_MAJOR` and `nodeVersionError`: the Node.js 24+ check. Copy as is.
- The last line's `main()` guard (`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`): lets tests import the scanner's functions without running it. Copy as is.
- `OPTIONS` and `parseArgs`: strict option parsing, where an unknown option fails. aisdlc's options all take a value, so extend it for the boolean flags (`--ci`, `--json`, `--signatures`) and for the `--` separator that `preflight` takes.
- `UserError`, `fail` and the `try`/`catch` in `main`: print a clean error and exit. aisdlc exits `1`, but configuration, registry and assessment errors here must exit `2`.
- `git()`: runs a command with `execFileSync` and no shell. Call `npm` the same way in preflight, so shell expansions are never evaluated.
- `runCommands`: shows the `mkdtempSync` and `rmSync` pattern for temporary directories. In preflight, wrap the cleanup in `try`/`finally` so temporary data is always removed.

From `plugins/aisdlc/tests/aisdlc.test.mjs`:

- `project()`: creates a temporary project and runs the script in it, with parsed JSON output. Adapt it to build npm fixture projects, and add a fake `npm` on `PATH` for the deterministic tests.

### Not reusable

- `parseDoc` and `formatDoc` parse flat markdown frontmatter. The guardian's configuration is JSON.
- `resolveHook` and `defaults/hooks.json` are aisdlc workflow hooks, which are shell commands run at workflow steps. They are not agent hooks. The order `resolveHook` uses (environment variable, then project config, then built-in default) is still a reasonable precedence for guardian configuration.

### Build from scratch

The repository has no agent `PreToolUse` or `PostToolUse` hooks yet. The plugin's hook registration, the repository hook file, the normalization of each agent's JSON input on stdin, and the allow, deny and ask responses are all new, with nothing in this repository to copy.

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
- Test hook JSON responses: deny, allow, request confirmation, and operational failure. Feed each one Claude Code's input, Copilot's `PreToolUse` and `preToolUse` inputs, and VS Code's terminal-tool input. A non-shell tool must pass through, and a preflight that reaches its deadline must deny.
- Test that `hooks/hooks.json` and the repository hook template run `guardian.mjs hook`.
- Verify CI text/JSON output and exit codes.
- Run existing repository tests plus Claude plugin and marketplace validation.
- Check by hand in Copilot CLI: the skill loads as `/dependency-audit`, and the plugin hook denies `npm install moment`.
- Keep network-based registry smoke tests optional or scheduled; regular tests use deterministic npm fixtures/fakes.

Acceptance requires:

- `npm install moment` issued by Claude Code or Copilot CLI is denied before project files change and includes useful alternatives.
- A candidate dependency tree introducing a moderate-or-higher vulnerability is denied.
- `/dependency-guardian:dependency-audit` works manually and is selected automatically for npm dependency maintenance requests.
- `npm run deps:check` catches equivalent changes made outside a guarded agent.
- No dependency mutation occurs through the skill without explicit approval.
- A valid timed waiver is visible in reports and stops working at expiration.

## Assumptions and Boundaries

- Ownership with `aisdlc-nodejs`: its standards decide whether a project takes on a dependency (the need, the user's choice, an ADR for an architectural one). The guardian decides whether a given package version is safe to install. The standards already tell the agent to run the guardian's checks on an approved install, and never to work around a block.
- V1 supports npm projects and npm workspaces only; pnpm, Yarn, Bun, Maven, Gradle, license compliance, typosquatting detection, and external vulnerability services are deferred.
- V1 ships one package for Claude Code and GitHub Copilot. The scanner, JSON contract, and skill wording remain reusable for later Codex and Cursor adapters.
- VS Code's agent hooks are in preview and may change. The committed CI scanner backs them up.
- Registry access is required for complete strict scans. Registry or audit failures fail closed in CI and pre-install checks; an explicit offline scan may run local catalog checks but cannot report a strict pass.
- Manual terminal commands cannot be intercepted by an agent plugin; the committed CI scanner is the enforcement backstop.
- The repository remains dependency-free and uses its existing version/changelog release discipline.
- Initial team rollout runs the scanner in report review first, records necessary timed waivers, then enables the required CI gate.

## Review amendments

An independent review of this plan against the repo settled these points. They override the sections above where they differ.

- **No third-party code.** `guardian.mjs`, its tests and every helper import only `node:` built-ins and relative files, and the plugin has no `package.json` dependencies and no `node_modules`. Registry and `npm` access goes through `execFileSync('npm', …)` and `fetch`. `tests/no-dependencies.test.mjs` enforces it.
- **Hook contract.** Deny: reason on stderr, exit `2`, no JSON. Allow: no output, exit `0`. `hook` never exits `1`: every internal error becomes a deny with exit `2`.
- **Preflight per command.** `npm install|add|update`: `--package-lock-only` on a temp copy. `npm audit fix`: `--package-lock-only` too, and `--force` is always an `ask`. `npm ci`: audit the existing lockfile. `npx` and `npm exec`: check the package alone (catalog, deprecation, audit). No lockfile means no baseline: fail closed.
- **Command parsing.** Parse only the npm segments of a chained command, so `npm install && npm test` is not blocked. Fail closed only when a package name is dynamic or the source is unsupported. Handle `cd`, env prefixes, `--prefix`, `-g`, `-w` and `--workspace`.
- **Timing.** Hook timeout 120 s. Preflight stops at its own deadline 10 s earlier and denies. Registry calls run with a concurrency cap.
- **Files.** `.dependency-guardian/config.json` (project-owned, with `version`) and `.dependency-guardian/catalog.json` (managed). `validate-policy` checks both. A malformed one denies with exit `2`.
- **Drift.** `guardian.mjs` carries a version, and `scan` warns when the vendored copy differs from the plugin's. `setup` updates managed files by hash history, like `TEMPLATE_HISTORY` in `aisdlc-nodejs`.
- **Offline.** Add `scan --offline`: local catalog checks only, never a strict pass.
- **Tests.** Widen `plugins/aisdlc/tests/skills.test.mjs` to every plugin name in `marketplace.json` and add a `$GUARDIAN` span check. Add a test that `hooks/hooks.json` and the repository hook template run `guardian.mjs hook` and set a timeout.
