# PDF preparation and attachments

PDF delivery uses the saved private letter or committed public farewell. Apply drafts and save edits, then prepare the matching current document.

## Saved text and ready PDF are separate states

The example uses `PDF_GENERATION_MODE=browser`. A successful save/apply commits text
first, then the authenticated management browser prepares its PDF in a background
Worker. It reads the saved source and bundled fonts, renders away from the main UI,
and uploads 128 KiB chunks. The server checks the source/layout version, each
chunk's length/digest and PDF structure before marking it ready. Staged mode
authenticates an ordered chunk manifest in independent background steps.
Private PDF chunks are encrypted with the content key.

Keep management open until the needed artifacts are ready. Closing the page,
logging out, losing connectivity or an expired session can interrupt preparation.
Saved text remains safe; reopening management and signing in resumes missing
preparation, and letters have a retry action. A later edit can make an in-flight
upload stale; prepare the new saved revision. Layout, language and recipient
changes can also require a new artifact.

Legacy mode preflights the public formal source at 4 MiB and defaults to 8 MiB
per artifact. Schema 24 staged mode reads the public source in version-bound
pages and exposes an operator-configured `PDF_MAX_BYTES` capacity above 8 MiB. Its effective
delivery capacity must satisfy measured CPU results and the provider's exact
MIME wire limit. Capacity above 8 MiB awaits the complete Free CPU and delivery
acceptance gate for this candidate. Oversized or unsupported-glyph text remains saved; automatic
delivery requires a successful preparation. See [background execution](BACKGROUND_EXECUTION.md)
for integrity, upload recovery and acceptance requirements.

## Preview and delivery

- Private letters are prepared for their recipient language. Public PDF audiences
  and verifiers are configured separately; public web/PDF channels are independent.
- Formal public PDF preview uses the committed version; apply drafts first.
  Private preview uses the saved letter. Preview is an authenticated inspection of the saved document. A pending artifact returns a preparation
  status rather than rendering a large document inside that request.
- The main dashboard preview reads a metadata descriptor, downloads authenticated
  chunks pinned to one upload revision and manifest, and assembles the PDF in the
  browser. It rechecks the current source and layout after all bytes arrive;
  the preview opens after all chunks and the current revision pass validation. The browser
  still needs memory for the complete PDF. Requests share the upload rate budget,
  so a large preview can take time.
- Public reading, preview and draft/recycle data are paginated. Large workspaces
  load the selected chapters as the editor needs them.
- Delivery reads a current validated artifact. Missing, corrupt or stale PDFs defer
  that item and surface a maintenance problem; another item can continue later.
  Browser mode resumes preparation in an authenticated browser session.
- Mail content/recipient claims prevent duplicate sends when only PDF typography
  changes. Actual content or recipient changes are tracked separately. Uncertain
  provider submissions still require human reconciliation.
- Passphrase-only letters require a separate delivery plan because the server
  cannot render their plaintext. Previously delivered files cannot be recalled.

Legacy server generation/cache compatibility is retained for deployments that
explicitly choose it. Accept that path against the deployment’s Free CPU budget
before use. After migration or layout changes, open management and complete
artifact preparation.

The main dashboard's local PDF source download reads version-bound public pages.
Legacy `/api/items/:id/pdf`, `/api/public-farewell/pdf` and `pdf-source` endpoints
remain compatible bulk operations. The local CLI's `--source-url` uses that bulk
source path, whose large-source CPU acceptance remains a separate deployment task. For a large public
document, download source JSON in management and use the CLI's `--input` option.

## Typography and local files

Chinese, English and Russian labels are supported; body text stays in its original language.
Night and paper PDF styles are independent of the dashboard theme. Public version
metadata appears in an end appendix; a private saved-date note follows its body.

Browser-generated documents embed document-specific Noto Serif SC and Western
serif subsets from the bundled OFL font assets. The browser reads these local
assets and renders the document on the owner’s device. Deployment retains
`PDF_FONTS`, Worker-first routing and `nodejs_compat`; generated browser assets must
be built before development/deployment. See [font notices](../THIRD_PARTY_NOTICES.md).

For exact SimSun/Times New Roman typography use the [local PDF tool](LOCAL_PDF.md).
Its output stays in a separate local file; automatic delivery uses prepared
server artifacts. Font licenses and local source JSON require the operator's care.
