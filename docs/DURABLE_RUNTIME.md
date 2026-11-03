# Durable Object execution profile

This profile is a candidate until the deployment has completed isolated CPU,
attachment, recovery and 24-hour quota acceptance. Set PDF capacity to the largest
size that passes all of those checks. The direct Worker profile remains available for compatibility.

## Execution and state

`src/durable-worker.js` exports the Worker and `AfterMeRuntime` Durable Object.
With `EXECUTION_RUNTIME=durable-object`, the Worker applies the native rate limit
once and streams the unchanged request to one fixed object, `afterme-runtime-v1`.
The object parses the body and runs authentication, CSRF checks and business
code. The Worker owns the rate-limit decision for each forwarded request.
An invalid runtime setting or missing binding fails closed without direct fallback.

All canonical data stays in D1. Each invocation creates its own environment,
database budget, repository and mail provider. Concurrent HTTP and Cron calls
continue to use schema 24 leases, round checks and receipt fences. D1 holds the durable business state across object restarts.

The three existing Cron schedules call the object through a binding RPC. Background work uses that binding RPC from the scheduled handlers. Rate-limit events
are sampled before a security-recording RPC, at most once per edge isolate per
minute, so a rejected burst shares the bounded sampled security record.

## Configuration and validation

Use `wrangler.durable-object.example.toml` for an isolated candidate. Its
SQLite-backed class migration uses the Free plan’s default CPU settings.
Keep the class name and migration tag stable after initial deployment. Keep
`run_worker_first=true` to preserve authentication on PDF assets.

The candidate retains the 8 MiB artifact default, 128 KiB stored PDF chunks and
256 KiB MIME ranges. Raise `PDF_MAX_BYTES` only to a verified capacity. Exact MIME
wire size is checked separately. PDF generation remains in the browser, and
complete attachments and verification requirements are preserved.

Build the dry-run bundles and check the compiled pages:

```sh
npm run build:durable
npm run check:browser-build:durable
```

Local bundle/browser tests replace the Cloudflare base class in Node and check
compiled handler behavior. Native RPC transport, CPU accounting and billing are
covered by remote acceptance. Run the browser suite
with `AFTERME_TEST_RUNTIME=durable-object` after the durable build to exercise
the compiled handlers. Remote acceptance must use native Durable Objects.

### Local large-attachment exercise (2026-10-30)

`test/staged-final-budget.test.js` now generates a real private PDF from the
same synthetic text saved in its fixture, then adds PDF comment padding before
the final EOF marker to exercise the 9, 16 and 24 MiB transport sizes. The
padding exercises transport size. Rendered-text capacity and public-source
pagination have separate acceptance cases.
With `PDF_MAX_BYTES` set to 24 MiB **only in each local test fixture**, the
encrypted artifact chunks validate as ready, the scheduler builds the complete
MIME stream in 256 KiB ranges, and a mock receiver reassembles and decodes the
attachment with the same SHA-256 as the generated file:

| Synthetic PDF | Complete MIME | Scheduled mail steps | Result |
| ---: | ---: | ---: | --- |
| 9 MiB | 12,915,471 bytes | 52 | Receiver PDF hash matches |
| 16 MiB | 22,959,729 bytes | 90 | Receiver PDF hash matches |
| 24 MiB | 34,438,873 bytes | 134 | Receiver PDF hash matches |

The 24 MiB fixture leaves 2,261,287 bytes below Gmail's 35 MiB MIME ceiling;
different message text and headers may use that space. Measure that wire-size margin for each deployment’s message and headers.

The 24 MiB recovery case additionally loses one accepted intermediate response
and the final receipt. Two probes resume the same upload session; the receiver
gets one complete MIME message and the final range is submitted once. All four
new cases passed, and the full local Node suite passed 539/539. Evidence is in
`output/local-validation-20261030-large-node.log`. They call the shared staged scheduler in Node with synthetic providers and
fixture configuration. Validate the native DO RPC path in the isolated remote run.

The earlier isolated **direct Free Worker** 24 MiB run uploaded and validated
the PDF, then failed with `exceededCpu` during mail advancement after 7,864,320
MIME bytes. Its mail-stage CPU samples had p50 25 ms, p99 42 ms and one failure
among 154 samples (`output/staged-validation/e2e-24m-cpu-progress.json`). The
current path is `runStagedMail` -> `readMimeRange` -> `stagedAttachmentRange` ->
`readValidatedArtifactRange`, which reads, authenticates and hashes the covered
D1 PDF blocks before each MIME range. Those records locate the failing stage;
profile the covered functions to identify CPU cost. Measure Cloudflare CPU and
quota headroom in the native isolated deployment. Native DO
9/16/24 MiB delivery, recovery, CPU samples and 24-hour quota headroom remain
unverified; the production PDF limit stays at 8 MiB.

Record immutable bundle/config hashes and version IDs. Count actual CPU records
separately for `stateless` and `durableObject`. Use platform CPU records for CPU samples, and report HTTP counts and request
duration as separate measurements. Confirm both execution models are present after
reconnecting logs or deploying. Acceptance requires complete samples from valid, active fixture stages.

Engineering gates: ordinary Worker p99 at most 8 ms and every observation below
10 ms; DO p99 at most 100 ms and every observation below 500 ms. Collect at least
100 actual samples per critical path, cold starts and 20 natural Cron calls.
Complete 1/8/9/16/24 MiB MIME delivery to an HTTP sink, interruption and recovery
tests, actual OAuth refresh through a mock endpoint, and at least 24 hours of
running. Verify at least 20% headroom in Free request, active-duration and
database quotas at the intended daily mail cap.

See Cloudflare's [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[quotas and duration accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [CPU observability](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

## Deployment and rollback

Before switching an existing instance, verify a schema 24 backup and offline
restore, and retain an exact rollback bundle and configuration. Rehearse rollback
with synthetic state and interrupted deliveries. Switch production only after
the entire gate passes, then verify read-only health and natural Cron.

Suspend automatic sending before rollback if delivery behavior is uncertain.
Retain D1 state, claims, receipts and uncertain final attempts. Never reset the
database, remove migrations, discard upload checkpoints or automatically resend
an uncertain delivery. A rollback candidate must support the existing schema,
artifact formats and receipts. Keep delivery suspended if a direct-Worker
rollback has not independently passed its Free CPU acceptance gate.
