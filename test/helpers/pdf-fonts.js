// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {readFileSync} from 'node:fs';
import {parseFont} from '../../src/pdf-chinese-font.js';
import {buildPrivateLetterPdf as privatePdf,buildPublicFarewellPdf as publicPdf} from '../../src/pdf.js';
export * from '../../src/pdf.js';
const bytes=new Uint8Array(readFileSync(new URL('../../assets/fonts/afterme-song-sc.ttf',import.meta.url)));
export const testChineseFont=parseFont(bytes);
export const testFontAssets={async fetch(){return new Response(bytes);}};
export const buildPrivateLetterPdf=options=>privatePdf({chineseFont:testChineseFont,...options});
export const buildPublicFarewellPdf=options=>publicPdf({chineseFont:testChineseFont,...options});
