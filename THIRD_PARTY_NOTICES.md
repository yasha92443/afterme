# Third-party notices

The project code is licensed under the root LICENSE. The font data below
retains its separate license; the project license does not replace it.

## AfterMe PDF Serif

`src/pdf-serif-font-data.js` contains a renamed, regular-weight subset of
Noto Serif SC. Copyright 2017–2023 Adobe. Licensed under the SIL Open Font
License 1.1, reproduced in `third_party/NotoSerifSC-OFL.txt`.

The subset includes Latin, Greek, Cyrillic and punctuation. The subset was
renamed **AfterMe PDF Serif**, instantiated at weight 400 and generated with
`scripts/build-pdf-serif-font.py`. Retain the OFL text and this notice when
redistributing the generated font module. Modifications to this font remain
under OFL. Documents produced using the font are not required to use OFL.

## AfterMe PDF Song SC

`assets/fonts/afterme-song-sc.ttf` is a renamed, static weight-400 subset of
**Noto Serif SC**, the Simplified Chinese regional design. It keeps upstream
BMP coverage and is licensed under the same OFL text above. Provenance,
source/asset SHA-256 digests and character counts are recorded in
`third_party/pdf-chinese-font.json`. Regenerate it with
`scripts/build-pdf-chinese-font.py --source NotoSerifSC.ttf`.

The asset is deployed with the Worker's static assets. Browser PDF preparation
reads the bundled asset; the legacy server path uses `PDF_FONTS`. Both build a
smaller embedded TrueType font containing the
document's glyphs and required composite components. The embedded font retains
copyright/license metadata. No document text is sent to a font provider.

Upstream: <https://github.com/notofonts/noto-cjk/tree/main/Serif>
License FAQ: <https://openfontlicense.org/ofl-faq/>

## Development dependencies

Wrangler, esbuild, Playwright and their dependencies are development/deployment
or test tools installed by
`npm ci`; `node_modules` is not part of the source release. Their licenses
remain applicable to those tools. A generated version/license inventory is
in `third_party/dependency-licenses.json`, derived from `package-lock.json`.
It is an inventory, not a substitute for upstream license texts. Development
dependencies include permissive licenses and LGPL-covered native tooling;
redistributing their binaries requires reviewing and preserving their own
license obligations. Browser assets are built with esbuild; Playwright's browser
downloads are test-only and are not part of the source ZIP. The Worker imports
no npm runtime dependencies; its Node Buffer use requires `nodejs_compat`.

Optional font regeneration requires fontTools (MIT), installed separately.
Normal development and deployment use the included generated font assets and
require no Python packages.
