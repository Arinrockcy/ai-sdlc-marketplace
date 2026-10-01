# Authentication and authorization

Use this reference for login, identity, sessions, bearer tokens, API keys, resource permissions, or signed inbound requests.

## Select the model from the caller

Establish whether callers are a same-site server-rendered browser, browser SPA, mobile/native app, trusted backend, third-party client, or webhook sender. This determines the safe protocol and credential storage model.

- Prefer a managed or established identity provider and a maintained protocol library over implementing authentication protocols, token signing, password recovery, or MFA locally.
- Use OpenID Connect for federated user login and OAuth for delegated API authorization. For redirect-based clients, use Authorization Code with PKCE (`S256`), exact registered redirect URIs, issuer checking, and transaction-bound `state`/`nonce` as applicable. Do not introduce the implicit grant or resource-owner password grant.
- For service-to-service access, use short-lived, audience-restricted credentials issued to a workload identity where the platform supports it. Static shared secrets are a fallback that require explicit ownership, rotation, and revocation.
- Document the trust boundary, credential lifetime, renewal/revocation flow, required scopes or capabilities, and behavior when the identity provider is unavailable.

## Bearer access tokens and JWTs

- Accept bearer tokens in the `Authorization` header, not query strings or URLs. TLS is mandatory. Do not log the header or echo the token.
- Treat a JWT as a token format, not an authentication strategy. A decoded token is untrusted until cryptographic and claims validation succeeds.
- Define a mutually exclusive validation profile for every accepted issuer and token kind. An ID token proves an authentication event to its client; it is not an API access token. A refresh token is accepted only at the authorization service's refresh endpoint.
- Keep access tokens short-lived and least-privileged. Restrict audience to the intended resource server. Where the threat model warrants it, use sender-constrained tokens. Rotate refresh tokens for public clients, detect reuse, and revoke the token family on reuse.
- If immediate revocation is required, design for it explicitly with short lifetimes plus session/version checks, introspection, or a bounded denylist. Do not claim stateless JWTs provide immediate logout by themselves.

For JWT algorithm policy, JOSE headers, claim validation, trusted JWKS lookup, issuance and rotation, storage, revocation, Express integration, and adversarial tests, read [JWT security](jwt-security.md).

## Browser sessions and cookies

- Prefer an opaque, high-entropy session identifier in the cookie and keep session state server-side when immediate revocation, device/session management, or sensitive state is needed. Never put secrets or unnecessary personal data in a client-readable session payload.
- Set `Secure`, `HttpOnly`, and the narrowest workable `SameSite`, `Domain`, and `Path`. Use an application-specific cookie name and expiry. `SameSite=None` requires `Secure` and is not a substitute for CSRF protection.
- Rotate the session identifier after login, privilege changes, password changes, and other authentication-level changes. Enforce idle and absolute expiry and invalidate the server-side session at logout.
- Protect every cookie-authenticated state-changing route from CSRF with the framework's established token/origin strategy. CORS does not stop cross-site form requests and is not CSRF protection.
- Do not store long-lived bearer or refresh tokens in browser-accessible storage when a secure server-side/BFF session can satisfy the architecture.

## Passwords and account flows

When the application must own passwords rather than delegate them:

- Use a maintained password-hashing implementation with a memory-hard algorithm. Prefer Argon2id with parameters calibrated to the deployment and current OWASP guidance; store the algorithm and parameters with each hash so they can be upgraded. Never encrypt passwords or hash them with a fast general-purpose digest.
- Compare using the library's verification function, rehash after a successful login when parameters are outdated, and keep any pepper in a secret manager separate from the database.
- Use generic externally visible responses for login, registration, password reset, and account recovery to resist enumeration. Keep detailed cause only in access-controlled, redacted telemetry.
- Rate-limit login, reset, verification, and MFA attempts using a considered combination of account, principal, network, and device signals. Avoid permanent lockout that enables denial of service. Require re-authentication for sensitive actions.
- Make reset and verification tokens random, single-use, narrowly scoped, short-lived, hashed at rest, and invalidated after use or credential changes. Do not build reset URLs from an untrusted `Host` header.

## Authorization

- Convert validated credentials into one small, normalized principal (subject, issuer, tenant, client, scopes/capabilities, authentication strength). Downstream code must not repeatedly parse raw credentials.
- Deny by default. Check permission for the action and the specific object on every endpoint, not merely at router entry. A valid role or scope may allow an operation class, but object ownership, tenant, relationship, state, and field-level rules still apply.
- Derive the current subject and tenant from the validated principal or trusted server-side mapping. A path/body/query tenant or user ID selects a target; it never proves access.
- Prevent BOLA/IDOR by testing two valid principals with different ownership and tenants. Include collection filters, nested resources, bulk operations, exports, indirect references, and side channels such as existence-revealing errors.
- Centralize policy decisions in focused functions/classes with explicit inputs, but enforce close enough to data access that a forgotten controller check cannot expose cross-tenant data. Record security-sensitive decisions in audit events without logging credentials or sensitive payloads.

## API keys and webhooks

- API keys identify an integration or project; they are not a good substitute for end-user identity. Generate high-entropy keys, show them once, store only a hash, include a non-secret lookup prefix/ID, scope them, record last use, and support overlap during rotation and immediate revocation.
- For inbound webhooks, authenticate the exact raw bytes with the provider's documented scheme before JSON parsing. Verify the signature in constant time through a maintained crypto API, validate a timestamp/window, and deduplicate a stable event ID to resist replay. Do not invent a signing format.

## Sources

- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
