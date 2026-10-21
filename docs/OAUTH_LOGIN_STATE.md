# External OAuth Login State

This contract applies to the optional legacy external OAuth login. It is
separate from Google evidence/mail consent and Trello authentication. Local
password login remains available without this provider.

## Initiation And Callback

The client navigates to `/api/oauth/start`; it does not construct an external
authorization URL or encode a redirect URI as state. The server requires an
explicit canonical `PUBLIC_URL`, `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL` and
`OAUTH_SERVER_URL`. Production origins use HTTPS. Only an explicit loopback
public origin may use HTTP outside production. Request Host or forwarded-host
headers cannot choose the OAuth callback.

The server generates separate cryptographically random authorization state and
browser binding. An HttpOnly, SameSite=Lax cookie carries the browser binding.
The production cookie uses the Secure `__Host-` prefix with root path and no
Domain attribute, preventing a sibling subdomain from supplying the binding.
Development HTTP uses a separate non-prefixed cookie.

State records use the existing `app_settings` table with a private namespace.
They retain hashes of the random values and the configured callback, not raw
authorization codes, access tokens or raw browser-binding secrets. State expires
after ten minutes according to the database clock. No new schema or automatic
conversion of unrelated settings is required.

Before exchanging a code or touching an account, the callback must atomically
consume one unexpired record matching state, browser binding and callback.
The transaction locks the matching row before checking expiry, so time spent
waiting for another database transaction cannot extend the authorization window.
Only one concurrent callback can succeed, including across application
processes. Missing, malformed, expired, replayed or mismatched attempts do not
authorize a provider exchange. A provider error consumes the attempt: the user
starts again rather than replaying an uncertain exchange.

An invalid unsolicited callback does not clear a separate, legitimate pending
browser attempt. A consumed attempt clears its binding cookie before provider
exchange, including when that exchange later fails. Previously constructed
Base64-redirect state is not accepted; users restart login through the server.

The provider exchange receives the validated callback URI explicitly; state is
not decoded into a redirect. Existing account/session lifecycle validation
still applies before minting the session. Successful login redirects to `/`.
Both routes disable response caching. Error diagnostics must not log complete
provider exceptions, request configuration, authorization codes or tokens.
Configure reverse-proxy/access logging to omit callback query strings as well;
sanitized application exceptions cannot protect a separately configured proxy log.

## Acceptance Boundary

Mounted-route tests can verify provider/account call ordering, cookie flags,
browser swapping, malformed configuration, replay and sanitized errors with a
mocked provider. Native PostgreSQL tests must separately exercise atomic
consumption, database-clock expiry and namespace isolation against a guarded,
privately owned test database. Neither test scope proves that a real provider
accepts the configured authorization/token protocol or registered callback.

Before enabling the compatibility flow on the target host, verify provider
configuration, its registered callback, proxy/TLS cookie behavior and an actual
authorized login. Retain local/Trello access while validating that optional
flow. Drain older binaries that still accept unbound callbacks; do not run
that older login contract alongside the replacement. Deployment, real provider
acceptance and credential revocation remain
separate gates in [Production Cutover](PRODUCTION_CUTOVER.md).
