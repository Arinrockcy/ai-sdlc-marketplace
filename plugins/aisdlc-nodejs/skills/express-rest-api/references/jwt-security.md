# JWT security

Use this reference whenever an Express API issues, accepts, refreshes, rotates, revokes, stores, or tests a JSON Web Token. Preserve stricter requirements from the token's defining protocol or profile.

## Establish the token profile

Before choosing code or a library, record:

- the token's purpose: OAuth access token, OpenID Connect ID token, refresh token, logout/security event, or application-specific assertion;
- the trusted issuer, intended recipient/audience, accepted signing algorithms, key source, required header and claim values, maximum lifetime, clock tolerance, and revocation behavior;
- whether it is bearer or sender-constrained, who may issue it, who may verify it, and whether its contents require confidentiality;
- the standard profile that defines it. For OAuth JWT access tokens, prefer RFC 9068 when the authorization server and resource server support that profile.

Use separate, mutually exclusive validation profiles for different issuers, audiences, environments, and token purposes. Do not pass every JWT through one permissive validator. An ID token is consumed by the OpenID client that requested authentication; it is not a bearer access token for an API. A refresh token is not accepted by a resource server.

JWT is not automatically preferable to an opaque token. Prefer an opaque identifier with server-side state or introspection when immediate revocation, minimal disclosure, or centralized authorization outweighs local verification. A signed JWT provides integrity and issuer authentication, not confidentiality: its header and claims are normally readable by anyone holding it.

## Validation pipeline

Use a maintained JOSE/JWT library through its high-level verification API. Configure the policy in trusted server-side code; never let token input select the policy.

1. **Bound and parse.** Enforce a small configured token/header size before expensive work. Reject malformed serialization, invalid base64url/UTF-8/JSON, duplicate or ambiguous members, unsupported critical headers, and a token shape outside the selected profile. Do not hand-parse a JWT for security decisions.
2. **Pin the JOSE policy.** Supply an explicit allowlist of signing algorithms. Reject `alg: none` for authenticated API tokens and reject algorithm/key-type confusion such as treating an asymmetric public key as an HMAC secret. Require the expected `typ` value when the profile defines one; RFC 9068 access tokens use `at+jwt`. Process `crit` only when every named extension is explicitly supported.
3. **Resolve only trusted keys.** Bind the issuer to preconfigured keys or trusted discovery metadata. Treat `kid` as an untrusted, bounded selector, not a filename, query fragment, command, or URL. Never follow arbitrary `jku`, `x5u`, or embedded key material from the token. Restrict remote key retrieval to the configured issuer's HTTPS metadata/JWKS endpoints.
4. **Verify before use.** Verify the complete signature/MAC before trusting or acting on any header or claim. For nested or encrypted JWTs, validate every cryptographic layer and the inner token's profile; decryption alone is not authentication.
5. **Validate claims and types.** Require the profile's claims and their JSON types. Match `iss` exactly, require the intended `aud`, enforce `exp` and `nbf`, and validate `iat` plus a configured maximum token age when the profile needs it. Apply only a small documented clock tolerance. Validate subject, authorized party/client, scopes, tenant, authentication context, and `jti` semantics as required by the operation.
6. **Build a minimal principal.** Copy only allowlisted, normalized claims into the application's principal. Treat claim values as untrusted input for database, filesystem, log, template, and outbound-request use even after the token is authentic. Token validity authenticates an assertion; route and object authorization still run separately.

Fail closed on validation or key-resolution errors. Return the API's generic `401` contract and an appropriate `WWW-Authenticate: Bearer` challenge without revealing whether a signature, claim, account, or key lookup failed.

## Keys and JWKS

- Prefer asymmetric signing when one issuer serves multiple independent verifiers: verifiers receive only public keys and cannot mint tokens. With HMAC, every verifier holding the shared secret can also issue a valid token; use it only when that trust relationship is intentional.
- Generate keys with a cryptographically secure generator at the strength required by the selected current algorithm. Never use passwords, human-readable strings, repository secrets, or one key across unrelated environments and token purposes.
- Keep private and symmetric keys in the deployment's secret/key-management system with least-privilege access and an audit trail. Do not expose them through application configuration endpoints, logs, diagnostics, or error objects.
- Cache trusted JWKS responses according to bounded policy. Coalesce concurrent refreshes and rate-limit refresh triggered by an unknown `kid`; attempt at most one controlled refresh for a request, then reject. Do not let attacker-chosen key IDs create an outbound-request or memory-exhaustion loop.
- Rotate by publishing a new public key before signing with its private key, retaining old verification keys until all tokens they signed have expired, and removing them after the overlap. Define an emergency compromise path that stops issuance, revokes/blocks the key or affected tokens, replaces it, and records the incident.
- Give every active key an unambiguous identifier and bind it to one algorithm and intended use. Reject a key whose `kty`, `use`, `key_ops`, curve, or algorithm conflicts with the configured profile.

