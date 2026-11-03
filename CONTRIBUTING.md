# Contributing

Each owner deploys AfterMe in their own accounts and manages their own data. Start with [README](README.md),
[architecture](docs/ARCHITECTURE.md) and [settings](docs/SETTINGS_V18.md).

## Local development

Use Node.js 24 LTS (Node.js 22.19+ is also supported) and npm:

```sh
npm ci
npm test
npm run build
npm run check:browser-build
npm run build:durable
npm run check:browser-build:durable
npm run release:check
```

Tests use synthetic data and an in-memory SQLite database. `npm run build`
generates a dry-run bundle using the example configuration. For interactive local
development, follow `docs/DEPLOYMENT.md`, use separate local keys and keep
MAIL_PROVIDER=dry-run. Use local test credentials for contributor workflows.

The build creates the browser PDF client/worker assets. Keep `nodejs_compat`,
`PDF_FONTS` and the five native rate-limit bindings. Tests that omit native
bindings must explicitly opt into the development-only fallback; requests and
hostnames cannot enable it. Do not enable that fallback in a deployable config.

For browser regressions, install Playwright Chromium with
`npx playwright install chromium`, then run `npm run test:browser`. Use the
isolated synthetic fixture. Run it again with `AFTERME_TEST_RUNTIME=durable-object`
in the environment to cover the Durable Object entrypoint. CI configures both
browser profiles on Ubuntu/Node 24 in
addition to the unit/build matrix; record the hosted run’s actual results when they become available.

Do not connect a test to real recipients, invoke remote migrations or
publish a Worker as part of CI. Never include private letters, backups,
screenshots with personal data, OAuth output, admin/content keys, or real
deployment config in a pull request. Use `example.invalid` addresses except
synthetic Gmail addresses in provider parsing tests; those tests do not send.

## Changes and reviews

Keep changes focused. Explain the user-visible behavior and relevant
validation in your pull request. Add meaningful regression coverage when
changing release rules, authentication, mail deduplication, encryption,
migrations or concurrency. Maintain zh/en/ru catalog entries together.
Changes to PDF rendering should include a visual check using synthetic text.

Preserve the distinction between saved text and a ready prepared PDF. Browser
generation/upload failures must preserve saved text; delivery must use the
validated current content version. Test source/layout changes, chunk integrity, interrupted
preparation and one failing item alongside a deliverable item. Keep the current
4 MiB public PDF source and 8 MiB artifact bounds explicit and tested.

Migrations are append-only. Preserve existing owner check-ins, content,
delivery claims and ciphertext. Test upgrades and backup recovery for
schemas 16–24 and encrypted envelope formats 1/2 before changing the data format.
Validate mandatory tables, application reads and SQLite integrity together.
The offline D1 converter must never execute dump SQL; accept only supported
literal INSERT data and reject expressions or unsupported statements. Preserve
read-only SQLite input and test malicious ATTACH data without filesystem effects.
Do not silently replace
an encryption key. Keep release rules frozen for an active round and reject
stale revision writes.

Resource-heavy work must use the invocation budget and durable progress. Count
both D1 calls/round trips and SQL statements; preserve cursor position when a
budget defers work, and distinguish this from an uncertain provider submission.
Validate remote Cloudflare CPU capacity with the deployment’s isolated acceptance run.

Before preparing a release, run `npm run release:prepare` and review
`docs/RELEASING.md`. Report security problems privately as described in
`SECURITY.md`; never put credentials or exploit links in a public issue.

Contributions are submitted under the project's license. Font changes retain
OFL and the third-party notices. AI-assisted contributions follow the same
review and testing requirements, including inspection of generated code.
