# Express security and operations

Use this reference for Express application assembly, middleware, production hardening, observability, or verification.

## Application boundaries and middleware

- Keep `createApp` separate from `listen` so tests can assemble the real middleware and routes without opening a port. Inject configuration and dependencies; do not let imported modules start servers or connect to external systems as side effects.
- Register middleware in a deliberate order. A typical sequence is request ID/context, safe access logging, proxy-aware security and CORS policy, bounded body/cookie parsing, authentication, feature routers with request validation and authorization, a not-found handler, and the final error handler. Some controls belong only on specific routers.
- A webhook or other signed-body endpoint must capture and verify the exact bytes before a JSON or form parser consumes them. Isolate that parser order so ordinary routes still receive normalized bodies.
- Treat `req.body`, `req.params`, `req.query`, `req.headers`, and cookies as untrusted values. Do not call methods on their properties or pass them to database/filesystem/network APIs before schema validation and normalization.
- Express 5 automatically forwards rejected promises from async handlers. Express 4 does not; use the project's established wrapper or an explicit error path. Never create floating promises in middleware.
- Put the four-argument error middleware last. Map known failures and log once. If `res.headersSent`, delegate to Express's default error handling rather than trying to write a second response.
- Disable unnecessary fingerprinting such as `x-powered-by`. Set security headers and content security policy appropriate to the response types, preferably through an established middleware or gateway policy already used by the project.

## Proxy, transport, cookies, and CORS

- Terminate only modern TLS and redirect/reject plaintext at the trusted edge. Ensure internal hops carrying credentials are protected according to the deployment threat model.
- Configure `trust proxy` to match the exact number or addresses of trusted proxies. It affects `req.ip`, `req.ips`, `req.protocol`, host handling, secure cookies, redirects, audit attribution, and IP rate limits. An overly broad setting lets clients spoof forwarded headers.
- Validate hostnames when constructing absolute URLs. Prefer a configured public origin over `req.get('host')` for reset, verification, and OAuth redirect URLs.
- CORS is a browser response-sharing policy, not authentication or authorization. Allowlist exact origins/methods/headers needed by known browser clients. Never combine a wildcard origin with credentials, reflect arbitrary origins, or enable credentials globally without a requirement.
- Cookie security depends on correct TLS/proxy configuration. Verify `Secure` cookies in a production-like proxy test instead of weakening the flag when local development is inconvenient.

## Input, output, and abuse resistance

- Set small, route-appropriate JSON, form, raw-body, and upload limits. Bound parameter counts, multipart fields/files, decoded sizes, decompression, and nesting where the selected parser supports it. Stream large data instead of buffering it.
- Reject unsupported content types before expensive work. For uploads, verify actual content as required, generate server-side storage names, keep files outside executable/static paths, and scan or quarantine when the threat model calls for it.
- Use parameterized database operations and allowlist dynamic identifiers. Prevent mass assignment with explicit request DTOs. Encode output for its target context if the API ever emits HTML, CSV, XML, or other executable/interpreted formats.
- Protect outbound HTTP against SSRF: allowlist destinations/protocols where possible, resolve and validate addresses through the chosen client/control, block link-local and internal metadata targets unless explicitly required, limit redirects, and set connection/response/body timeouts and size limits.
- Apply layered rate/concurrency limits to authentication, recovery, search, export, upload, webhook, and expensive mutation endpoints. Prefer a distributed enforcement point when instances scale horizontally. Define the key, window/algorithm, trusted client-IP source, response contract, and fail-open/fail-closed behavior.
- Use request deadlines and cancellation signals for downstream work where libraries support them. Do not keep doing database or network work after the client is gone when it is safe to cancel.

## Errors, logs, and telemetry

- Give each request a server-generated correlation ID; accept a caller-provided ID only after strict length/character validation, and distinguish it from trace context. Return a safe identifier so operators can correlate a failure.
- Use structured logs with stable event names and fields. Record method, route template rather than raw secret-bearing URL, status, duration, correlation/trace identifiers, and a non-sensitive principal/integration identifier when justified.
- Recursively redact authorization/cookie headers, passwords, API keys, session IDs, tokens, reset codes, signatures, secret configuration, and sensitive domain data. Do not dump whole request/response objects or environment variables.
- Separate operational error detail from the client response. Unexpected failures return a generic server problem while telemetry receives the exception, safe context, and stack. Avoid double-logging the same error at every layer.
- Emit metrics for request rate, latency, errors, saturation, auth failures, authorization denials, rate limiting, dependency health, and queue/pool pressure. Alert on symptoms and security signals without exposing high-cardinality secrets or personal data as labels.

## Lifecycle and reliability

- Validate all configuration before accepting traffic. Start listeners only after required dependencies are ready, and expose distinct liveness and readiness behavior. Health endpoints must not disclose versions, topology, credentials, or detailed dependency errors publicly.
- On `SIGTERM`/`SIGINT`, stop accepting new work, mark readiness false, drain keep-alive connections and in-flight requests within a configured deadline, close database/queue clients, flush bounded telemetry, then exit non-zero if graceful shutdown cannot complete. Keep shutdown idempotent.
- Set server header, request, keep-alive, and shutdown timeouts deliberately and coordinate them with the upstream proxy/load balancer. Defaults should not be accepted without checking the deployment.
- Move compression, static assets, buffering, and other edge concerns to a reverse proxy when that is the established architecture; otherwise configure them with resource and information-leak risks in mind.

## Security-focused tests

Use the assembled Express app and real middleware ordering for non-mocked HTTP tests. Include:

- parser limits and malformed encodings/content types;
- authentication before protected handler execution, and authorization before protected data access or mutation;
- cross-tenant and wrong-owner cases using two valid principals;
- CORS preflight and credential behavior for allowed and denied origins; CSRF behavior separately for cookie-authenticated writes;
- spoofed `Forwarded`/`X-Forwarded-*` headers under the actual `trust proxy` setting;
- error mapping, `headersSent` handling where streams exist, safe production bodies, and recursive log redaction;
- duplicate idempotency keys, racing conditional updates, rate-limit boundaries, request cancellation, and graceful shutdown where applicable;
- signed-webhook raw bytes, invalid signatures, stale timestamps, and replayed event IDs.

Do not weaken runtime security to simplify tests. Inject trusted clocks, key sets, identity verifiers, policy services, stores, and log sinks through the same production interfaces.

## Sources

- [Express production security best practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Express production performance and reliability](https://expressjs.com/en/advanced/best-practice-performance.html)
- [Express error handling](https://expressjs.com/en/guide/error-handling.html)
- [Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