## Issuance and claims

- Keep access tokens short-lived and narrowly audience/scope restricted. Put only data the resource server needs into claims. Do not place secrets, credentials, unnecessary personal data, or rapidly changing authorization state in a bearer JWT.
- Generate `jti` with sufficient randomness when uniqueness, replay detection, or denylisting depends on it. Do not use a predictable database sequence as a security identifier.
- Validate issuance input just as strictly as received tokens. Derive issuer, audience, subject, tenant, scopes, times, and token type from trusted policy and server-side state; do not copy arbitrary request fields into security claims or JOSE headers.
- Use different keys, audiences, issuers, explicit types, or required claims as needed to make token profiles mutually exclusive and resist cross-JWT substitution.
- Use JWE only when the architecture actually requires encrypted token contents and has a complete encryption-key lifecycle. Sign and encrypt in the profile-defined order and validate every layer. An opaque token is often simpler when the resource server does not need self-contained claims.

## Storage, renewal, and revocation

- Send bearer tokens only over TLS and normally in the `Authorization` header. Never put them in URLs, analytics, traces, exception messages, or logs. Redact raw tokens and token-bearing headers recursively.
- In browsers, avoid long-lived bearer or refresh tokens in JavaScript-readable persistent storage when a secure server-side/BFF session is feasible. Cookie-carried credentials require `Secure`, `HttpOnly`, appropriate `SameSite`, and CSRF defenses for state-changing requests.
- Keep refresh tokens out of resource APIs. Rotate refresh tokens for public clients, store only a protected representation when server-side lookup is needed, detect reuse, and revoke the affected token family. A JWT-formatted refresh token does not remove the need for server-side replay/revocation state.
- Self-contained validation does not provide immediate logout. Choose a documented combination of short access-token lifetime, refresh-token revocation, subject/session version or not-before checks, introspection, denylisted `jti`/key IDs, or sender constraint according to the risk and availability requirements.
- Treat authorization changes explicitly. Do not leave removed roles or disabled accounts effective until a long-lived access token happens to expire.

## Express integration

- Authenticate in middleware before protected handlers. Accept the configured bearer scheme and reject missing, malformed, ambiguous, or duplicate credentials. Attach a new immutable/minimal principal object rather than the raw token or claim set.
- Inject a focused verifier that owns issuer profiles, trusted key retrieval, clock, cache, and metrics. Keep routes and services independent of JOSE library details, and do not decode the token again downstream.
- Separate authentication failures (`401`) from authenticated authorization denials (`403`, or the API's deliberate concealment policy). Never use an unverified claim to select a tenant, database, key set, or authorization policy.
- Keep failure metrics low-cardinality and safe: categorize invalid signature, expiry, issuer/audience/type, key resolution, and malformed input internally without recording the raw token or attacker-controlled claim/header values as labels.

## Required tests

Use fixed test keys that cannot be mistaken for production credentials and an injected clock. Cover the selected profile's success case plus:

- unsigned/`none`, wrong algorithm, algorithm/key-type confusion, invalid signature, modified header/payload, weak or wrong key, and unsupported critical headers;
- unknown, missing, oversized, malicious, and rotated `kid`; an untrusted `jku`/`x5u`; bounded JWKS refresh under concurrent unknown-key requests; stale-cache and provider-failure behavior;
- missing/wrong `typ`, cross-use of ID/access/refresh tokens, wrong issuer, wrong/multiple audience, missing required claims, wrong claim types, expired/not-yet-valid/future-issued tokens, maximum-age and exact clock-tolerance boundaries;
- malformed serialization, invalid UTF-8/JSON/base64url, duplicate members where the library exposes rejection, oversized tokens, nested tokens with a failed inner or outer operation, and fuzzed parser inputs when risk warrants it;
- revoked token/session/key, refresh rotation and reuse, authorization changes, wrong tenant/owner/scope, and proof that a valid token alone cannot bypass object authorization;
- generic client errors and challenges, recursive log/trace redaction, and no network/key refresh storm from attacker-controlled input.

Do not satisfy these tests by weakening issuer, audience, type, time, or algorithm validation in test configuration. Exercise the same verifier and middleware assembly used in production.

## Sources

- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068)
- [RFC 7519: JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519)
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750)
