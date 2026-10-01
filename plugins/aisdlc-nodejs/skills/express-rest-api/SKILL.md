---
name: express-rest-api
description: Design, implement, review, or secure production Express REST APIs in Node.js, including resource-oriented HTTP contracts, middleware and error handling, authentication, authorization, sessions or tokens, abuse controls, and API security testing. Use for Express API and auth work; do not use for non-HTTP Node.js services or other web frameworks.
---

# Express REST API

Apply [`aisdlc-nodejs:standards`](../standards/SKILL.md) first. This skill adds Express and HTTP-specific guidance; it does not replace the plugin's runtime, structure, dependency-approval, lint, test, or coverage rules. Preserve a project's established contract and authentication system unless the task explicitly changes them.

## Start from evidence

Before proposing or changing an API, inspect:

- the installed Express major version and module system;
- application/bootstrap, router, controller, error, validation, authentication, authorization, proxy, CORS, and rate-limit code;
- the API contract or generated documentation and its compatibility policy;
- how identities are issued, verified, revoked, and mapped to tenants and permissions;
- deployment boundaries: TLS termination, reverse proxies, gateways, identity providers, databases, queues, caches, and secret stores;
- existing integration tests and security-sensitive negative cases.

Do not guess who calls the API or which proxy headers are trustworthy. If the answer changes the security model and the repository does not establish it, ask the user.

## Choose the relevant guidance

- For routes, methods, status codes, representations, pagination, concurrency, idempotency, errors, and compatibility, read [REST API design](references/rest-api.md).
- For login, OAuth/OIDC, bearer tokens, JWTs, cookies, sessions, API keys, authorization, or webhooks, read [authentication and authorization](references/authentication-authorization.md).
- For middleware ordering, Express configuration, validation, abuse resistance, observability, shutdown, and verification, read [Express security and operations](references/express-security-operations.md).

Read every reference that applies to the task; ordinary endpoint work often needs the REST and Express references, while authenticated endpoint work needs all three.

## Required design outcomes

1. **Write the contract before the handler.** Define the resource, method semantics, request schema, successful response, error cases, authorization rule, retry/concurrency behavior, and compatibility impact. Update the project's OpenAPI or equivalent contract in the same change when one exists.
2. **Keep HTTP at the boundary.** Routers map paths and middleware; controllers translate HTTP; services own use cases and authorization-relevant orchestration; repositories/adapters own external I/O. Inject dependencies. Do not put business rules or direct database access in route registration.
3. **Validate each trust transition.** Treat path, query, headers, cookies, body, uploaded files, token claims, webhook payloads, and upstream responses as untrusted. Parse to an explicit schema, reject unknown or dangerous fields when appropriate, and pass a normalized value inward.
4. **Separate authentication from authorization.** Authentication establishes a normalized principal. Authorization makes a deny-by-default decision for the requested action and specific resource, including ownership and tenant boundaries. Never infer permission merely because a token is valid.
5. **Centralize failures.** Convert known domain failures to the API's documented error format in one error boundary. Do not leak stack traces, SQL details, token failures, secrets, or internal object shapes. Preserve Express's `headersSent` behavior for streaming failures.
6. **Make resource use bounded.** Set request/body/upload limits, pagination maxima, timeouts, cancellation where supported, and bounded concurrency. Add rate limits to abuse-prone or expensive operations at the correct gateway/application layer.
7. **Keep security controls testable.** Prefer explicit middleware and injected policy components over hidden globals. Test through the public HTTP interface as well as at unit boundaries.

## Implementation guardrails

- Confirm Express behavior from the installed major version. Express 5 forwards rejected async handlers to error middleware; Express 4 requires an explicit compatible wrapper or `next(error)` path.
- Order middleware deliberately: request context and safe logging; proxy/security/CORS policy; bounded parsers; authentication; route-specific validation and authorization; routes; not-found handling; final error handling. Raw-body signature verification is a special case and must run before a parser consumes the bytes.
- Configure `trust proxy` from the actual proxy topology. Do not set it broadly just to make secure cookies or client IPs appear to work.
- Do not add auth, validation, CORS, session, rate-limit, or security-header packages without the dependency choice required by `aisdlc-nodejs:standards`. Do not implement cryptography or token parsing from scratch.
- Do not mutate state from `GET` or `HEAD`, put credentials in URLs, use CORS as authorization, trust decoded-but-unverified JWT claims, or accept a tenant/user identifier from input as proof of identity.
- Keep credentials and raw tokens out of source, URLs, error responses, telemetry, and logs. Redact authorization, cookie, API-key, reset-token, and secret fields recursively.

## Verification

Add or update tests proportional to the risk. At minimum cover:

- the success contract and method/status/header semantics;
- malformed, missing, oversized, and unknown input;
- unauthenticated, insufficient-scope/role, wrong-owner, and cross-tenant access;
- expired, not-yet-valid, wrong-issuer/audience, malformed, revoked, and rotated credentials when applicable;
- duplicate/retried writes, concurrent updates, pagination boundaries, and downstream failures when applicable;
- redacted errors/logging, rate-limit behavior, proxy assumptions, CORS/CSRF behavior, and cleanup of open resources where relevant.

Use non-mocked HTTP tests against the assembled Express app for middleware order and end-to-end policy behavior. Keep sockets, clocks, randomness, identity-provider calls, and external services deterministic or locally faked. Then run the repository's lint and coverage gates from `aisdlc-nodejs:standards`.
