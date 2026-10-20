# Task Graph

```text
repository and migration baseline
  -> authentication and worker ownership
  -> evidence ingestion
  -> APTLSS assessment
  -> work queue, decisions, plan, reminders
  -> explicit provider actions
  -> compliance, time, maintenance, audit
  -> health, diagnostics, backup, deployment
  -> automated and browser acceptance
```

Parallel-safe work: UI progressive reveal, documentation, read-only provider
status, and unit tests. Serial work: schema migrations, authentication changes,
provider writes, database transfer, and public cutover.

