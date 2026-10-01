# REST API design

Use this reference when defining or reviewing an Express HTTP contract.

## Resources and methods

- Model stable resource nouns in paths: `/orders`, `/orders/{orderId}`, `/orders/{orderId}/items`. Use a command or subordinate resource such as `/orders/{orderId}/cancellations` only when the domain operation does not fit a normal resource state transition.
- Keep identifiers opaque to callers. Avoid exposing database structure, sequential IDs where enumeration is harmful, or tenant identity as an authorization mechanism.
- `GET` and `HEAD` are safe and must not cause requested state changes. `PUT` replaces the client-addressed resource and is idempotent. `PATCH` applies a documented partial-update format. `DELETE` is idempotent in intended effect. `POST` creates under a collection or performs a non-idempotent operation.
- When clients must safely retry an otherwise non-idempotent write, define an idempotency-key contract. Scope a high-entropy key to the authenticated principal and operation, atomically reserve it, store a request fingerprint and the final outcome for a documented lifetime, return the same result for an identical retry, and reject key reuse with different input.
- For concurrent mutation, expose a version or strong ETag and require `If-Match` where lost updates matter. Return `412 Precondition Failed` for a failed precondition rather than silently overwriting.

## Status codes and headers

Use the narrowest standard status that matches the result and keep it consistent across endpoints:

| Situation | Typical response |
|---|---|
| Read or synchronous update succeeds | `200 OK` |
| Resource created | `201 Created` with `Location` |
| Work accepted but unfinished | `202 Accepted` with a status resource or polling link |
| Success has no representation | `204 No Content` |
| Request syntax or framing is invalid | `400 Bad Request` |
| Authentication is absent or invalid | `401 Unauthorized` with an appropriate `WWW-Authenticate` challenge |
| Identity is valid but action is forbidden | `403 Forbidden`; use `404` only as a deliberate resource-concealment policy |
| Resource does not exist | `404 Not Found` |
| Method is known but unavailable for this resource | `405 Method Not Allowed` with `Allow` |
| Current resource state conflicts | `409 Conflict` |
| A conditional request fails | `412 Precondition Failed` |
| Media type is unsupported | `415 Unsupported Media Type` |
| Syntax is valid but semantic validation fails | `422 Unprocessable Content` |
| Caller exceeds a limit | `429 Too Many Requests`, normally with `Retry-After` |

Do not return `200` with an error-shaped body. Do not invent status codes. Set caching headers intentionally, especially for personalized or credential-bearing responses; do not let shared caches store them accidentally.

## Representations and validation

- Accept only documented media types and character encodings. Return the declared `Content-Type` on every body.
- Use one schema per operation and direction rather than binding persistence models directly. Allowlist writable fields to prevent mass assignment. Treat an empty value, omitted value, and explicit `null` as distinct when the contract does.
- Normalize only where the domain defines a canonical form. Do not silently truncate, coerce surprising types, or discard meaningful unknown fields merely to make invalid input pass.
- Return a stable error representation. Prefer the project's convention; for a new API, RFC 9457 Problem Details (`application/problem+json`) is a sound default. Include a stable machine-readable type/code, human-readable summary, instance/request correlation identifier, and field violations where safe. Never expose internal exception text.
- Keep timestamps unambiguous (normally RFC 3339 with an offset), money as an explicit currency plus decimal/minor-unit contract, and enums forward-compatible according to the API's compatibility policy.

## Collections

- Bound page size even when the client omits a limit. Prefer opaque cursor pagination for frequently changing or large collections; document ordering and cursor expiry/consistency semantics. Offset pagination is acceptable for small, stable datasets when its duplicate/skip behavior is understood.
- Allowlist filter and sort fields and operators. Never splice arbitrary client field names or directions into a database query.
- Keep the collection envelope stable and include navigation cursors/links. Avoid expensive exact totals unless the product actually requires them.
- Enforce authorization inside the query or repository boundary as well as after lookup where possible, so cross-tenant rows are not fetched and then accidentally exposed.

## Compatibility and lifecycle

- Prefer additive, backward-compatible evolution: optional request fields, new response fields clients are expected to ignore, and new endpoints. Treat removals, renames, type changes, stricter validation, enum narrowing, and changed error/status behavior as potentially breaking.
- Use the project's versioning strategy consistently. Do not introduce path, header, or media-type versioning for one route in isolation.
- Document deprecation and sunset behavior. When appropriate, use the standard `Deprecation`, `Sunset`, and `Link` headers and give clients a migration path.
- Keep generated documentation and examples free of real credentials or personal data.

## Sources

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
