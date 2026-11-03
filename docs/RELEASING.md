# Preparing and publishing a source release

## Preparation

```sh
npm ci
npm test
npm run rehearsal:release-flow
npm run build
npm run check:browser-build
npm run build:durable
npm run check:browser-build:durable
npx playwright install chromium
npm run test:browser
npm run release:check
npm audit
npm run release:prepare
```

Run the browser suite a second time with `AFTERME_TEST_RUNTIME=durable-object`
in the environment, then clear that variable. Both suites use the synthetic localhost fixture and its local test credentials. Check that rebuilt `assets/browser` files match the committed bytes.

`release:prepare` copies an explicit file allowlist into a new directory under
`output/`, scans the copied tree, creates a source-only ZIP and records SHA-256
hashes. It refuses to overwrite an existing output. Deployment, source push and publication are separate maintainer steps. Inspect the resulting manifest
and archive before publishing. The license and version must match the approved
release; retain the font OFL and third-party notices.

The scanner checks known local admin/content/OAuth values, recognized credential
patterns, private paths and the allowlist. Optional extra values may be supplied
through `AFTERME_RELEASE_PRIVATE_VALUES_FILE` (a protected JSON array/object) or
the `AFTERME_RELEASE_PRIVATE_VALUES` JSON environment variable. Do not put real
values in command arguments or commit the input file. The same in-memory deny set
is applied to the original and normalized export. Findings record paths and rules. Review additional private values and material
outside the scanner’s recognized coverage separately.

## Separate private operations from public source

Publish only the generated clean source tree or ZIP. Do not publish the entire
working directory, and do not change an existing personal/deployment repository
to public. Tracked files and old commits remain part of their existing Git history; review
and publish the clean export in a new source checkout. Keep personal history, production configuration, credentials, backups and
operational evidence in the private deployment workspace.

When a deployment repository has personal history, initialize a new source
repository from the clean export. The approved publication account, public
author name and project copyright holder are **yasha92443**; the copyright year
is **2026**. The source repository is
**[yasha92443/afterme](https://github.com/yasha92443/afterme)**.

Before committing, verify that account's actual GitHub noreply email in its
email settings. This address was verified for the initial November 3 publication.
Use the address shown in settings for later checkouts as well. Configure the verified
identity only in the new source checkout, leaving global Git identity unchanged.
Start the new source checkout with the clean export. Keep the old `.git`,
branches, tags, issues, wiki, releases and CI artifacts in the private deployment
workspace; scan any material selected for retention separately.

In the intended public checkout, run `npm run release:check -- --tracked` to
reject any tracked file outside the release allowlist. The supplied CI runs
this check. It intentionally fails on a private deployment checkout that still
tracks production configuration or historical personal reports.

If a live credential has been exposed, revoke/rotate it at its provider before
publication, then remove the exposed material. Content-key rotation requires a separately tested data migration;
do not change that key casually on an existing encrypted database. The paginated
rotation now includes MFA, private PDF chunks, encrypted jobs and authenticated
manifests; all four independent cursors and an independent
recovery check must complete before removing a legacy key.

## Publication (maintainer action)

After explicit approval to publish, create/use the intended public source
repository, commit the reviewed clean tree, and run CI there. Assign the release
tag and publish the reviewed ZIP plus its checksum. Record the resulting online repository, CI run and release as publication evidence.

Enable private vulnerability reporting and push protection, review dependency
alerts, protect the default branch and require CI. Use minimal workflow
permissions and keep deployment credentials out of public CI. The provided
workflow supplies unit checks and both Worker/Durable Object builds for
Windows/macOS/Linux and Node 22/24, with both Playwright profiles on Ubuntu/Node 24;
actual hosted results must be
checked after it runs. Until a private reporting channel is enabled, SECURITY.md
directs reporters to request one without sharing sensitive details publicly.

GitHub scans public-repository history and supports private reporting:
[secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning),
[private reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository).

## Release evidence

Record test/build/audit results, schema compatibility, artifact SHA-256,
synthetic UI/PDF checks and known limitations in the release notes. Do not
include production counts, check-in timestamps, personal emails or database
IDs. CI uploads source artifacts only after validation and never uploads secrets
or private backups. Re-run preparation if any source or dependency changes.

The candidate uses schema 24, strict offline recovery for schemas 16–24, canonical
recovery format 2 and encrypted chunk-envelope format 2 with legacy envelope
support. Record browser PDF preparation and resumed upload, ready-artifact
delivery, invocation-budget behavior, legacy five-minute or staged minute scheduling and missing-binding
failure checks. Keep `nodejs_compat` and all required static build artifacts.

HTTP full-backup memory preflight is separate from the offline 256 MiB canonical
format limit. Validate the larger-instance D1/SQLite offline conversion path as
well as browser export. Both paths hold the complete canonical recovery data in memory.

Before treating the system as operational, separately verify an isolated remote
deployment's CPU/subrequest behavior, provider quotas, actual natural Cron and
mail/confirmation round trip. Use the platform’s CPU samples and full attachment workload for Free CPU acceptance. Staged execution
requires the [per-stage CPU gate](BACKGROUND_EXECUTION.md). See
[readiness evidence](OPEN_SOURCE_READINESS.md) for the current distinction between
local checks and outstanding external work.
