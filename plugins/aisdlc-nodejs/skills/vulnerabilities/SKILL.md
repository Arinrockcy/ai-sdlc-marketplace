---
name: vulnerabilities
description: Audit and remediate Node.js dependency vulnerabilities, configure package-manager audit gates, and triage advisory reachability and fixes. Use for vulnerability scans, security audit failures, vulnerable packages, or dependency security CI setup.
---

# Dependency vulnerabilities

`$NODEJS` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/nodejs.mjs"`. Run it from the project root. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are written `/<plugin>:<skill>`; in an agent without plugin namespaces, such as GitHub Copilot, call them `/<skill>` (`/aisdlc-nodejs:vulnerabilities` is `/vulnerabilities`).

Run `$NODEJS inspect`. Read the actual package manager version, lockfile, workspace layout, existing security scripts, registry configuration, CI gates, and advisory exceptions. Preserve an existing scanner and policy that meet the task. Use the project's package manager and lockfile; do not create a second lockfile to run another manager's audit. Audit requests disclose dependency metadata to the configured registry, so retain the approved registry and private-package routing.

## Configure or run an audit

Audit runtime and development dependencies, including transitive dependencies and all workspaces. Build/test packages can affect the supply chain too. If a separate production-only view is useful, label its narrower scope. A clean advisory report establishes only that no matching known advisories were returned; it does not prove the absence of vulnerabilities, malicious packages, leaked secrets, or application flaws.

Use the installed manager's supported command. The examples below use a high-severity failure policy where available; preserve a stricter existing policy and agree on a threshold for a new gate before configuring it.

| Manager | Example `security:audit` script | Policy detail |
| --- | --- | --- |
| npm | `npm audit --audit-level=high` | Requires a package-lock or shrinkwrap; the threshold changes failure status, not the reported findings. Include dev dependencies even if CI sets `NODE_ENV=production` or omits them; use `--include=dev` where needed. |
| pnpm | `pnpm audit --audit-level=high` | Check the installed version's severity and workspace behavior. Never use `--ignore-registry-errors` in a required gate. |
| Yarn modern | `yarn npm audit --all --recursive` | Audits all workspaces and transitive dependencies. `--severity` controls display; do not assume it implements an npm-style exit threshold. Use the all-findings gate or an explicitly selected, tested policy wrapper. |
| Yarn Classic | `yarn audit` | Nonzero status is a severity bitmask. `--level` filters display, not exit status. Keep an all-findings gate unless a tested wrapper applies the selected policy. |
| Bun | `bun audit --audit-level=high` | Verify support in the installed version and use its existing Bun lockfile. If unsupported, report the gap and select a compatible scanner rather than switching lockfile formats. |

For machine-readable evidence, add the manager's `--json` option and save output to an ignored report location while retaining the original exit status. Do not use `|| true`, ignore registry errors, pipe into a command that hides failures, or treat empty/malformed output as a clean result. Distinguish findings from network/authentication/tool failures in the report; both must fail a required check.

To enforce an audit after every aisdlc task, configure `package.json`'s `security:audit` script, register the stack if needed, then run `$NODEJS manifest scans --package-manager npm|pnpm|yarn|bun --vulnerabilities on`. The helper appends the audit after coverage and before Sonar, preserving other hook commands. Re-registration retains it. Check inspect's config/environment hook overrides so the manifest is actually used, then run `$NODEJS baseline` to verify the audit's exit code reaches the task gate. If checks belong only in CI, keep the local manifest unchanged and enforce the script there. Only remove an established local gate when requested, using `$NODEJS manifest scans --package-manager npm|pnpm|yarn|bun --vulnerabilities off`.

## Triage and remediate

For each actionable finding, record the advisory URL/ID, package and resolved version, direct/transitive dependency chain, severity, affected/fixed ranges, runtime or build exposure, and evidence of reachability. Verify advisory details from the maintainer or authoritative advisory database. Separate confirmed applicability from uncertain reachability; lack of a demonstrated exploit is not a reason to silently waive a finding.

Prefer the smallest supported dependency upgrade that fixes the advisory. For a transitive issue, update its parent first; use a scoped override only with compatibility evidence and a removal plan. Use the package manager to update lockfiles. Follow [standards](../nodejs-standards/SKILL.md) for dependency choices within the user's authorization. Never run a forced audit fix, accept a major upgrade, delete the lockfile, or add broad exclusions merely to clear the gate. If no fix exists, describe mitigation/replacement options and leave the unresolved result visible.

An exception needs the specific advisory and scope, evidence, owner, expiry/review date, and explicit project authorization; it must not silently become a global ignore or lower the severity threshold. Do not offer an exception as an aisdlc governance waiver.

After authorized fixes, inspect the manifest/lockfile diff, rerun the audit and lint/coverage gates, and add regression tests for application changes. Report fixed, remaining, excepted, and unverified findings separately, with command, manager version, scope, timestamp, and exit status. For application security use the relevant Node.js/Express standards and [Sonar](../sonar/SKILL.md); dependency audit does not replace source review.

## Official command references

- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
- [pnpm audit](https://pnpm.io/cli/audit)
- [Yarn modern audit](https://yarnpkg.com/cli/npm/audit) and [Yarn Classic audit](https://classic.yarnpkg.com/lang/en/docs/cli/audit/)
- [Bun audit](https://bun.sh/docs/pm/cli/audit)
