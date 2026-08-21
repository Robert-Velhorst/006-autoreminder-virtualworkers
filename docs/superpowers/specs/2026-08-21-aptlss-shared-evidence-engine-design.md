# APTLSS Shared Evidence Engine Design

## Status

Proposed and user-approved for planning. This document does not authorize external
actions, database migration, or product-code changes by itself.

## Purpose

APTLSS will become a shared, evidence-backed operational intelligence system for
virtual workers. It must continuously synthesize the available operational record,
recommend the most appropriate next step, keep the daily plan current, and improve
from verified outcomes.

It must not present inference as fact or execute external side effects without an
explicit human action and the existing approval policy allowing that action.

## Confirmed Product Decisions

- All virtual workers operate under the same role, authority, and responsibility.
- Workers may view shared raw operational details, including linked cards,
  communication, documents, time records, assessments, and evidence history.
- The platform retains an audit trail for raw-detail access and mutations.
- APTLSS may automatically reassess work and replan internal schedules.
- Trello comments and moves, messages, payments, and other external side effects
  remain explicit, approval-gated actions.
- Source-backed data wins by default. A worker can record a justified exception,
  which remains traceable and is scheduled for re-verification.
- A model-provider outage must fall back to deterministic interpretation and clearly
  communicate reduced confidence.

## Design Principles

1. Evidence before inference. Every assessment links to immutable or versioned
   evidence records and explains its conclusion in terms of those records.
2. Shared operational memory, not opaque memory. The system can learn from the full
   shared work record, but must preserve exact source, timestamp, actor, and
   confidence provenance.
3. Progressive disclosure. The worker sees the current timeline and immediate next
   action first; detailed evidence opens in an inspector without replacing the plan.
4. Calibration over score inflation. Confidence is an estimate of correctness,
   never a target to maximize. Missing, stale, or conflicting evidence reduces it.
5. Localized change. New evidence updates only linked assessments and future
   schedule blocks unless a documented dependency requires broader replanning.
6. Human accountability. A worker can correct an inference, but the original input,
   interpretation, correction, and later verification remain in history.

## Architecture

```text
Trello, Gmail, Drive, time records, compliance, worker updates
                         |
                         v
            evidence normalization and linking
                         |
                         v
              shared evidence graph and audit trail
                         |
              +----------+-----------+
              |                      |
              v                      v
     deterministic interpretation   model-assisted interpretation
              |                      |
              +----------+-----------+
                         |
                         v
          APTLSS assessment and confidence engine
                         |
              +----------+-----------+
              |                      |
              v                      v
   internal plan reconciliation     worker questions and exceptions
                         |
                         v
        timeline plus right-side evidence inspector
```

The evidence graph is an additive operational layer. Existing source tables and
integrations remain authoritative for their own data. The graph stores references,
normalization, relations, assessment provenance, and outcome feedback; it does not
replace Trello, Gmail, Drive, time tracking, or existing APTLSS records.

## Evidence Model

### Evidence Item

Each evidence item represents a concrete observation or worker-supplied statement.

Required fields:

- stable identifier and type;
- source system and source reference;
- observed time, ingested time, and last verified time;
- actor, when supplied by the source;
- raw payload reference or source-safe snapshot;
- normalized searchable summary;
- truth class: `source_confirmed`, `worker_confirmed`, `derived`, or `unverified`;
- freshness policy and optional expiry;
- tenant/organization scope plus audit metadata.

Examples include a Trello card activity, a Gmail message, a Drive document update,
a time entry, a compliance observation, a recorded decision outcome, and a worker
free-text update.

### Evidence Relation

Relations attach evidence items to operational subjects: card, project, worker,
person, deadline, decision, waiting reason, schedule block, or assessment. Each
relation identifies how it was made: source-native, deterministic match,
model-suggested-and-confirmed, or worker-confirmed.

### Worker Exception

A worker exception is not a replacement for source evidence. It stores the original
assertion, reason, optional supporting links, creator, timestamp, and verification
status. The system schedules a follow-up when its verification condition becomes
due.

## Assessment Model

An assessment describes the current operational interpretation of a work subject.
It is derived, versioned, and always links back to its evidence set.

An assessment includes:

- state and state explanation;
- priority, urgency, risk, and suggested next action;
- waiting reason, owner, expected response, and follow-up time when applicable;
- confidence score, confidence band, and factor breakdown;
- evidence set, conflicts, missing-evidence requests, and dependency links;
- planning effect and audit metadata.

The existing APTLSS plans, steps, audit records, assessments, feedback, waiting
reasons, operational policies, and daily plans remain part of the current-state
model. The new layer provides a canonical explanation and durable evidence history
for decisions made from those records.

## Confidence and Conflict Rules

Confidence derives from five independently inspectable factors:

1. Source coverage: relevant cards, communication, documents, time, decisions, and
   prior commitments are available when expected.
2. Corroboration: independent sources agree on the relevant conclusion.
3. Freshness: source evidence is current enough for the state being inferred.
4. Consistency: source status, worker input, and adjacent evidence do not conflict.
5. Calibration: comparable prior assessments have a demonstrated outcome quality.

Confidence bands:

| Band | Behavior |
| --- | --- |
| High | Reconcile the internal plan and show an execution-ready next action. |
| Medium | Reconcile provisionally and show the missing verification item. |
| Low | Ask one targeted question and prevent unverified completion claims. |
| Conflict | Surface the competing evidence and require an explicit worker resolution or escalation path. |

