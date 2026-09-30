---
name: standards
description: Enforce the aisdlc Node.js coding standard for JavaScript or optional TypeScript work: class-oriented modules, named functions, purpose-grouped constants, external configuration, declaration files, dependency approval, ESLint, and coverage-gated tests. Loaded by /aisdlc:implement when the project stack is nodejs; also usable directly when writing Node.js code in an aisdlc project.
---

# Node.js standards (aisdlc)

These are required Node.js plugin policies. Preserve stricter repository rules and established naming, but do not inherit a weaker convention that defeats a requirement below. Before writing code, check these once per session:
- `package.json`: `type` (ESM or CJS), `engines`, `scripts`, `packageManager`
- `tsconfig.json` or `jsconfig.json`: whether TypeScript is used, strictness, declaration output, module resolution, and path aliases
- the ESLint, formatter, Jest, and coverage configuration
- the source, test, declaration, configuration, and constant folder conventions

If these conflict (for example, mixed module systems, multiple active test frameworks, or handwritten declarations beside generated declarations), ask the user instead of guessing.

## Language and public types

- JavaScript is the default; TypeScript is optional. Use TypeScript only when the repository already uses it or the user chooses it. Do not migrate the project as a side effect of a task.
- Every maintained public JavaScript module must have an accurate `.d.ts` declaration so VS Code and other editors can provide completion and type checking. Keep declarations beside the public module or in the repository's existing declaration directory, and expose them through `package.json` `types`, `exports`, or `typesVersions` as appropriate.
- For TypeScript, enable declaration output for published or cross-package APIs and verify the generated `.d.ts` files. Do not hand-edit generated declarations.
- Update declarations in the same task as any public signature, option, event, return type, or exported class change. Run the project's declaration/type check in verification.

## Modules and functions

- Use the module system the project already uses. Never mix `require` and `import` in one package.
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

## ESLint

- ESLint is mandatory for JavaScript and TypeScript maintained by the task. Follow the repository's ESLint configuration, extending it when needed to enforce these standards.
- Run ESLint over source, tests, configuration, and declarations where supported. The gate passes with zero errors. Do not use warning-only rules for required policies, broad ignore patterns, blanket disable comments, or `--no-eslintrc` to make it pass.
- A narrow disable requires a code comment explaining the concrete incompatibility. Ask the user before adding or weakening a project-wide exception.

## Third-party dependencies

- Before adding a dependency, check whether the standard library or an existing dependency already covers it.
- Before installing or replacing a third-party library, ask the user to choose. Offer concise options: the best-fitting established library and what it handles, any already-installed viable library, a user-named alternative, or a custom implementation. State maintenance, security, bundle/runtime, typing, and performance trade-offs that matter to the task. Respect the user's selection.
- Never install a package merely by running an `npx`, `npm exec`, or equivalent command that can download it implicitly. After approval, add it with the project's package manager so the lockfile updates. Never edit lockfiles by hand.
- A new runtime dependency that changes the architecture needs an ADR. If the task has none, stop and tell the user to run `/aisdlc:adr`.
- If the user chooses a custom replacement for a library, isolate it behind a class/module boundary and give that replacement 100% unit coverage for branches, functions, lines, and statements. Cover invalid input, dependency failures, timeouts, limits, and recovery behavior. When performance motivates the custom version, add a deterministic benchmark or performance regression test with a documented baseline; optimize only from measured evidence.

## Tests

- Every task that changes behavior adds or updates both relevant test layers:
  - Mock-based unit tests isolate external systems and exercise class interactions, dependency failures, negative paths, boundaries, and recovery behavior.
  - Non-mocked, data-driven tests exercise the real local modules together through their public interface. Use dynamic/parameterized cases generated from representative inputs. Do not mock the code under test. Local fakes such as an in-memory repository are allowed when the real dependency is external.
- Never call live third-party services in the regular suite. Use contract fixtures or a user-authorized integration environment for network integration tests.
- Keep tests deterministic: control clocks and randomness, avoid order dependence, and make performance tests use stable workloads and tolerant documented limits.
- Jest is the default runner. A user-selected alternative is acceptable only when it provides the same test layers and enforceable coverage. Global branches, functions, lines, and statements must each be at least 80%; existing higher thresholds win.
- Coverage is a floor, not the test design target. Give extra attention to negative cases, boundary conditions, concurrency, resource cleanup, and measured performance risks.
- The `after_task` hook must run `lint` and `test:coverage` after every task. Both commands and the task's own `verify` command must pass before the task is done.

## Done checklist
- [ ] ESLint passes with zero errors
- [ ] Type/declaration checks pass and public `.d.ts` output matches the implementation
- [ ] Mock-based unit tests and non-mocked data-driven tests pass
- [ ] Coverage is at least 80% for branches, functions, lines, and statements; custom library replacements are 100%
- [ ] Negative, boundary, cleanup, and relevant performance cases are covered
- [ ] Static constants are grouped by purpose under the nearest `constant/`; deployable configuration is validated in `config/`
- [ ] Stateful/dependency-owning behavior uses focused class modules and no new inline functions remain
- [ ] No debug logging or commented-out code is left behind
- [ ] The public API or config changes are documented where the project documents them (README, JSDoc)
