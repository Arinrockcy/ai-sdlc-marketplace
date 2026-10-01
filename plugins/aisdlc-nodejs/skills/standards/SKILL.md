---
name: standards
description: Enforce the aisdlc Node.js coding standard for JavaScript or optional TypeScript work: Node.js 24+, ES modules by default, class-oriented modules, named functions, purpose-grouped constants, external configuration, editor-only declaration files, security, process lifecycle, logging, package hygiene, dependency approval, ESLint, and coverage-gated tests. Loaded by /aisdlc:implement when the project stack is nodejs; also usable directly when writing Node.js code in an aisdlc project.
---

# Node.js standards (aisdlc)

`$NODEJS` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/nodejs.mjs"`. Run it from the project root.

These are required Node.js plugin policies. Preserve stricter repository rules and established naming, but do not inherit a weaker convention that defeats a requirement below. Before writing code, run `$NODEJS manifest check` once per session. It compares the installed `.aisdlc/stacks/nodejs.json` with the oldest manifest version this plugin accepts. If it exits non-zero, show its `problems`, tell the user to re-run `/aisdlc-nodejs:register`, and stop. Mention any `notes` (a manifest from an older, still compatible release) without stopping. Then check these once per session:
- `.aisdlc/stacks/nodejs.json`: `runtime.node`, `runtime.module_type` and `quality_gate.coverage_report`
- `package.json`: `type`, `engines`, `scripts`, `packageManager`
- `tsconfig.json` or `jsconfig.json`: whether TypeScript is used, strictness, declaration output, module resolution, and path aliases
- the ESLint, formatter, Jest, and coverage configuration
- the source, test, declaration, configuration, and constant folder conventions

If these conflict (for example, a `type` that disagrees with `runtime.module_type`, mixed module systems, multiple active test frameworks, or handwritten declarations beside generated declarations), ask the user instead of guessing.

## Runtime

- Target Node.js 24 or later. `package.json` `engines.node` is `>=24` (or a stricter range whose minimum is at least 24). Do not lower it, and do not add polyfills, transpilation, or fallbacks for older Node versions.
- Prefer Node 24 built-ins to a dependency when they cover the need: global `fetch`, `AbortSignal.timeout`, `structuredClone`, `util.parseArgs`, `util.styleText`, `Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`.

## Language and public types