No workflow may raise a score merely to meet a target. Provider failure, missing
credentials, source lag, or uncertain linkage reduces available confidence.

## Free-Text Update Flow

1. The worker submits an update in ordinary language.
2. The system preserves the original text as evidence.
3. Deterministic matching identifies candidate cards, projects, people, waiting
   reasons, and prior commitments. A model may assist only after source candidates
   are bounded.
4. APTLSS produces a preview: inferred meaning, linked evidence, confidence,
   conflicts, and recommended next action.
5. The worker confirms or corrects the preview.
6. The confirmed interpretation creates a versioned evidence relation, updates the
   affected assessment, and selectively reconciles future plan blocks.
7. If verification is incomplete, the system creates one specific follow-up rather
   than treating the update as a confirmed fact.

## Plan Reconciliation

APTLSS can modify future internal schedule blocks after an assessment change.

It must:

- preserve completed blocks;
- preserve the active timer and active block unless the worker explicitly changes
  it;
- prioritize ON-HOLD, then DOING, then TO-DO work when all other risk factors are
  equal;
- respect working hours, protected breaks, constraints, available minutes, and
  existing non-overlap validation;
- retain a plan-change explanation with the evidence and assessment version that
  caused it;
- keep external consequences as proposals requiring explicit approval.

## Worker Experience

The worker's primary surface is a full-day timeline with progressive disclosure.

- The full timeline remains visible for daily orientation.
- The active block is expanded and shows the exact next action, state, risk,
  active timer, and approved internal actions.
- Other blocks remain compact until selected.
- A narrow right-side signal rail shows confidence coverage, conflicts, plan health,
  and a free-text update entry point.
- Selecting a block opens a right-side inspector instead of navigating away. It
  shows the assessment explanation, linked raw evidence, conflicts, questions,
  history, and approval-gated secondary actions.
- The inspector must use plain language, never hide uncertainty, and show why a
  question or recommendation exists.

## Learning and Feedback

APTLSS learns only from outcome records, not from unstated assumptions. For each
assessment the platform retains the evidence snapshot, recommendation, confidence,
worker response, eventual verified result, and calibration classification.

Learning may improve ranking, follow-up timing, expected duration, likely evidence
requirements, and recommended next actions. It may not rewrite historical evidence
or silently change the meaning of prior worker statements.

## Security and Audit

- Existing role checks, tenant/organization boundaries, approval policy, and
  external-action gates remain mandatory.
- Shared worker access does not remove authentication or audit requirements.
- Access to raw evidence, assessment generation, corrections, plan changes, and
  external-action proposals is auditable.
- Provider secrets and raw credentials never enter evidence payloads, summaries,
  logs, or model prompts.
- Evidence retrieval and model prompts must use the smallest relevant context set,
  with source references, limits, and redaction rules.

## Degraded States

- Missing provider configuration: use deterministic matching and label model-derived
  suggestions unavailable or lower confidence.
- Missing source credentials or stale synchronization: identify the source gap and
  do not infer a completion from absence of evidence.
- Database unavailable: disable persistence-dependent recommendations and explain
  that results cannot be made durable or trusted.
- Ambiguous linkage: show candidate subjects and require worker confirmation before
  making the relation authoritative.

## Verification Strategy

### Server

- Evidence normalization, natural-key deduplication, relation provenance, and
  shared-access audit records.
- Assessment factor calculation, band boundaries, stale evidence, conflicting
  sources, and deterministic fallback.
- Free-text preview, correction, confirmation, and targeted question behavior.
- Replanning that preserves completed/active blocks, prevents overlap, honors
  constraints, and records a causal explanation.
- No-side-effect assertions for all assessment and planning procedures.
- Authorization, tenant boundaries, model-context minimization, and secret
  redaction.

### Client

- Timeline loading, empty, degraded, and error states.
- Current block expansion, compact future blocks, and inspector opening without
  timeline loss.
- Source links, confidence explanation, conflict presentation, and worker
  correction flow.
- Accessible keyboard navigation and desktop/mobile overflow checks.

### Integration

- Trello, Gmail, Drive, time, and compliance evidence linking with provider-safe
  failure behavior.
- Existing worker, founder, and admin routes remain available and distinct.
- External action proposals require explicit approval and do not create a comment,
  message, card move, or payment during assessment/replanning tests.

## Migration Lineage

The canonical `main` branch currently ends at migration
`0031_worker_operator_scope`. This design introduces only additive schema changes
through a new `0032_aptlss_evidence_graph` migration. It does not depend on
uncommitted local migrations that may exist in other working directories.

## Delivery Phases

1. Establish a current-state test baseline and document the existing APTLSS data
   contract.
2. Add the evidence graph and migration lineage additively.
3. Build normalization and relation services for existing evidence sources.
4. Add assessment provenance, confidence factors, conflict detection, and outcome
   feedback.
5. Add selective plan reconciliation and audit explanations.
6. Implement the timeline, signal rail, right-side inspector, and free-text preview
   workflow.
7. Complete regression, migration, authorization, browser, and degraded-state
   verification before any production cutover.

## Explicitly Out of Scope

- Autonomous external communication, card mutation, payment, or task completion.
- Replacing source systems as the canonical record of their own data.
- Rewriting or deleting historical evidence when a newer assessment differs.
- Fabricating source proof, inflating confidence, or treating model output as a
  primary source.
