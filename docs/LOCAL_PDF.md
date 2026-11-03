# Local PDF: SimSun and Times New Roman

The local tool embeds **SimSun (宋体)** for Chinese characters and full-width
Chinese punctuation, and **Times New Roman** for Western letters, digits,
Greek and Cyrillic. It uses each font's actual glyph widths for line wrapping.
It preserves explicit line breaks, epigraph attribution and the selected
night/paper style. The tool reports unsupported characters so you can resolve them before exporting.

The local and browser tools share the same layout rules: public update dates go
in a version-information appendix after all chapters, and a private letter's
saved date appears in a small note at the end. Run the updated local tool to
regenerate older files; each export creates a separate local file.

## Generate from the management page

1. In **Public farewell**, apply changes to the formal version, then choose
   **导出本机 PDF 源文件**. For a private letter, open the saved letter and
   choose **Export local PDF source**.
2. On your licensed Windows computer, install Node.js and Python, then install
   the optional local dependency: `python -m pip install fonttools==4.61.1`.
3. From the project directory, run:

   ```sh
   npm run pdf:local -- --input afterme-public-pdf-source.json --output output/pdf/public-farewell.pdf
   ```

   Adjust `--input` to the actual downloaded source path. The tool refuses to
   overwrite an existing PDF; choose a new output name for a new revision.

The JSON source contains readable letter text. Store it as carefully as the
PDF. The local tool reads the source and writes a PDF on your computer. Font subsets are
created temporarily for the document and removed after generation.

## Read the current saved content directly

Instead of downloading JSON, use an authenticated source API:

This compatibility API returns the full source in one request. For a large
public farewell, use the management page’s paged JSON download and the `--input`
workflow above. That route keeps full-source processing on your computer.

```sh
npm run pdf:local -- --source-url https://afterme.your-subdomain.workers.dev/api/public-farewell/pdf-source --admin-file .admin-session.local --output output/pdf/public-farewell.pdf
```

For a private letter, use `/api/items/1/pdf-source`, replacing `1` with its ID.
The credential file contains a current management session token. When MFA is
disabled, the existing admin token also works. Expired or revoked sessions are
rejected. Never put a credential in the URL or command line. Redirects are
rejected so the credential cannot be forwarded to another host.

The public source contains only the saved formal version; the private source
contains only the saved letter. Save your edits before exporting.
Passphrase-only legacy letters cannot be exported this way.

## Font files and Python

The default Windows fonts are `%WINDIR%/Fonts/simsun.ttc` and
`%WINDIR%/Fonts/times.ttf`. `--simsun`, `--times` and `--python` accept explicit
paths when they are installed elsewhere. A different operating system needs
its own legitimately licensed copies of these exact fonts. An absent font,
incorrect font family or incompatible embedding permission stops generation.

An optional ignored `.pdf-local.local.json` can specify `python` (executable
path) and `pythonPackages` (directory for locally installed Python packages).
This machine-specific configuration is excluded from the source release.

The font files are not bundled with this repository or its source release.
Windows document embedding rights do not grant application redistribution or
copying to a cloud server. See Microsoft's
[font redistribution FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq).

## Browser-prepared PDF and email

The default management browser prepares PDF preview and automatic email artifacts
with a Simplified Chinese Noto Serif SC subset and the existing Western serif font.
Cloudflare validates and stores those artifacts for later delivery. Text saving
and PDF readiness are separate states; see [PDF preparation](PDF_ATTACHMENTS.md).
The local PDF remains a separate file on your computer. Automatic delivery uses
the browser-prepared artifacts stored in the deployment. Cloud generation using these exact fonts requires a separate
authorization covering server use.
