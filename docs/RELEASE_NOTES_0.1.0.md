# AfterMe 0.1.0 source release

Updated for schema 24 on 2026-11-03. The first public source uses the reviewed
November 1 copy candidate, with documentation updates for publication. The UI
redesign continues as a later iteration. Production deployment, capacity and
account security follow the deployment acceptance steps.

The November 1 source review corrects the security/recovery documentation to
schema 24 and all four content-key migration cursors. CI now checks both execution
entrypoints, both browser profiles and reproducible browser assets. These changes preserve product logic and dependency versions. The November 1 local results remain dated evidence; see
[current evidence](OPEN_SOURCE_READINESS.md) and [hosted CI](https://github.com/yasha92443/afterme/actions).
Remote results below describe their tested versions. Production capacity follows
the deployment’s acceptance results.

The approved publication owner, public author and project copyright holder are
**yasha92443**, with copyright year **2026**. Project notices and package author
metadata reflect this choice; upstream third-party notices remain intact.
The source repository is **[yasha92443/afterme](https://github.com/yasha92443/afterme)**.
The account’s actual noreply email was verified in GitHub settings for the source
checkout. The initial source history starts from the audited export.

## Included changes

- A unified people directory links existing verifier and recipient identities;
  explicit profile edits can synchronize their mail language while migration
  preserves existing fields, IDs, frozen rules and delivery receipts. Schema 23
  backups preserve the one-to-one links; older backups rebuild them on recovery.

- Login and management remove decorative slogans. The unsaved indicator follows
  actual form changes and returns to the changed control, including collapsed
  person forms and multiple edited views. Failed saves retain their input and
  unsaved state. Successful draft autosaves clear the indicator; applying a saved
  draft or adopting saved rules at the next check-in remains a separate step.

- Independent frozen private/public release rules, current-round inbox blocking,
  bounded retry/delivery progress and content/recipient mail deduplication.
- Five-minute example schedule and shared invocation budgets covering database
  calls, SQL statements and external dispatches. Budget deferral retains work for the next invocation; uncertain submissions
  follow the separate reconciliation path.
- Text saves and formal apply/discard operations use revision checks. Preparation
  of PDF artifacts runs in the browser background, with resumable 128 KiB uploads,
  saved-versus-ready status, digest checks and private chunk encryption.
- A 4 MiB public PDF source preflight and 8 MiB artifact bound keep capacity
  explicit in legacy mode. Accept the deployment’s actual CPU and email capacity separately.
- Optional staged execution separates state checks, inbox scans, PDF validation,
  discovery, release and mail using independently leased inbox/control/work schedules.
  Lossless browser PDF
  compression preserves text/layout; paged public source removes the legacy
  total-source bound. An authenticated ordered chunk manifest gates readiness.
- Gmail MIME uploads advance in bounded ranges with encrypted session checkpoints.
  Only final dispatch claims a send; lost responses probe the same session.
  Attempt-fenced receipts and explicit reconciliation prevent late results from
  overwriting a reviewed retry. Large files can require an hour or longer.
  Activation and artifact capacity require the [CPU gate](BACKGROUND_EXECUTION.md).
- Optional TOTP MFA, one-use recovery codes, atomic contact/global verification
  quotas, native read/health limits and explicit local-only fallback.
- Bounded content-key migration covers active/pending MFA, private letters, legacy
  PDFs, uploaded private chunks, encrypted jobs and authenticated manifests with
  independent cursors, a shared row limit and compare-and-swap writes.
- Canonical complete recovery format 2 avoids duplicated display copies. Whole
  backup encryption format 2 authenticates 1 MiB chunks and accepts legacy format
  1 on read. Strict restoration supports schemas 16–24 and requires application
  smoke checks before success. Derived jobs, leases and remote sessions are
  discarded on restore; canonical sending/uncertain receipts remain available
  for review.
- Cursor-based editing/public/recycle views, a one-row public health snapshot,
  batched authenticated snapshots and timing/counter telemetry for local analysis.

## Validation and outstanding gates

The repository contains synthetic SQLite/security/concurrency/recovery tests,
compiled-browser checks, Playwright scenarios and an isolated complete release
rehearsal. Current results and remaining external work are recorded in
[OPEN_SOURCE_READINESS](OPEN_SOURCE_READINESS.md). Associate every count and timing with its checked source and date. The November 3
publication changes documentation only; implementation, dependencies and tests
match the November 1 final copy candidate.

Prepared-browser-PDF delivery and bounded Cron integration have local regression
coverage. The source scanner compares known local/optional credential values,
recognized patterns, allowlisted paths, notices and source/export hashes without
printing credentials. The scan covers those values, patterns and files; independent security review,
history and ancillary public material have separate checks.

The supplied CI config includes the Node 22/24 operating-system matrix and
Playwright on Ubuntu/Node 24. Actual hosted results must be inspected after the
reviewed source is placed in the intended repository. Isolated natural Cron,
synthetic MIME delivery and actual D1 export/recovery were exercised, and temporary
resources from the earlier validation were removed. Both legacy and staged Free
CPU candidates have over-budget samples. A valid synthetic 24 MiB PDF became
ready, but its mail run encountered `exceededCpu`; end-to-end delivery acceptance failed at that stage. The final local source also lacks a complete new remote
CPU run. Production activation and a capacity increase remain pending, and stable
Free operation is unaccepted until the per-stage gate passes.
The November 1 continuous-observation attempt was interrupted by a local shutdown;
a fresh window awaits restoration of existing cloud authentication.
Genuine mail replies, production configuration
and account MFA require separate evidence.

## Licensing and boundaries

Code remains GPL-3.0-or-later with the grant in [COPYRIGHT](../COPYRIGHT.md) and
complete text in [LICENSE](../LICENSE). OFL font licenses remain separate and
unchanged. Development tools and Playwright browser binaries are not included in
the source ZIP; the dependency inventory is derived from the lockfile.

Ordinary letters use encryption at rest; the server can decrypt for delivery.
Browser/deployment/mail-account compromise remains within the trust boundary.
Passphrase letters need a separate delivery plan. Delivered attachments cannot be
recalled; verify inbox arrival in a separate delivery check. The compatibility
editor retains Chinese labels, and body text stays in its original language.

Publish only the clean source tree/ZIP with SHA256SUMS. Do not expose a private
deployment checkout or history. Publication and repository security settings are
separate maintainer actions described in [RELEASING](RELEASING.md).
