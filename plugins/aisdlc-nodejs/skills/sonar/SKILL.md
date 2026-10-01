---
name: sonar
description: Configure, run, or troubleshoot SonarQube Server or SonarQube Cloud analysis for Node.js projects, including LCOV coverage import, CI quality gates, and finding remediation. Use when Sonar support is requested or an existing Sonar check needs attention.
---

# Sonar analysis

`$NODEJS` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/nodejs.mjs"`. Run it from the project root. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are written `/<plugin>:<skill>`; in an agent without plugin namespaces, such as GitHub Copilot, call them `/<skill>` (`/aisdlc-nodejs:sonar` is `/sonar`).

Run `$NODEJS inspect`, then inspect the existing Sonar configuration and CI workflow. Preserve the selected scanner, source scope, exclusions, and stricter quality gate. Resolve the destination (Server URL or Cloud organization and region), project key, scanner version, and whether analysis runs in CI only or after every task from project evidence or the user. Do not invent a remote project or send source code to a different service. Existing authorization to configure or run analysis need not be requested again.

## Configure analysis

- Use the project's scanner when present. For a new npm-based integration, offer the official `@sonar/scan` development dependency through the project's package manager and the dependency-choice policy in [standards](../standards/SKILL.md). Pin through the lockfile. Avoid an unpinned `npx` download on every verification. A preinstalled SonarScanner CLI is also supported through the same project script.
- Keep credentials in the CI secret store or environment (`SONAR_TOKEN`), never in properties, package scripts, command arguments, checked-in files, or printed diagnostics. For Server, configure the established `SONAR_HOST_URL`; for Cloud, use the organization's actual region and connection settings supported by the installed scanner. Never disable TLS verification to resolve a connection failure.
- Configure the real project key and source/test directories in `sonar-project.properties` or the existing scanner configuration. Source and test classifications must not overlap. Adapt to colocated tests and workspace roots. Do not exclude application code or lower thresholds to obtain a passing result.
- Make `test:coverage` generate LCOV before analysis and set `sonar.javascript.lcov.reportPaths=coverage/lcov.info` (adapt the path). Keep `json-summary` if the aisdlc coverage gate uses it: Sonar's LCOV import and aisdlc's report are separate consumers. With Jest, preserve existing reporters when adding `lcov`; with other runners, use their LCOV reporter. Check that the report is fresh, nonempty, and its source paths match the scanner's checkout.
- Define a `sonar` package script that runs the installed scanner and waits for its quality gate, for example `sonar -Dsonar.qualitygate.wait=true -Dsonar.qualitygate.timeout=300` for `@sonar/scan`, or the equivalent `sonar-scanner` CLI invocation. Adapt the timeout to CI. A successful upload alone does not prove the quality gate passed. If CI already uses a separate quality-gate check, retain that check instead of duplicating waits.
- Ignore scanner working output such as `.scannerwork/` and coverage output. Give CI enough checkout history for SCM attribution. Use branch/PR parameters only where supported by the deployed product and edition. Do not expose analysis secrets to untrusted fork code.

## Wire and verify the gate

For CI-only analysis, keep the local manifest unchanged and run lint, coverage, and the Sonar quality-gate check as required CI steps. For analysis after every aisdlc task, first register the stack if needed, configure the `sonar` script, then run `$NODEJS manifest scans --package-manager npm|pnpm|yarn|bun --sonar on`. This adds the scan after lint/coverage and any configured dependency audit; re-registration retains it. The helper only wires the script: inspect it to ensure it really waits for the remote quality gate.

Check `workflow.config_after_task` and `workflow.env_after_task` from inspect: either can shadow the manifest's hook. Resolve any override within the user's authorized scope. Run `$NODEJS baseline` when an actual remote analysis is authorized and credentials are available; otherwise report setup as configured but unverified. Record the analyzed commit, dashboard link, coverage import, and remote quality-gate status. Authentication errors, unavailable servers, timeouts, and failed gates remain failures; never mask them with `|| true` or mark an unrun check as passing.

Triage findings by rule, location, impact, and evidence. Review security hotspots manually; a hotspot is not automatically a confirmed vulnerability. Fix causes, add risk-appropriate regression tests, then rerun analysis. Use [vulnerabilities](../vulnerabilities/SKILL.md) for dependency advisories; source analysis alone does not establish dependency safety. Only disable an established task gate when requested, using `$NODEJS manifest scans --package-manager npm|pnpm|yarn|bun --sonar off`.

## Official references

Check these against the installed scanner/server version when configuring:

- [SonarScanner for NPM](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-for-npm/using)
- [JavaScript/TypeScript LCOV coverage](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/test-coverage/javascript-typescript-test-coverage)
- [Quality-gate waiting and timeout](https://docs.sonarsource.com/sonarqube-server/10.7/analyzing-source-code/ci-integration/overview)
