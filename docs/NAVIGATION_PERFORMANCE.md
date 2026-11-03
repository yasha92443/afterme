# Navigation and database performance

The current schema 24 candidate separates quick navigation/text persistence from
browser PDF preparation and bounded delivery. Older deployment timings from
October 2026 identify their original source/configuration; compare current latency
using the current candidate. Use a synthetic fixture and the final compiled bundle for comparisons.

## What the implementation now measures

- `Server-Timing` application duration is request wall time. `db` is the union of
  observed database-wait intervals, so overlapping waits count once; `db_total`
  is cumulative elapsed time across those calls. Measure Worker CPU time separately through the platform.
- `X-AfterMe-DB-Queries` counts SQL statements. `X-AfterMe-DB-Roundtrips` distinguishes
  remote calls: a batch can contain several statements but use one round trip.
  Record rows read, bandwidth and CPU as separate indicators.
- Browser click-to-ready time includes request, rendering and device/network
  effects. Record immediate navigation feedback separately from controls/data
  becoming ready and from PDF preparation finishing.

Local integration targets include at most three database round trips for the
Cookie-authenticated home/settings path and one query for the public health
snapshot. These counter targets apply to the stated fixture; measure latency for each
deployment and workload. Stale/missing health snapshots fail with 503; reads are limited
before expensive work. Large editor/public/recycle data is paginated.

Public reading and authenticated formal previews check access before selecting
chapter text. Their directories show at most 20 chapters, and the complete HTML
response is capped at 64 KiB. SQL reads bounded UTF-8 byte windows; continuation
links retain every displayed byte, including oversized titles and epigraphs.
Pages carry the formal revision and reject a changed version with a restart link.
Public reads also recheck release, suspension and round state before returning.
Printing a reading page prints that page; the authenticated PDF preview serves
the complete prepared document.

## Changes that remove avoidable waits

- Authenticated dashboard/settings reads share bounded snapshots rather than
  chaining duplicate owner/settings/rule reads.
- Chapter directories and selected bodies are loaded in bounded pages. Private
  letters load plaintext only when opened; their directory loads independently of the complete people list.
- Navigation updates immediately with loading/retry state. Shared in-flight reads
  and response-generation checks prevent a late chapter from replacing a newer
  selection, locale/theme state or unsaved input.
- Browser workers prepare PDFs from saved source. Text saving completes before font rendering; interrupted preparation resumes after authentication. Text-save and PDF-readiness states are displayed separately.
- Cron uses a shared D1/statement/external budget and durable cursors/retry state.
  Public monitoring reads a persisted coarse snapshot instead of rerunning the
  complete authenticated diagnostic scan on every external poll.

## Repeatable checks

Run `npm test`, the isolated release-flow rehearsal, the dry build,
`npm run check:browser-build` and `npm run test:browser`. Browser tests require the
Playwright Chromium installation. Use fictional data when injecting latency,
errors, stale responses or upload interruption; never trigger production check-in,
confirmation, release or mail as a performance benchmark.

On an isolated deployment, capture the final source version, fixture size,
configuration, request/statement counts, payload size, click-to-ready distribution,
PDF preparation time and provider CPU observations separately. Exercise cold and
warm reads, pagination, source edits during uploads and natural bounded Cron
continuation. Measure Free CPU headroom on the platform using the final bundle, full fixture
and natural Cron continuation. Remaining remote gates are listed in
[OPEN_SOURCE_READINESS](OPEN_SOURCE_READINESS.md).

## Recorded local and remote evidence (2026-10-21)

The final compiled browser run passed all 9 scenarios. With a controlled 200 ms
delay per tested API request, its ten first-load samples had p95 451.8 ms through
the next animation frame. Cached controls were ready at p95 2.9 ms, and the next
frame measured 3.0 ms. These synthetic measurements describe that controlled fixture: an earlier headless run's cached next-frame p95 was 151.7 ms.

The synthetic query fixture now uses 8 D1 round trips / 9 statements for a normal
idle Cron, and 14 / 17 after all deliveries finish. It retains the send-time SQL
round/version guard. Native MIME/base64 codecs, invocation-scoped content keys,
and skipping completed artifacts remove repeated work. Report query counts alongside separately measured platform CPU.

Remote final completed-queue samples measured 14 D1 calls / 17 statements,
104–122 ms end-to-end and 11/17 ms platform CPU. A prior combined version's
natural Cron constructing two MIME messages measured 43 ms CPU. The final read
batch optimization was tested by HTTP, with no extra natural-Cron sample. Stable Free CPU acceptance remains pending for that version; retain the limitation in the
[readiness evidence](OPEN_SOURCE_READINESS.md).
