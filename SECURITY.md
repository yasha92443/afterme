# Security Notes

## Reporting a vulnerability

Use **Security → Report a vulnerability** in the intended public source repository
when its private reporting channel is enabled. If unavailable, request a private
channel without publishing exploit details, tokens, live URLs or personal data.
Do not contact a personal deployment's owner or verification contacts.

Include the affected version, a minimal synthetic reproduction and impact. Do not
probe production instances. No response-time guarantee or bounty is offered. The
0.1.x source line is maintained; publication and repository settings are separate
maintainer actions.

## Trust boundary

AfterMe is a single-owner self-hosted application. The owner controls the browser,
deployment account, D1, content key and mail accounts. Ordinary private letters and
PDF chunks are encrypted at rest; the Worker holds the content key and decrypts
them for delivery. Passphrase letters require a separate delivery arrangement.
Sent attachments cannot be recalled.

Local automated and adversarial tests cover the recorded scenarios. Independent
security review, production delivery, account MFA and Cloudflare Free CPU
acceptance each have their own verification steps. See
[readiness evidence](docs/OPEN_SOURCE_READINESS.md).

## Current controls: schema 24

- Administrative setup and APIs require the owner credential or a revocable
  30-minute session. Cookies are HttpOnly, Secure on HTTPS and SameSite=Strict;
  browser writes require origin/CSRF checks. Lowering quorum/buffer or exporting
  complete recovery data requires verification within five minutes.
- Optional TOTP MFA protects session issuance and compatibility entrypoints.
  TOTP/recovery codes are consumed atomically; enrollment changes revoke sessions.
  Enrollment and provider-account MFA remain the owner's responsibility.
- Web confirmation requires both a current link and an eight-digit email code.
  Proofs bind the contact, token and round, expire after ten minutes and allow five
  attempts. The three-per-contact/five-minute limit and global code budget are
  claimed together in D1.
- Gmail replies require the trusted authentication result, expected sender,
  current round/thread/token, an explicit first-line command and replay checks.
  Current unresolved inbox failures/backlogs block release; historical failures
  stay available for diagnosis while current-round state controls release. Reconciliation is authenticated and audited.
- Private/public release rules are frozen per round and advance independently.
  Check-in, accepted false alarm and travel pause cancel the relevant round.
  Database/configuration suspension closes release and access as documented.
- Mail claims enforce global quotas and content/recipient deduplication. Source,
  recipient and eligibility are rechecked before submission. Definite pre-submit
  cancellation may retry; uncertain submission requires human reconciliation.
- Five native rate-limit bindings protect login/MFA, verification, expensive
  operations, ordinary APIs and public/private reads including operational health.
  Missing bindings fail closed. The bounded in-memory fallback requires explicit
  `ALLOW_LOCAL_RATE_LIMIT_FALLBACK=true` for local development, never production.
- Request bodies are byte-limited. HTML uses escaping, nonce-based script policy,
  no-referrer, frame protection, no-store and MIME-sniffing protection. Private
  bodies load on demand; public health uses a coarse persisted snapshot.
- Document revisions reject stale apply/discard/save operations. Browser-prepared
  PDF chunks are bound to the saved source/layout, checked for length/digests and
  completed atomically. Private chunks are encrypted; the legacy default limit is
  8 MiB per PDF. Set staged capacity through acceptance against the deployment’s
  actual providers and quotas.
- Each invocation has conservative D1/statement/external-operation budgets.
  Unfinished work resumes through bounded polls and delivery state. These limits
  reduce resource amplification; measure remote CPU and quota headroom in an isolated deployment.

## Recovery and key changes

Complete exports use canonical recovery format 2 and schema 24 with one copy of
restoration tables. New whole-backup encryption uses PBKDF2-SHA256 (600,000
iterations), random salt and AES-256-GCM chunks. Authenticated headers and indices
bind count, size and ordering. Encryption is incremental in 1 MiB plaintext chunks;
the canonical JSON and encrypted result still occupy browser/CLI memory. The
plaintext limit is 256 MiB. Old version-one envelopes remain readable.

HTTP complete exports use an approximately 16 MiB data preflight to reduce Worker
memory pressure. Preflight and snapshot are separate reads; the complete JSON
occupies memory. Larger instances use a protected D1 export and the
offline `backup:from-d1` converter. It accepts read-only SQLite schemas 16–24 or
literal D1 SQL dumps for those schemas; dump SQL is parsed as data, never executed.

Offline recovery accepts schemas 16–24, checks required tables/singletons, rules,
references, ciphertext and PDF integrity, and runs application smoke checks. It
creates a new database, suspends release, invalidates links and omits sessions.
Schemas 23–24 require complete one-to-one people links with matching normalized
addresses; legacy verifier identity is retained and interrupted write markers are
cleared on recovery. Older snapshots rebuild links after the original data loads.
Schema 24 recovery discards derived background jobs, leases and remote upload
sessions while retaining canonical sending and uncertain-delivery receipts.
Verify the offsite copy and Cloudflare restoration through separate recovery exercises. Retain content keys and backup passphrases
separately; recovery-code hashes also depend on the original admin secret.

Content-key rotation is a paginated authenticated operation covering letters,
legacy PDF payloads, active/pending MFA secrets, private PDF chunks, encrypted
background jobs and authenticated manifests. Retain the legacy key until all four
independent cursors finish with no conflicts and a fresh backup passes
recovery checks. Follow [operations](docs/OPERATIONS.md); do not change production
secrets as a source-release preparation step.

Never commit credentials, OAuth output, private data, backups or deployment
configuration. The release scanner covers known local/optional private values and recognized
patterns. Publish the clean export, and separately review additional private
values, history, repository settings and ancillary public material.
