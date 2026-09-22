# APTLSS manager through a local Codex subscription

## Scope

The evidence-backed manager can use the official, locally installed Codex CLI
with ChatGPT sign-in instead of the OpenAI Responses API. The fixed model is
`gpt-5.6-luna`, starting every assessment at `low` (Light), then `medium`,
and at most `high` only as needed. This does not switch other legacy
platform AI services or the legacy task generator to subscription billing.

There is no added hourly allowance. The existing manager schedule, unchanged-source
reuse, single-flight execution and transient failure backoff still apply.
Subscription usage limits remain applicable and usage is not guaranteed to be small.
The selected provider never falls back to a paid API when it fails.

## Adaptive reasoning

Each request has one unchanged evidence snapshot and at most three sequential
stages: low, medium, high. A validated sufficient answer stops immediately.
Escalation requires a source-linked context review (ambiguity, chronology or
cross-source interpretation), or a recoverable structured-output/citation error.
Duplicate passages are not independent sources. Higher effort does not increase
the evidence available or make a source authoritative.

Missing evidence is reported for verification rather than triggering more
reasoning. Login failures, subscription limits, transport failures, prohibited
tool activity and authority-check failures do not escalate. An unresolved high
result remains rejected. No lower-stage candidate is applied while a later stage
is pending. Every stage uses the same source and permission validators, including
a second validation in the server before persistence.

Used levels, escalation reasons, durations and available token counts are stored
with the existing semantic-review record. The worker sees the actual sequence.
Subsequent independent assessments start at low again. The host protocol is
version 2 with route `luna-adaptive-v1`; older high-only runners fail closed.
The whole request has a seven-minute watchdog; each CLI process has a two-minute
timeout. These prevent stuck processes, not an hourly usage allowance.

## Local operation

1. Install the official Codex CLI and sign in with ChatGPT on the host computer.
2. From this recovery checkout run `scripts/Start-ManagerCodex.ps1` in PowerShell.
3. Select `APTLSS_MANAGER_PROVIDER=codex-subscription` and set
   `APTLSS_CODEX_QUEUE_DIR` to the private transport queue.
4. For the verified Docker pilot, use `PILOT_CODEX_SUBSCRIPTION=true` with
   `scripts/aptlss-pilot-compose.mjs`. Its optional deployment overlay mounts
   only `.local/pilot/codex-queue` at `/app/codex-queue`.

The host runner must remain running. This implementation does not install a
Windows startup task: start it again after reboot. The host machine and its
Docker dashboard must both be available. No external Codex listener is exposed.
The launcher rejects duplicate runners and waits for a readiness heartbeat.
Metadata-only logs are under `.local/pilot/codex-private`.

## Boundaries

- Authentication remains in the local Codex installation, never in the container.
- No API credential, database password or custom provider URL is inherited by
  the Codex subprocess. ChatGPT login is required before every assessment.
- Requests contain bounded manager evidence only, with identity, content hash,
  expiry and cancellation. Results must match the request and fixed output schema.
- Codex runs read-only with shell, browser, plugins, MCP, memories and other
  action capabilities disabled. Tool events and unknown errors reject the result.
- Existing source-quote and semantic validators remain authoritative. Model
  output cannot complete work, resolve conflicts or invent evidence by itself.
- The pilot remains shadow-only for worker 2. No external messages or Trello
  mutations are added. Existing production authentication stays enabled.
- Transport files are temporary and private. Only matching request files are
  removed; application evidence and history are retained.

## Verification and recovery

The safety suite includes bridge identity, cancellation, disabled capabilities,
no-paid-fallback and provider-specific UI tests. A fresh full shadow-pilot safety
attestation must match the built image before deployment. A real subscription
smoke test is separate from mocked tests; it does not establish production
accuracy or acceptance of active automatic planning.

An offline bridge or rejected result leaves deterministic checks available and
adds a visible warning. Stop the host runner to stop subscription processing;
the app does not silently select an API. Switching back to the API is an explicit
provider configuration change and may incur separate API charges.

