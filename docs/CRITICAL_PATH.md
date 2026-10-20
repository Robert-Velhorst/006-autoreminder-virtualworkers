# Critical Path

The production outcome is a worker receiving the right next action, acting
through an explicit control, and leaving evidence that the owner can audit.

```text
Source evidence
  -> worker-scoped normalization
  -> APTLSS assessment and confidence gate
  -> work queue or durable reminder
  -> explicit worker action
  -> provider result and idempotency record
  -> compliance and audit history
```

## Blocking Dependencies

1. A valid worker session and role.
2. A database record owned by that worker or explicitly assigned to them.
3. Healthy MySQL; Redis is required when configured.
4. Provider credentials for the requested evidence or external action.
5. A policy check and explicit approval for comments, moves, messages, or mail.

## Failure Contract

- Missing evidence lowers confidence; it never becomes invented evidence.
- Provider failure remains retryable and visible; it is not reported as sent.
- Duplicate jobs are rejected by idempotency keys and leases.
- Cross-worker identifiers return not found or forbidden without leaking data.
- The deterministic APTLSS fallback remains available when the model provider
  is unavailable, and its lower confidence is disclosed.

