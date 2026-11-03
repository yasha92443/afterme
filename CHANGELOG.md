# Changelog

## Schema 24 — staged background execution

- Optional minute-Cron stages, encrypted resumable jobs, guarded provider receipts
  and authenticated PDF chunk manifests. Activation requires the isolated CPU gate.
- Lossless browser PDF compression, paginated public source and separately tested
  artifact capacity; the legacy default remains 8 MiB.
- Complete recovery accepts schemas 16–24, drops derived jobs/upload sessions and
  resets incomplete validation. Key rotation includes jobs and authenticated manifests.

## Schema 23 — unified people directory

- One directory for verifiers and letter recipients with explicit mail language;
  original identities, profile differences, frozen rules and receipts are retained.
- Complete recovery includes one-to-one people links and their legacy verifier
  marker. Offline conversion/restoration accepts schemas 16–23; older snapshots
  rebuild links and retain the original fields. Interrupted edit markers clear
  on recovery, and invalid/missing mappings are rejected.

## Schema 22 — pre-release audit remediation

- Bounded five-minute scheduled work, shared database/statement/external budgets,
  durable progress, current-round inbox reconciliation and content/recipient mail
  claims. Resource deferral remains distinct from uncertain provider submission.
- Browser background PDF preparation and verified encrypted private chunks.
  Text saves succeed independently; interrupted preparation can resume after
  authentication. Public PDF source is bounded to 4 MiB and artifacts to 8 MiB.
- Document-wide apply/discard guards, paginated public/recycle reads, one-row
  operational snapshots, batched dashboard reads and database round-trip telemetry.
- Atomic contact/global verification-code limits, public read/health limits,
  missing-binding failure, explicit local fallback and five-binding setup checks.
- Paginated content-key rotation includes MFA active/pending secrets and private
  PDF chunks as well as ordinary letters and legacy PDFs.
- Canonical complete recovery format 2, chunk-authenticated whole-backup encryption
  format 2 with legacy reading, and strict schema 16–22 restoration with application
  smoke checks. Full JSON and encrypted output still occupy memory.
- Actual release CLI/export checks now share known local/optional private values;
  quoted credential assignments produce path-and-rule findings.
- The loopback OAuth listener continues authorization after unrelated requests. OAuth
  outputs use restrictive file permissions where the host supports them.
- Playwright/browser build assets and CI coverage configuration. Remote CPU,
  real mail, hosted CI and account MFA remain separately verifiable deployment
  gates; see [readiness evidence](docs/OPEN_SOURCE_READINESS.md).

## Consistent interface themes

- Shared editor controls, instructions, warnings and maintenance output now use
  the dashboard theme colors, fixing dark text on dark secondary buttons in the
  paper theme. Disabled controls remain readable and visibly unavailable.
- Public reading follows the system color preference when selected; high
  contrast controls and manual theme switching use complete color palettes.
- Browser checks cover all management sections, editor panels, private letters,
  dialogs and external pages, including narrow screens, enlarged text, keyboard
  focus and preservation of input across theme and language changes.

## 0.1.0 — initial source-release candidate

- Independent Cloudflare Worker and D1 deployments; schema 24 in this candidate.
- Configurable check-in reminders, private/public confirmation rules and
  release buffers; changes activate at the next actual owner check-in.
- Frozen per-round rules, independent release channels and travel pause.
- Chinese, English and Russian main UI, mail and PDF labels; three themes.
- Revocable browser sessions, CSRF, recent-password verification, rate limits
  and independent encryption keys with explicit legacy compatibility.
- Lazy private-body loading, cursor pagination, persistent PDF batch jobs,
  bounded inbox processing and atomic global mail quotas.
- Gmail and Resend sending with explicit Gmail/web verification paths.
- Guided setup, offline backup verification and recovery for schemas 16–24.
- Synthetic regression tests and a source-only release preparation pipeline.
- GPL-3.0-or-later licensing, retained OFL font notices, synthetic demo images
  and development-tool dependency updates.
- Language switching refreshes status and timestamp formatting while preserving
  unsaved form inputs.
- The deployable bundle supplies self-contained browser scripts; CI checks HTML rendered by the actual bundle.
- Management navigation, mail-template binding/reset, hour/day conversion,
  person/letter directory refresh, preview windows and unsaved travel inputs
  have browser regression coverage, including expired sessions and conflicts.

This is a source-release candidate. Publication date, tag and hosted source
URL are assigned only when the maintainer publishes the approved artifact.

## Schema 19 security and integrated editor

- Integrated the full chapter editor into the new dashboard, ordered by saved draft order, with pagination, autosave, preview, reorder, recycle and application review.
- Optional authenticator MFA with single-use recovery codes, session revocation and protection of compatibility login paths.
- Email proof for web verification, bounded codes, round checks and confirmation notifications.
- Broader native rate limits, sampled security events and best-effort service alerts.
- Browser-encrypted whole backups and offline schema 16/17/18/19 recovery.
- See SECURITY_V19.md for enrollment requirements and remaining operational boundaries.

## Navigation responsiveness

- Chapter editing loads the selected chapter and its directory in one request,
  using a single database read batch for a consistent editor snapshot.
- Letter lists load independently of contacts; maintenance requests run together.
- Navigation responds immediately, shows loading/retry states and shares pending
  requests. The latest selection and input remain authoritative when older responses arrive.
- Reused date formatters and unchanged-label checks reduce browser work.
- Regression coverage includes directory/entry pagination, slow networks,
  out-of-order responses, unsaved input and mobile keyboard navigation.

## Continuous public reading

- Public pages and formal HTML previews keep update timestamps together in one
  collapsed version-information section after the text, translated into all
  three interface languages. Printing hides this section even when expanded.
- Public paragraphs and editor reading previews use consistent paragraph spacing; editing fields retain their timestamps.
- Reader buttons remain legible in the paper theme.
- Public PDFs put all version timestamps in a final appendix; private PDFs move
  their saved date to a quiet endnote. Both cloud and local generation use the
  same reading layout, preserving paragraph and epigraph line breaks.
- A new PDF layout version refreshes existing caches while retaining saved
  content, editing revisions, release rules and delivery receipts.

## Embedded Simplified Chinese PDF typography

- Cloud previews and email PDFs embed document-specific Noto Serif SC glyphs;
  Chinese text uses the document’s embedded glyphs.
- Static font assets are loaded only during generation. Binary font streams
  keep PDFs compact; oversized derivatives bypass the D1 cache safely.
- Local SimSun/Times New Roman generation retains its exact font selection.
- Font provenance, OFL notices, reproducible generation and release checks
  cover the deployed font asset.
- Private PDFs begin directly with the saved letter. Closing version information is retained.
