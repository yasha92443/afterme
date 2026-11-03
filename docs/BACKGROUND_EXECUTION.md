# Staged background execution (schema 24)

For the candidate Free Durable Object execution profile, see
[Durable runtime](DURABLE_RUNTIME.md). Its acceptance gate is separate from
the direct Worker profile.

Enable `BACKGROUND_EXECUTION_MODE="staged"` only after applying migration 24 and
checking the deployment's isolated CPU acceptance results. The independent-lane
profile also sets `BACKGROUND_LANE_SCHEDULING="true"` and uses all three schedules:

```toml
[triggers]
crons = ["* * * * *", "*/2 * * * *", "1-59/2 * * * *"]
```

The first schedule advances one inbox step each minute. The even-minute schedule
alternates owner control and maintenance, giving each a nominal four-minute
interval. The odd-minute schedule advances one ordinary work stage every two
minutes. Each lane has its own lease, so inbox, control and ordinary work advance independently. Confirm that the account can accommodate all three Cron
triggers before activation. Actual Cloudflare scheduling and provider availability
can delay progress; measure delivery timing with the deployment’s actual workload.

The legacy execution mode and the earlier single-lane staged minute schedule
remain available for compatibility and recovery. The staged inbox/control deadlines require the three independent schedules above.
Use the five-minute or shared-minute schedule for the corresponding compatibility profile.

Each invocation holds its scheduler lease and performs one stage. Ordinary work
rotates among mail, PDF validation, discovery, release and confirmation notices;
inactive kinds can be skipped using one availability snapshot. A stage that
exhausts its budget resumes from its persisted state. Validate each stage’s health independently.

| Stage | Work per invocation |
| --- | --- |
| Control | Read current owner/rules, advance absence state, cancel obsolete jobs |
| Inbox | One bounded list step, one detail/parse step, or one stored-message application step |
| Validate | Verify one stored PDF chunk, or finalize its authenticated manifest |
| Discover | Select one candidate from its metadata |
| Notice | Expand one confirmation notice to one recipient |
| Mail | Prepare, start a session, upload one 256 KiB MIME range, or probe a session |
| Release | Advance one independently configured release channel |
| Maintenance | Refresh operational health and queue or clean a bounded amount of work |

Background job payloads and checkpoints use the content encryption key. They can
contain recipient addresses, verification links, MIME headers and resumable upload
URLs. The management status API exposes counts and stage timestamps only.

## PDF size and integrity

Browser generation uses lossless Flate compression when supported and smaller;
the uncompressed/RLE fallback preserves the same document content. Public source
reads are paginated and bind every cursor to the formal revision and layout.
Staged mode removes the legacy 4 MiB total public-source preflight.

`PDF_MAX_BYTES` is an operator-selected, tested artifact capacity. The old 8 MiB
default is retained for compatibility. The absolute resource guard is 64 MiB;
choose actual delivery capacity from the deployment’s CPU and provider acceptance. Gmail's discovery document specifies a 36,700,160-byte MIME upload limit;
Base64, line breaks, headers and text all count toward that wire size. The exact
MIME descriptor is checked before an upload session starts. See the official
[Gmail discovery document](https://gmail.googleapis.com/$discovery/rest?version=v1).

Completing an upload returns HTTP 202 / `validating`. The server freezes the
upload revision, verifies ordered chunks, checks PDF markers and authenticates
the immutable source/layout/length/hash manifest with a domain-separated HMAC.
Only then is the artifact `ready`. `sha256` retains the client's claimed whole
file hash; `manifest_sha256` is the separate server-authenticated manifest digest.
Changing a chunk, source, layout or upload revision invalidates the artifact.

For isolated diagnostics, `PDF_ARTIFACT_CHUNK_BYTES` accepts 16384, 32768, 65536
or 131072 bytes. The compatibility default remains 131072. Each artifact freezes
its chunk size and binds it in its authenticated manifest; existing uploads retain that frozen interpretation after a setting change. Smaller chunks increase request counts,
validation steps and preparation time. Complete Free CPU acceptance for alternative chunk sizes or capacity above
8 MiB remains pending for this candidate.

Oversized files remain saved as text. Automatic delivery uses one complete, validated attachment at the accepted capacity. Select a supported capacity and
complete PDF preparation before relying on automatic delivery.

## Mail dispatch and recovery

The final dispatch claims the send and its daily quota; preparation and earlier
upload ranges retain their preparation state. Immediately before the final request, the runner checks the job lease,
current round, pause/release controls, quorum, frozen audience, source/layout and
current recipient. Release deliveries also require a complete healthy current
round inbox generation no older than five minutes and no unresolved inbound
processing failures. Both the generation's start and completion must be fresh;
an old head page cannot acquire new freshness by finishing its tail page later.
A backlog or incomplete message blocks final release. Multiple pages or continuing
new mail may prevent a generation from closing within five minutes; release stays
blocked in that case.

The runner then reserves the canonical mail claim with an attempt ID and saves
the dispatch intention before network I/O. Canonical delivery identities survive
PDF typography changes. Provider receipts update only the matching attempt.

After a lost upload response, the next invocation probes that existing session;
the probe determines the next verified upload range. A lost final response never starts a new
session automatically. A missing session after final dispatch, or a missing
receipt for a text dispatch, becomes `uncertain` and requires explicit review.
Manual reconciliation invalidates the old attempt and session; the recorded
decision remains authoritative when a late receipt arrives. Explicit retry may start a new upload.

Large files can take an hour or longer as work shares Cron slots with state,
inbox checks and other mail. Delivery also depends on daily quota and provider
availability. Plan for this queued processing time before enabling automatic delivery.

Backups through schemas 16–23 still restore. Schema 24 backups retain canonical
sent/uncertain claims and provider receipts, but restore discards derived jobs,
leases and upload sessions. The lane lease table is derived runtime state and is rebuilt after recovery. Restores remain release-suspended in a new round.
Content-key migration has independent item, chunk, job and manifest cursors with
a shared row limit; keep the legacy key until every page verifies without conflicts.

## Acceptance before production

Use a separate Free Worker, D1 database and HTTP mock that actually consumes the
MIME bytes. Do not send test messages through real Gmail or change production
rules/content to generate test work. For every stage collect at least 100 CPU
samples and observe at least 20 natural Cron runs. The target is p99 at most
8 ms, every observed sample below 10 ms, and no `exceededCpu` outcome. Keep failed
samples in the evidence. Run the gate on the full workload and retain its complete stage samples. If a required stage fails, leave staged production activation pending.

The October 2026 isolated candidates failed this gate: authenticated requests,
inbox application, validation and mail work included CPU overages. A valid 24 MiB
synthetic PDF reached artifact readiness, but its subsequent mail run encountered
`exceededCpu`; end-to-end delivery failed at that mail stage. Later local changes
have local functional regression evidence; complete remote CPU acceptance awaits
the final candidate’s isolated run. Production activation remains pending. The recorded findings identify the tested versions and failing stages for the next acceptance run.
