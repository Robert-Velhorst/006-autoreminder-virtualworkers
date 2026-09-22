# UI Action Audit

| Surface | Primary action | Secondary information | Deep actions |
| --- | --- | --- | --- |
| Worker Today | Start current work | Next items and plan health | Card inspector |
| Inbox | Process one exception | Compact queue counts | Item inspector |
| Decisions | Record required outcome | Recommendation and evidence | Decision inspector |
| Time and Pay | Start/stop and reconcile | Overtime and compliance | Period evidence |
| Reminders | Review or process due item | Policy and delivery state | Reminder detail |
| Settings | Configure one subsystem | Health and last-run state | Collapsible controls |
| Admin | Inspect platform condition | Worker and job summaries | Dedicated admin routes |

## Rules

- A row never exposes several competing external actions.
- Context lives in summaries; mutations live in an inspector or explicit form.
- Long lists start bounded and reveal more on request.
- Disabled controls explain the missing credential, evidence, permission, or
  prerequisite.
- Loading operations show stage, elapsed time, progress, and an estimated
  remaining time when historical duration exists.
- Empty and degraded states use real system state, never sample work presented
  as live data.
