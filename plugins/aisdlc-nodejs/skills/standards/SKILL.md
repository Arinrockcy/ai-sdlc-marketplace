---
name: standards
description: Node.js / TypeScript implementation standards for aisdlc tasks — project conventions discovery, module system, typing, error handling, testing and dependency rules. Loaded by /aisdlc:implement when the project stack is nodejs; also usable directly when writing Node.js code in an aisdlc project.
---

# Node.js standards (aisdlc)

**Repo conventions come first.** These standards fill gaps and never override what the project already does. Before writing code, check these once per session:
- `package.json`: `type` (ESM or CJS), `engines`, `scripts`, `packageManager`
- `tsconfig.json`: whether TS is used, `strict`, module resolution and path aliases
- the ESLint and Prettier config
- the test framework in use (jest, vitest, mocha or `node:test`) and where tests live

If these conflict (for example, two test frameworks or mixed module systems) or say nothing about a choice that matters, ask the user instead of picking one.

## Code
- Use the module system the project already uses. Never mix `require` and `import` in one package.
- In TypeScript projects, write TypeScript and respect `strict`. Don't use `any` to silence errors; narrow the type or use `unknown`.
- Use async/await. Always `await` or return promises, and never leave floating promises.
- Throw `Error` instances (or the project's error classes) with context. Don't swallow errors in empty `catch` blocks.
- Validate external input (HTTP, env, files) at the boundary, using the validator the project already uses.
- Read configuration from env through the project's config module. Never hardcode secrets or URLs.
- Use `node:`-prefixed imports for built-ins (`node:fs`, `node:path`) in new code, unless the repo does otherwise.

## Dependencies
- Before adding a dependency, check whether the standard library or an existing dependency already covers it.
- Add dependencies with the project's package manager so the lockfile updates. Never edit lockfiles by hand.
- A new runtime dependency that changes the architecture needs an ADR. If the task has none, stop and tell the user to run `/aisdlc:adr`.

## Tests
- Every task that changes behavior adds or updates tests in the project's existing framework and location.
- Test through the public interface: behavior, edge cases and error paths.
- Keep tests deterministic. No real network calls, and no reliance on wall-clock time or ordering between tests.
- The task's `verify` command and the `after_task` hook must pass before the task is done.

## Done checklist
- [ ] Lint and typecheck pass, if the project has them
- [ ] Tests are added or updated and pass
- [ ] No debug logging or commented-out code is left behind
- [ ] The public API or config changes are documented where the project documents them (README, JSDoc)