Official references:
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Configuration](https://learn.chatgpt.com/docs/config-file/config-reference)

## Pilot verification, 13 September 2026

- TypeScript check passed. Production Docker build passed.
- General suite: 1,526 passed, 67 existing optional tests skipped.
- Separate safety suite: 681 passed, zero skipped; 350 fixed regression cases.
- Browser suite: 27 passed, including real test-MySQL worker/admin workflows
  and provider-specific UI fixtures. These are not live-provider accuracy tests.
- Safety digest: `94755a149103ce0d24cdcef95aaf430acc1efcb9406c285df789d387baca1cdd`.
- Deployed image: `va-dashboard:joyce-shadow-codex-20260913`, image digest
  `sha256:71136bc28ac3b81093f334d8990859cd6ba5916b7165c8d0c4bbb7123b10a4dc`.
- Readiness returned HTTP 200. Public worker UI displayed Codex subscription,
  Luna, high. No authentication change or database migration was performed.
- Eight daily plans had the same content hash before and after deployment;
  zero manager runs had an applied plan.
- A small empty-context subscription smoke returned valid structured output.
- The first real evidence request completed through Codex at 18:49:38 UTC,
  using 19,527 input and 4,549 output tokens. However, manager run 1772 rejected
  its result in the existing validation pipeline. It retained deterministic
  advice and displayed the warning; no paid fallback occurred. This establishes
  working transport, not accepted semantic advice or active-mode readiness.
  The specific validation rejection still requires diagnosis.

The prior verified image `va-dashboard:joyce-shadow-reliability-20260913` and
proof directory `.local/pilot/proof-reliability-20260913` remain available.
An explicit deployment with that image, that proof directory and
`PILOT_CODEX_SUBSCRIPTION=false` restores the previous API-provider configuration;
it does not remove history. Do not use a historical capture's generic rollback
target when the intended rollback is this immediately previous version.

## Adaptive routing verification, 13 September 2026

This receipt supersedes the fixed-high routing above; the earlier receipt remains
as historical evidence.

- Each assessment starts at Luna low, then may proceed to medium and high in
  order. High is the maximum. No extra hourly quota or paid API fallback is added.
- General suite: 1,544 passed, 68 optional tests skipped. Separate safety suite:
  700 passed, zero skipped; 351 regression cases and real MySQL integration.
- Browser suite: 27 passed, including the adaptive provider label and recorded
  effort sequence. Production Docker build passed.
- Safety digest: `a896a0f3838686c57e2a34f045ed9f3b8b3f25a7f0e58f92da7ec24b733aae1c`.
- Deployed image: `va-dashboard:joyce-shadow-codex-adaptive-20260913`, digest
  `sha256:cbe7071c7138fd0d21e765998b0494537f5e2c2161b98ce2d0b999e1a6d79da3`.
- Readiness returned HTTP 200 and the container was healthy. The authenticated
  public worker page displayed "low first, high maximum".
- A synthetic, source-backed subscription review completed on low in 6,734 ms,
  with 3,969 input and 112 output tokens. Its exact source quote passed the shared
  validator. Medium/high escalation was tested deterministically, not forced in
  a paid or subscription live trial. This does not establish operational accuracy.
- Eight daily plans retained the same before/after content hash:
  `1961dbc05856efa3f40c10ad2daefaf257b3b572feefd1ecdcef0b13f6382e99`.
  Zero manager runs had an applied plan. No database migration or authentication
  change was performed; the deployment remains shadow-only.
- Latest retained operational snapshot at deployment was run 1775, with a
  successful pre-adaptive semantic review. Unchanged-source reuse is preserved;
  this snapshot is not evidence that a live operational adaptive cascade ran.

The previous fixed-high image is retained, but its version-1 bridge protocol is
incompatible with the adaptive version-2 runner. Rolling it back requires the
matching runner as well; an app-only rollback fails closed instead of using an
API fallback. The adaptive proof is retained in
`.local/pilot/proof-codex-adaptive-20260913`.
