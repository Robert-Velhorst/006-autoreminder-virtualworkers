# Request Admission and Public Probes

The HTTP bootstrap calls `configureRequestAdmission` after security headers and
before body parsing, authentication and API rate limiting. That function mounts
only the health router's known GET/HEAD endpoints before ordinary admission.
Unknown health paths continue through normal application controls.

## Application Requests

`createRequestAdmissionLimiter` owns its active and pending requests. Pending
entries retain cancellation handlers, rather than bare callbacks detached from
their connections. A request abort, response close or completion removes its
pending entry; an acquired slot is released once. Dispatch checks connection
state again before entering downstream handlers. FIFO order is preserved for
surviving waiters.

Queue exhaustion and waiting timeouts return HTTP 503 with `Retry-After` and
the JSON retry duration. Client cancellation does not write an error response
to an already closed connection. Queue and concurrency configuration keep their
existing defaults and upper bounds:

| Setting | Default | Maximum |
| --- | --- | --- |
| `MAX_CONCURRENT_REQUESTS` | 100 | 10,000 |
| `MAX_PENDING_REQUESTS` | 500 | 10,000 |
| `REQUEST_QUEUE_TIMEOUT_MS` | 30,000 | 300,000 |

This limits admitted HTTP responses. It does not cancel provider calls or
database work that a route started before its connection was closed; those
operations need their own cancellation, idempotency and durable ownership.

## Health Checks

`/api/health/live` does not query dependencies. Readiness and the `/readyz` alias
retain the existing PostgreSQL schema and configured-Redis checks, independently
of the ordinary application queue. Database-probe waiting is bounded to 2,500ms,
within the current container probe's three-second timeout.

A timed-out underlying driver call is not falsely reported as cancelled. While
it remains pending, later probes share the failed result rather than adding more
unresolved queries. Once that call settles, another probe can establish recovery.
Public errors do not expose driver diagnostics or credentials.

## Verification Boundary

Tests exercise lifecycle events, queue capacity, FIFO cancellation, timeout/
handoff ordering and sustained reuse, plus real loopback HTTP disconnection and
probe saturation through the same mounting function used by production. They
are not a production load qualification, real database outage rehearsal or
proof of provider-work cancellation.
