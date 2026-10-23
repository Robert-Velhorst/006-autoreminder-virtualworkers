# Private Codex Subscription Bridge

## Provider Policy

The application routes text and structured AI work through the private Codex
subscription bridge. Each request starts at Luna low and may advance to medium
and then high for invalid output or a specific need for deeper reasoning on the
same evidence. Missing evidence, authentication failures and subscription
allowance failures are not permission to keep retrying. No paid API fallback or
arbitrary daily token allowance is configured.

The manager and general conversation protocols have separate queue identities.
The general protocol preserves text conversations, JSON objects and locally
validated JSON-schema responses. It explicitly refuses unsupported tool-call,
image and file input rather than silently stripping them. Only final answers
are application content; CLI reasoning events are not worker-facing answers.

The existing `maxTokens` parameter is a requested output budget, not a verified
hard CLI generation limit. A prompt instruction, byte limit or validation after
generation must not be described as a provider-side token or spending cap.
Neither local transport tests nor a healthy heartbeat prove current account
allowance, model availability or successful real generation.

## Host Boundary

Run the bridge on a private host under an unprivileged account. Keep the official
Codex executable and ChatGPT-managed login on that host, outside the app's queue
and container. Never publish authentication files, mount them into the app, or
seed personal account authentication into public GitHub Actions.

The app and bridge must access the shared queue using compatible unprivileged
ownership. The default application image uses UID 1001. Verify actual file
permissions before starting; do not make the queue or private authentication
world-readable to work around a mismatch. Private execution directories must
remain separate from both the queue and each other.

For separate host/container UIDs, opt in with `APTLSS_CODEX_SHARED_QUEUE=true`
on both sides and give the app only the dedicated queue supplementary group.
Precreate the queue and its `requests`, `replies`, `llm-v1`,
`llm-v1/requests`, `llm-v1/replies`, and `llm-v1/dispatch` directories with
the shared GID and mode `2770` (setgid, no other-user access). Only protocol
requests, replies, heartbeats and dispatch grants use mode `0660`; private
instructions, schemas, runner locks and authentication stay `0600` under
private `0700` directories. Sharing is disabled by default. Never reuse an
unrelated application's UID or mount the private workspace or auth home.
The synthetic Linux cross-UID test exercises group inheritance, restrictive
umasks, bidirectional claim/reply cleanup, and denial to an unrelated group.
It also runs the actual manager and general conversation transports under
different runner/client UIDs, with synthetic CLI replies: manager output,
text, locally validated JSON schema, private-instruction denial and graceful
lease/transport cleanup. The isolated fixture is removed after shutdown.
It does not establish real account/model acceptance or a live queue mount.

`deployment/hetzner/prepare-codex-host.py` prepares fixed, separate host paths
and an inactive service from pinned distributions and the accepted v1.0.1
image seal. It refuses existing targets rather than overwriting them. It is
not an upgrade command or an application deployment: login, queue wiring,
matching rebuilt bridge bundles and the acceptance checks below are separate
gates. The prepared canonical GeneralServer configuration adds only the fixed
queue mount and supplementary GID 16006; its root gate checks the dedicated
account and every transport directory before deployment. This source change
does not alter the already-installed production gate or running container.
Queue dispatch remains unconfigured until the runtime explicitly selects its
mounted queue and enables sharing, after matching bridge bundles are accepted.

For an approved shared filesystem, run from a dedicated private workspace. All
queue and execution paths must be beneath that workspace, without symlinks.
Configure the host bridge with absolute paths:

```sh
export APTLSS_CODEX_EXECUTABLE=/absolute/path/to/official/codex
cd /srv/va-dashboard-bridge
export APTLSS_CODEX_QUEUE_DIR="$PWD/queue"
export APTLSS_CODEX_PRIVATE_DIR="$PWD/manager-private"
export APTLSS_CODEX_LLM_PRIVATE_DIR="$PWD/conversation-private"
node /absolute/path/to/accepted/dist/bridge/manager-codex-supervisor.js
```

These are configuration examples, not provisioned paths or a deployment receipt.
The bridge files bundle their JavaScript dependencies; the host needs the
supported Node.js runtime and official Codex executable, not a source checkout,
TypeScript compiler or application database credential. Extract them only from
the accepted exact artifact and verify their hashes against `aptlss-build.json`.

Use `deployment/codex-subscription.yml` to mount **only** the queue into the app.
Set the app's `APTLSS_CODEX_QUEUE_DIR` to its mounted queue path. Host and container
paths may differ; they must refer to the same private queue. No second permanent
app container is required.

## Supervision And Recovery

The combined bridge runs manager and general conversations together, requiring
both protocol heartbeats. A stopped protocol stops its peer. The supervisor
waits for the owned process to exit before replacement and preserves its lease
when shutdown is unconfirmed. It does not steal an existing runner lease.

Each general conversation dispatch requires a short-lived grant from the
application, including every escalation attempt. Fresh authority is enforced
where the caller supplies its authority callback, including guarded ATIS jobs;
the transport alone does not infer a worker's permissions. Other entry points
must be separately verified before claiming global revocation coverage.
Revoked authority must stop further dispatch and prevent an authorized result write. A request already
sent to Codex cannot be recalled; cancellation and ambiguous results must not
be represented as proof that no account usage occurred.

Do not manually delete a lease solely because it looks old. Inspect its owned
process and recorded operation first. Restarting a bridge must not become an
automatic replay of uncertain admitted work.

## Acceptance Before Use

- Exact-head unit, subprocess, schema-validation, browser and image checks pass.
- The private host's official CLI login uses the intended subscription account.
- Supported Luna model and low/medium/high efforts work on that account.
- Shared queue permissions and separate private work/auth paths are verified.
- Real text and structured responses complete without any paid API request.
- Account-limit, disconnection, revocation, shutdown and restart behavior are
  verified without silently repeating uncertain actions.

These operational checks remain separate from APTLSS's human-reviewed shadow
trial and real database cutover. Startup or a heartbeat does not complete them.

Primary references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Ajv validation](https://ajv.js.org/guide/getting-started.html).
