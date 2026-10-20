# APTLSS project manager implementation

The later approved reliability plan supersedes automatic activation in this initial
design: all managers now start in shadow mode. See ../../APTLSS_RELIABILITY.md for
the implemented safety contract and the required human acceptance trial.

Approved direction: automatic internal replanning, prepared follow-up actions and drafts, immediate intervention for consequential conflicts, and duration estimates learned from a worker's completed work. External communication requires the worker to review and send. Preserve all existing portals and data.

Implementation contract:
1. Gather worker-scoped plans, steps, states, waiting reasons, linked source evidence, email, communication, outcomes, and completed time records. Report missing/stale/truncated sources instead of claiming complete knowledge.
2. Produce a deterministic, auditable manager result: chronological actions, dependencies, completion criteria, duration ranges, evidence references, and targeted interventions. Unverified worker updates cannot complete work or override conflicting source facts.
3. Persist immutable manager cycles and a separately configurable per-worker interval. Reconcile changed future blocks automatically; protect completed/active work, working days, breaks, and active timers. Avoid repeated model/API calls for unchanged input.
4. Expose manager status, actionable instructions, source context, worker updates and intervention responses in the existing worker dashboard. Show errors and last assessment time.
5. Test behavioral scenarios, worker isolation, persistence, automatic cycles, migration metadata, browser flows, and build.

Ruling: personal duration history only for this iteration; cross-worker learning was not confirmed. Initial estimates are explicitly labelled until enough comparable completed steps exist.
Ruling: only actually ingested source records count as evidence. The manager does not claim access to unconnected platforms. No new external communication is sent by assessment or scheduling.
Ruling: do not merge or modify the running main deployment during implementation; this work extends the existing isolated feature checkout.

Progress: inspection complete; implementation in progress.
