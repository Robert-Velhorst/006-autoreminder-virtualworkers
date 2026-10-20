# Acceptance Tests

## Automated Gate

```powershell
pnpm check
pnpm test
pnpm build
pnpm db:verify-parity
pnpm run doctor
```

## Authentication And Isolation

1. Anonymous `/worker` renders login without console errors.
2. Owner bootstrap is visible only while the configured admin has no password.
3. A worker cannot open admin routes.
4. An admin cannot accidentally operate as a worker without an assigned
   worker identity.
5. Worker A cannot read or mutate worker B plans, evidence, decisions,
   reminders, browser records, or Trello cards.

## Worker Critical Path

1. Open Today and see one current action plus a bounded next queue.
2. Generate a plan and observe progress and ETA.
3. Record a waiting reason and verify the next step and evidence history.
4. Record a decision outcome; verify it leaves the inbox and appears in
   history without a Trello side effect.
5. Start/stop time, reconcile overtime, and verify compliance evidence.
6. Process a reminder once; retry does not duplicate delivery.

## Degraded States

- Database unavailable: readiness fails and no success is shown.
- Redis configured but unavailable: readiness fails.
- OpenAI unavailable: deterministic result is labeled lower confidence.
- Google/Trello/browser disconnected: exact setup action is shown.
- Provider rejects a mutation: local record remains failed/retryable.

## Visual Gate

Desktop and mobile must have no horizontal overflow, error overlay, unreadable
text, or overlapping actions. Dark and light themes must retain contrast.
