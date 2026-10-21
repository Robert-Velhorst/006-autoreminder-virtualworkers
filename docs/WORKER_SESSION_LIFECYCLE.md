# Worker Account and Session Lifecycle

## Persisted Identity

Migration `0006_worker_session_lifecycle` adds a nonnegative PostgreSQL bigint
session epoch and a dedicated worker lifecycle audit. Epochs are canonical
decimal strings in application/JWT data, avoiding JavaScript integer rounding.
Existing accounts receive zero; new accounts are constrained to at least one.
New signed sessions bind both the immutable user ID and its epoch. A legacy
session without those claims is accepted only for an existing epoch-zero
account, subject to all other checks. Cookie reuse cannot recreate a missing
account through OAuth synchronization.

Database triggers invalidate sessions when credentials or authentication identity
change, or when profiles are inserted, removed, relinked, moved to another
founder, change status or change their Trello identity. Epoch rollback is refused.
Ordinary scheduling/name and sign-in timestamp updates do not revoke sessions.
Trigger updates roll back with the transaction that caused them.

Central authentication and minting require exactly one active worker profile.
Missing, inactive and ambiguous worker relationships fail closed. Administrative
accounts do not require worker profiles. Individual logout still uses persisted
JTI revocation; it is separate from account-wide invalidation. `auth.me` exposes
only an explicit public-identity allowlist, never password hashes or epochs.

## Login and Administrative Changes

Password login captures the account ID/epoch before verifying the password;
session issuance rechecks that proof under an account share lock. A concurrent
reset or offboarding cannot turn verification of an old password into a session
at a new epoch. Other authentication entry points also carry identity proofs.

Managed creation, credential/profile updates and audit writes are transactional.
Account locks precede profile locks and ownership/linkage is rechecked after
waiting. Offboarding retains the account/profile and historical operational
records instead of deleting them. Explicit nonactive status updates revoke
pending invitations, even if the profile was already inactive. Invitation
activation and its audit record commit together; minting uses the post-trigger
identity returned by that transaction.

## Existing WebSockets

Connections retain their original handshake identity. Inbound packets and each
outbound recipient are reauthenticated; session-room delivery also rechecks
ownership. Failed authorization disconnects the socket and withholds delivery.
No idle polling is claimed: an idle connection is checked at its next inbound
or outbound boundary. Revoked connections cannot upgrade to current credentials.

Redis fanout uses a server-only guarded namespace. The receiving node checks
its own recipients rather than accepting unchecked room broadcasts. These
tests use an injected two-node Redis transport, not a live Redis cluster.

## Cutover and Recovery Requirements

Drain every older application node before enabling this version. Older nodes
do not enforce epochs or exchange guarded events; a mixed-version deployment
is not an accepted security configuration. Do not roll back to a binary that
lacks this contract. Retain a compatible, verified recovery artifact.

Epoch-zero compatibility cannot distinguish an identity deleted and recreated
before this migration. At production cutover, rotate the session signing key
and require fresh logins if historical identity lineage cannot be established.
Also invalidate sessions after restoring or importing older identity/revocation
state; a database restore can otherwise resurrect previously valid credentials.
Production application roles must not have privileges to truncate identity
tables, disable triggers or reset their sequences. Migration/restore roles are
separate operational identities.

## Current Verification Boundary

After integrating main's output-safety changes, the complete test run without
database connections passed 4,002 tests, with 297 skips, on Node 26.12.0. Focused
socket tests and independent source reviews also passed their stated scopes.
Earlier native tests used an older DDL checkpoint and are not acceptance of the
final migration. Hosted source checkpoint `4da72c9` subsequently passed the
final-hash migration, schema parity, full test and build stages in run
`39530488560`; its remaining gates were still running at this checkpoint.
Four additional native races now observe PostgreSQL's actual blocking graph
for both password-reset/mint and invitation-acceptance/offboarding orders.
Those additions were collected but not executed locally; they require a fresh
hosted native/full-suite result before draft acceptance.

The one temporary local PostgreSQL fixture subsequently stopped accepting new
connections while Docker commands stalled. Its stop command completed, but final
Docker inventory/removal verification was still pending at this checkpoint.
This is not a successful migration or cleanup receipt. No real provider or
production infrastructure was changed.