- JavaScript is the default; TypeScript is never required. Use TypeScript only when the repository already uses it or the user chooses it. Do not migrate the project as a side effect of a task.
- In JavaScript projects, `.d.ts` files exist only to give VS Code and other editors completion and hover documentation. Every maintained public JavaScript module has a handwritten `.d.ts` beside it (or in the repository's existing declaration directory), exposed through `package.json` `types` or `exports` so editors find it. Update it in the same task as any public signature, option, event, return type, or exported class change, and keep it accurate to the implementation.
- Do not impose TypeScript tooling on a JavaScript project: no `typescript` or `typescript-eslint` dependency, `tsc` script, `checkJs`, `// @ts-check`, or type-check gate, unless the user asks for one. A declaration is checked by reading it against the implementation, not by a compiler.
- In TypeScript projects, enable declaration output for published or cross-package APIs and verify the generated `.d.ts` files. Do not hand-edit generated declarations.

## Modules and functions

- ES modules are the default: `package.json` has `"type": "module"` and code uses `import`/`export`. Use CommonJS only when the manifest's `runtime.module_type` is `commonjs`, which records the user's override. Never mix `require` and `import` in one package, and do not convert between module systems as a side effect of a task.
- In ES modules, write relative import specifiers with their file extension (`./order-service.js`), and use `import.meta.dirname` and `import.meta.filename` instead of `__dirname` and `__filename`.
- Design behavior around focused class modules. Controllers, services, repositories, adapters, clients, and other components that own dependencies, state, or lifecycle must be classes with explicit constructor dependencies. Keep one primary class per module. Small stateless transformations may remain named functions; do not wrap them in empty utility classes.
- No inline functions. Do not pass arrow functions or anonymous function expressions directly to callbacks, array methods, timers, promises, event handlers, object properties, or returned expressions. Declare an intention-revealing named function or class method and pass its reference. Put it at module scope when it needs no closure, otherwise use the narrowest valid named scope.
- In TypeScript projects, respect `strict`. Do not use `any` to silence errors; narrow the value or use `unknown`.
- Use async/await. Always `await` or return promises, and never leave floating promises.
- Throw `Error` instances (or the project's error classes) with context. Don't swallow errors in empty `catch` blocks.
- Validate external input (HTTP, env, files) at the boundary, using the validator the project already uses.
- Use `node:`-prefixed imports for built-ins (`node:fs`, `node:path`) in new code, unless the repo does otherwise.

## Structure, constants, and configuration

- Organize code by feature or bounded responsibility. Within a feature, use only the layers it needs, such as `controller/`, `service/`, `repository/`, `model/`, `config/`, `constant/`, and `test/`. Do not create empty ceremonial folders.
- Put every static semantic value in the nearest owning `constant/` directory. Group constants by purpose and usage in files such as `constant/order-status.js`, `constant/retry-policy.js`, or their TypeScript equivalents. Never create a generic dumping ground such as `constants.js`.
- Constants include fixed labels, lookup maps, event names, default values, regular expressions, header names, and option arrays. Runtime results and local immutable bindings may still use `const`; they are not static constants.
- Do not hardcode deployable or environment-dependent configuration in implementation files. Ports, hosts, URLs, credentials, feature flags, timeouts, retry limits, filesystem locations, resource identifiers, and environment-specific limits belong in a focused `config/` module sourced from environment variables or the project's configuration provider.
- Validate configuration once at startup and inject the resulting configuration into class modules. Never read `process.env` throughout business logic, commit secrets, or mix configuration access with domain behavior.
- A business invariant may be a named constant rather than configuration when operators must not change it. Make that distinction explicit in its name, location, and tests.

## Security

- Run child processes with `execFile` or `spawn` and an argument array. Never pass input to `exec`, `execSync` or `shell: true`, where the shell interprets it.
- Never evaluate code built at runtime: no `eval`, `new Function`, string arguments to `setTimeout` or `setInterval`, or `node:vm` on untrusted input (`vm` is not a security boundary).
- Build queries with parameters or the query builder's bindings. Never concatenate input into SQL, shell commands, NoSQL filters or regular expressions.
- Resolve a path that comes from input against a fixed base directory, and reject it when the result leaves that directory. Compare against the base plus `path.sep`, not a bare prefix.
- When copying or merging objects from input, skip `__proto__`, `constructor` and `prototype` keys. Key lookups on input with a `Map` or `Object.create(null)`, not a plain object.
- Generate tokens, IDs and secrets with `node:crypto` (`randomUUID`, `randomBytes`), never `Math.random`. Compare secrets and signatures with `crypto.timingSafeEqual`.
- Bound what input can cost: request and payload sizes, collection lengths, and regular expressions that can't backtrack catastrophically on untrusted text. Limits come from configuration.
- Never turn off TLS verification (`rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`), not even for tests. Use test certificates instead.
- Never put secrets, tokens, credentials or full personal data in logs, errors or exceptions sent to clients.

## Process lifecycle

- A long-running process (server, worker, queue consumer) handles `SIGTERM` and `SIGINT`: it stops taking new work, finishes or cancels in-flight work within a configured timeout, closes servers, connections and timers, then exits. Keep this in one lifecycle class that owns the shutdown order, not in `process.on` calls spread across modules.
- Async operations that do I/O or wait accept an `AbortSignal` and pass it on to `fetch`, `node:timers/promises`, streams and clients. Set deadlines with `AbortSignal.timeout`, using a timeout from configuration.
- Handle `unhandledRejection` and `uncaughtException` once, at the entry point: log the error with its context and exit non-zero so the supervisor restarts the process. Never use them to keep running.
- Don't call `process.exit()` in library or business code. Return or throw to the entry point, and set `process.exitCode` there.
- Release resources in `finally` (or the project's cleanup helper). Connect streams with `pipeline` from `node:stream/promises`, so errors and cleanup propagate.

## Logging

- Log through the project's logger. If the project has none and the task needs logging, ask the user which to use: the dependency rules below apply.
- Log structured events: a stable message plus fields (IDs, counts, durations, outcome), not values interpolated into the text.
- Use levels by meaning: `error` for failures someone must act on, `warn` for degraded but handled conditions, `info` for lifecycle and business events, `debug` for diagnostics. The level comes from configuration, and `debug` is off by default.
- Log an error once, where it is handled, with its cause chain (`new Error(message, { cause })`). Don't log and rethrow at every layer.
- `console` is for a CLI's intended output only, never for logging in application code.

## ESLint

- ESLint is mandatory for JavaScript and TypeScript maintained by the task. Follow the repository's ESLint configuration, extending it when needed to enforce these standards.
- When the project has `eslint.aisdlc.mjs` in its ESLint configuration (added by `/aisdlc-nodejs:register`), it reports the lintable part of these standards as errors: inline functions, `process.env` outside `config/`, built-ins without `node:`, CommonJS globals in ES modules, thrown literals, empty `catch` blocks, `console` calls, `eval` and its equivalents, `exec` from `node:child_process`, and `rejectUnauthorized: false`. Fix the code, not the template. Changing that file or its options is a project-wide exception and needs the user's approval.
- Set ESLint's `languageOptions.sourceType` to match the module system. Run ESLint over source, tests, and configuration (and over declarations only in TypeScript projects). The gate passes with zero errors. Do not use warning-only rules for required policies, broad ignore patterns, blanket disable comments, or `--no-eslintrc` to make it pass.
- A narrow disable requires a code comment explaining the concrete incompatibility. Ask the user before adding or weakening a project-wide exception.

## Third-party dependencies

- These rules decide whether the project takes on a dependency: the need, the choice and its ADR. The `dependency-guardian` plugin, when installed, decides whether a package version is safe to install, and blocks vulnerable, deprecated or denied packages. Run its checks on an approved install, and never work around a block: a waiver is the user's decision. Without it, check before offering a package that it isn't deprecated (`npm view <package> deprecated`) and has no open security advisory.
- Before adding a dependency, check whether the standard library or an existing dependency already covers it.
- Before installing or replacing a third-party library, ask the user to choose. Offer concise options: the best-fitting established library and what it handles, any already-installed viable library, a user-named alternative, or a custom implementation. State maintenance, security, bundle/runtime, typing, and performance trade-offs that matter to the task. Respect the user's selection.
- Never install a package merely by running an `npx`, `npm exec`, or equivalent command that can download it implicitly. After approval, add it with the project's package manager so the lockfile updates. Never edit lockfiles by hand.
- A new runtime dependency that changes the architecture needs an ADR. If the task has none, stop and tell the user to run `/aisdlc:adr`.
- If the user chooses a custom replacement for a library, isolate it behind a class/module boundary and give that replacement 100% unit coverage for branches, functions, lines, and statements. Cover invalid input, dependency failures, timeouts, limits, and recovery behavior. When performance motivates the custom version, add a deterministic benchmark or performance regression test with a documented baseline; optimize only from measured evidence.

## Package hygiene

- `package.json` `exports` lists the public entry points, with a `types` condition pointing at each declaration file. Don't expose internal files. A published package lists what it ships in `files`.
- Runtime needs go in `dependencies`, tools in `devDependencies`. Remove a dependency in the task that removes its last use.
- Commit the lockfile. CI installs from it without changing it: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable` or `bun install --frozen-lockfile`.
- Don't add install lifecycle scripts (`preinstall`, `install`, `postinstall`) without the user's approval.
- Keep the `lint` and `test:coverage` script names: the `after_task` hook runs them.

## Tests

- Every task that changes behavior adds or updates both relevant test layers:
  - Mock-based unit tests isolate external systems and exercise class interactions, dependency failures, negative paths, boundaries, and recovery behavior.
  - Non-mocked, data-driven tests exercise the real local modules together through their public interface. Use dynamic/parameterized cases generated from representative inputs. Do not mock the code under test. Local fakes such as an in-memory repository are allowed when the real dependency is external.
- Never call live third-party services in the regular suite. Use contract fixtures or a user-authorized integration environment for network integration tests.
- Keep tests deterministic: control clocks and randomness, avoid order dependence, and make performance tests use stable workloads and tolerant documented limits.
- With ES modules, Jest's `jest.mock` hoisting does not apply. Import `jest` from `@jest/globals`, prefer passing mocks through class constructors, and mock a module only with `jest.unstable_mockModule` followed by a dynamic `import()`.
- Jest is the default runner. A user-selected alternative is acceptable only when it provides the same test layers and enforceable coverage. Global branches, functions, lines, and statements must each be at least 80%; existing higher thresholds win.
- Every new source module gets a test that loads it. The coverage configuration counts all source files (Jest's `collectCoverageFrom` or the runner's equivalent), so an untested module lowers the percentage. Don't narrow that configuration to leave a file out. node:test can't count a file no test loads, so there this rule is checked in review.
- Coverage is a floor, not the test design target. Give extra attention to negative cases, boundary conditions, concurrency, resource cleanup, and measured performance risks.
- The `after_task` hook must run `lint` and `test:coverage` after every task. Both commands and the task's own `verify` command must pass before the task is done.
- Every `test:coverage` run writes the report named in the manifest's `quality_gate.coverage_report`. The core `after_goal` hook checks that report before the goal completes: it must exist, be newer than every file the goal changed, and meet the thresholds. Don't remove its reporter, move its output, or commit the coverage directory.

## Done checklist
- [ ] ESLint passes with zero errors
- [ ] Code targets Node.js 24+ and uses the recorded module system (ES modules unless the user overrode it)
- [ ] Public `.d.ts` files match the implementation (editor hints only; no TypeScript tooling added to a JavaScript project)
- [ ] Mock-based unit tests and non-mocked data-driven tests pass
- [ ] Coverage is at least 80% for branches, functions, lines, and statements; custom library replacements are 100%
- [ ] Every new source module has a test that loads it, and the coverage configuration still counts every source file
- [ ] The last `test:coverage` run wrote the coverage report named in `quality_gate.coverage_report`
- [ ] Negative, boundary, cleanup, and relevant performance cases are covered
- [ ] Static constants are grouped by purpose under the nearest `constant/`; deployable configuration is validated in `config/`
- [ ] Stateful/dependency-owning behavior uses focused class modules and no new inline functions remain
- [ ] Input never reaches a shell, an evaluator, a query string or a file path unchecked; no secrets in logs; TLS verification stays on
- [ ] Long-running processes shut down on `SIGTERM`/`SIGINT`, and I/O accepts an `AbortSignal` with a configured deadline
- [ ] Logging goes through the project's logger, with structured fields and levels; no debug logging or commented-out code is left behind
- [ ] `exports`, dependencies and the lockfile match the code; no new install scripts without approval
- [ ] The public API or config changes are documented where the project documents them (README, JSDoc)
