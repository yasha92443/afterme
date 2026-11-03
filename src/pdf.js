// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { parseEpigraph } from "./epigraph.js";
import { t,formatTime } from './i18n.js';
import { subsetChineseFont } from './pdf-chinese-font.js';
import {
  PDF_SERIF_ADVANCES,
  PDF_SERIF_CODEPOINTS,
  PDF_SERIF_FONT_BASE64,
  PDF_SERIF_FONT_META,
  PDF_SERIF_GLYPH_IDS,
} from "./pdf-serif-font-data.js";

const PAGE = { width: 595, height: 842, margin: 54 };
const SERIF_GLYPH_IDS = new Map(PDF_SERIF_CODEPOINTS.map((point, index) => [point, PDF_SERIF_GLYPH_IDS[index]]));
const SERIF_ADVANCES = new Map(PDF_SERIF_CODEPOINTS.map((point, index) => [point, PDF_SERIF_ADVANCES[index]]));
const FORBIDDEN_LINE_START = new Set("，。、；：？！）》】〕〉」』”’…—,.!?;:%)]}>");
const FORBIDDEN_LINE_END = new Set("（《【〔〈「『“‘([{<");

export function buildPublicFarewellPdf(options={}) {
  return serializePdf(publicPdfDocument(options));
}

export async function buildPublicFarewellPdfAsync(options={}) {
  return compressPdfDocument(publicPdfDocument(options));
}

function publicPdfDocument({ ownerName = "本人", groups = [], updatedAt,locale='zh',timezone='Asia/Shanghai',style='night',fontPair,chineseFont }) {
  const blocks = [
    { text: t(locale,'publicTitle'), size: 26, leading: 36, gap: 8 },
    { text: ownerName, size: 12, leading: 20, gap: 18 },
  ];
  groups.forEach((group, index) => {
    blocks.push({ text: `${String(index + 1).padStart(2, "0")}  ${group.display_title}`, size: 17, leading: 25, gapBefore: 14, gap: 12, keepWithNext: true });
    if (String(group.display_epigraph || "").trim()) {
      const epigraph = parseEpigraph(group.display_epigraph);
      if (epigraph.quote) blocks.push({ text: epigraph.quote, size: 10, leading: 18, muted: true, indent: 38, gap: epigraph.source ? 4 : 14 });
      if (epigraph.source) blocks.push({ text: epigraph.source, size: 10, leading: 18, muted: true, indent: 38, align: "right", ruleBefore: true, gap: 14 });
    }
    group.entries.forEach((entry) => {
      blocks.push({ text: entry.display_body, size: 11, leading: 20, gap: 14,split:true });
    });
  });
  if (!groups.length) blocks.push({ text: t(locale,'empty'), size: 11, leading: 20 });
  blocks.push(...publicVersionBlocks({groups,updatedAt,locale,timezone}));
  return createPdfDocument(blocks, { footer: 'AfterMe · '+t(locale,'publicTitle'),style,fontPair,chineseFont });
}

export function buildPrivateLetterPdf(options={}) {
  return serializePdf(privatePdfDocument(options));
}

export async function buildPrivateLetterPdfAsync(options={}) {
  return compressPdfDocument(privatePdfDocument(options));
}

function privatePdfDocument({ ownerName = "本人", recipientName = "收件人", body, updatedAt,locale='zh',timezone='Asia/Shanghai',style='night',fontPair,chineseFont }) {
  const blocks = [
    { text: String(body || ""), size: 12, leading: 22, gap: 8,split:true,keepTailWithNext:updatedAt?2:0 },
  ];
  if (updatedAt) blocks.push(
    { text: t(locale,'versionInfo'), size: 10, leading: 16, muted: true, gapBefore: 24, gap: 4, keepWithNext: true },
    versionDateBlock(t(locale,'savedAt'),updatedAt,locale,timezone),
  );
  return createPdfDocument(blocks, { footer: `AfterMe · ${ownerName} · ${t(locale,'privateTitle')}`,style,fontPair,chineseFont });
}

function versionDateBlock(label,value,locale,timezone,formatter) {
  return { text: `${label}${locale==='zh'?'：':': '}${formatter?formatter.format(new Date(value)):formatTime(value,locale,timezone)}`, size: 8, leading: 14, muted: true, gap: 3 };
}

// Keep all update dates after the complete text, in the same chapter/entry order.
// A public appendix starts on a fresh page; a private letter needs only a small endnote.
function publicVersionBlocks({groups,updatedAt,locale,timezone}) {
  const blocks = [];
  const formatter=new Intl.DateTimeFormat(locale,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'});
  const row=(label,value)=>versionDateBlock(label,value,locale,timezone,formatter);
  if (updatedAt) blocks.push(row(t(locale,'publicUpdated'),updatedAt));
  groups.forEach((group,index) => {
    const rows = [];
    if (group.title_updated_at) rows.push(row(t(locale,'chapterUpdated'),group.title_updated_at));
    if (String(group.display_epigraph||'').trim() && group.epigraph_updated_at) rows.push(row(t(locale,'epigraphUpdated'),group.epigraph_updated_at));
    group.entries.forEach((entry,entryIndex) => {
      if (entry.body_updated_at) rows.push(row(`${t(locale,'entryNumber',{number:entryIndex+1})} · ${t(locale,'entryUpdated')}`,entry.body_updated_at));
    });
    if (rows.length) blocks.push(
      { text: `${String(index+1).padStart(2,'0')}  ${group.display_title}`, size: 11, leading: 18, muted: true, gapBefore: 12, gap: 5, keepWithNext: true },
      ...rows.map(row=>({...row,indent:12})),
    );
  });
  return blocks.length ? [
    { text: t(locale,'versionInfo'), size: 16, leading: 24, muted: true, gap: 12, pageBreakBefore: true, keepWithNext: true },
    ...blocks,
  ] : [];
}

export function bytesToBase64(bytes) {
  const chunks=[];
  for(let i=0;i<bytes.length;i+=32768)chunks.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  return btoa(chunks.join(''));
}

export function base64ToBytes(value) {
  return Uint8Array.from(atob(String(value || "")), (char) => char.charCodeAt(0));
}

function createPdfDocument(blocks, { footer,style='night',fontPair,chineseFont }) {
  if(!fontPair&&!chineseFont)throw new Error('An embedded PDF Chinese font is required');
  const fonts=fontPair?prepareFontPair(fontPair):prepareCloudFonts(chineseFont,blocks.map(block=>block.text).join('\n')+'\n'+footer);
  const pages = layoutBlocks(blocks,fonts);
  const objects = [];
  const add = (value) => { objects.push(value); return objects.length; };
  const addStream = (bytes,extraDictionary='',runLength=false) => add({bytes,extraDictionary,runLength});
  const catalogId = add("");
  const pagesId = add("");
  const chineseFontId=embedFont(add,addStream,fonts.chinese),serifFontId=embedFont(add,addStream,fonts.western);
  const pageIds = [];
  pages.forEach((lines, pageIndex) => {
    const commands = [style==='paper'?'1 1 1 rg':"0 0 0 rg", `0 0 ${PAGE.width} ${PAGE.height} re f`];
    for (const line of lines) {
      const color = style==='paper'?(line.muted?'0.35 0.35 0.35':'0.08 0.08 0.08'):(line.muted ? "0.68 0.68 0.68" : "1 1 1");
      commands.push(`${color} rg`, `${color} RG`);
      if (line.ruleBefore) commands.push(`${line.x - line.size * 2.5} ${line.y + line.size * 0.35} m ${line.x - line.size * 0.5} ${line.y + line.size * 0.35} l S`);
      commands.push(...textRunCommands(line.text, line.x, line.y, line.size,fonts));
    }
    commands.push("0.45 0.45 0.45 rg", ...textRunCommands(footer, PAGE.margin, 28, 8,fonts));
    commands.push(...textRunCommands(String(pageIndex + 1), PAGE.width - PAGE.margin - 18, 28, 8,fonts));
    const contentId = addStream(new TextEncoder().encode(commands.join("\n")));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${chineseFontId} 0 R /F2 ${serifFontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  return {objects,catalogId};
}

function serializePdf({objects,catalogId}) {
  const encoder=new TextEncoder(),chunks=[encoder.encode("%PDF-1.7\n%AfterMe\n")];
  let length=chunks[0].length;
  const offsets = [0];
  const append=value=>{const bytes=typeof value==='string'?encoder.encode(value):value;chunks.push(bytes);length+=bytes.length;};
  objects.forEach((object,index)=>{offsets.push(length);append(`${index+1} 0 obj\n`);append(object.bytes?pdfByteStream(object.bytes,object.extraDictionary,object.runLength):object);append('\nendobj\n');});
  const xref=length;
  let trailer=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objects.length;i++)trailer+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  append(trailer+`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const pdf=new Uint8Array(length);let position=0;for(const chunk of chunks){pdf.set(chunk,position);position+=chunk.length;}return pdf;
}

async function compressPdfDocument(document) {
  // Native zlib-wrapped deflate is PDF's FlateDecode. Work stays in the browser
  // PDF Worker; sequential streams bound temporary compressor allocations.
  if(typeof CompressionStream!=='function')return serializePdf(document);
  for(let index=0;index<document.objects.length;index++){
    const stream=document.objects[index];
    if(!stream.bytes)continue;
    const readable=new ReadableStream({start(controller){controller.enqueue(stream.bytes);controller.close();}});
    const deflated=new Uint8Array(await new Response(readable.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    let bytes=stream.bytes,filter='';
    if(stream.runLength){const packed=runLengthEncode(bytes);if(packed.length<bytes.length){bytes=packed;filter='/Filter /RunLengthDecode';}}
    if(deflated.length<bytes.length){bytes=deflated;filter='/Filter /FlateDecode';}
    document.objects[index]=encodedPdfStream(bytes,stream.extraDictionary,filter);
  }
  return serializePdf(document);
}

function layoutBlocks(blocks,fonts) {
  const pages = [[]];
  let y = PAGE.height - PAGE.margin;
  for (const [blockIndex,block] of blocks.entries()) {
    if (block.pageBreakBefore && pages.at(-1).length) { pages.push([]); y = PAGE.height - PAGE.margin; }
    const size = block.size || 11;
    const leading = block.leading || Math.ceil(size * 1.7);
    const indent = Number(block.indent || 0);
    const lines = wrapPdfText(block.text, PAGE.width - PAGE.margin * 2 - indent, size,fonts);
    // Reserve enough room for an endnote and the last two lines of its text.
    // Account for the following headings' own keep-with-next requirement too.
    let followingHeight=0,followingSpace=0;
    for(const next of blocks.slice(blockIndex+1,blockIndex+1+(block.keepTailWithNext||0))){
      const nextSize=next.size||11,nextLeading=next.leading||Math.ceil(nextSize*1.7);
      const nextLines=wrapPdfText(next.text,PAGE.width-PAGE.margin*2-Number(next.indent||0),nextSize,fonts);
      const height=(next.gapBefore||0)+Math.max(1,nextLines.length)*nextLeading;
      followingSpace=Math.max(followingSpace,followingHeight+height+(next.keepWithNext?30:0));
      followingHeight+=height+(next.gap||0);
    }
    const lineCount=block.split||lines.length*leading>PAGE.height-PAGE.margin-48?Math.min(2,lines.length):lines.length;
    const needed = (block.gapBefore || 0) + Math.max(1, lineCount) * leading + (block.keepWithNext ? 30 : 0);
    if (y - needed < 48 && pages.at(-1).length) { pages.push([]); y = PAGE.height - PAGE.margin; }
    y -= block.gapBefore || 0;
    for (const [lineIndex, line] of (lines.length ? lines : [""]).entries()) {
      const remaining=Math.max(1,lines.length)-lineIndex;
      if(followingSpace&&remaining<=2&&y-remaining*leading-(block.gap||0)-followingSpace<48&&pages.at(-1).length){pages.push([]);y=PAGE.height-PAGE.margin;}
      const lineWidth = estimatePdfTextWidth(line, size,fonts);
      const x = block.align === "right" ? PAGE.width - PAGE.margin - indent - lineWidth : PAGE.margin + indent;
      pages.at(-1).push({ text: line, x, y, size, muted: block.muted, ruleBefore: Boolean(block.ruleBefore && lineIndex === 0) });
      y -= leading;
      if (y < 48) { pages.push([]); y = PAGE.height - PAGE.margin; }
    }
    y -= block.gap || 0;
  }
  return pages.filter((page) => page.length);
}

export function wrapPdfText(value, maxWidth, fontSize,fonts) {
  const result = [];
  for (const paragraph of String(value ?? "").replaceAll("\r", "").split("\n")) {
    if (!paragraph) { result.push(""); continue; }
    const tokens = splitParagraphTokens(paragraph, maxWidth, fontSize,fonts);
    let lineTokens = [];
    for (const token of tokens) {
      if (isWhitespace(token) && !lineTokens.length) continue;
      const candidate = lineTokens.join("") + token;
      if (!lineTokens.length || estimatePdfTextWidth(candidate, fontSize,fonts) <= maxWidth) {
        lineTokens.push(token);
        continue;
      }

      if (isWhitespace(token)) {
        pushWrappedLine(result, lineTokens);
        lineTokens = [];
        continue;
      }

      const nextTokens = [token];
      while (lineTokens.length && (startsWithForbiddenPunctuation(nextTokens) || endsWithForbiddenPunctuation(lineTokens))) {
        nextTokens.unshift(lineTokens.pop());
      }
      pushWrappedLine(result, lineTokens);
      lineTokens = trimLeadingWhitespace(nextTokens);
    }
    pushWrappedLine(result, lineTokens);
  }
  return result;
}

export function estimatePdfTextWidth(value, fontSize,fonts) {
  let width = 0;
  for (const char of String(value ?? "")) width += fontSize * glyphWidth(char,fonts);
  return width;
}

function glyphWidth(char,fonts) {
  if(fonts?.cloud){const point=char.codePointAt(0),advance=SERIF_ADVANCES.get(point);return advance!==undefined?advance/PDF_SERIF_FONT_META.unitsPerEm:fonts.chinese.advances.get(point>65535?0x25a1:point)/fonts.chinese.meta.unitsPerEm;}
  if(fonts){const face=fontForCharacter(char,fonts),point=char.codePointAt(0);return face.advances.get(fonts.cloud&&point>65535?0x25a1:point)/face.meta.unitsPerEm;}
  const advance = SERIF_ADVANCES.get(char.codePointAt(0));
  if (advance !== undefined) return advance / PDF_SERIF_FONT_META.unitsPerEm;
  return 1;
}

function textRunCommands(value, x, y, size,fonts) {
  const commands = [];
  let cursor = x;
  for (const run of splitFontRuns(value,fonts)) {
    const font = run.kind === "serif" ? "F2" : "F1";
    commands.push(`BT /${font} ${size} Tf 1 0 0 1 ${cursor} ${y} Tm <${utf16Hex(run.text)}> Tj ET`);
    cursor += estimatePdfTextWidth(run.text, size,fonts);
  }
  return commands;
}

function splitFontRuns(value,fonts) {
  const runs = [];
  for (const char of String(value ?? "")) {
    const kind = fonts?(fontForCharacter(char,fonts)===fonts.western?'serif':'cjk'):(SERIF_GLYPH_IDS.has(char.codePointAt(0)) ? "serif" : "cjk");
    const previous = runs.at(-1);
    if (previous?.kind === kind) previous.text += char;
    else runs.push({ kind, text: char });
  }
  return runs;
}

function splitParagraphTokens(paragraph, maxWidth, fontSize,fonts) {
  const tokens = [];
  let word = "";
  const flushWord = () => {
    if (!word) return;
    if (estimatePdfTextWidth(word, fontSize,fonts) <= maxWidth) tokens.push(word);
    else tokens.push(...word);
    word = "";
  };
  for (const char of paragraph) {
    if (isWordCharacter(char)) word += char;
    else {
      flushWord();
      tokens.push(char);
    }
  }
  flushWord();
  return tokens;
}

function pushWrappedLine(result, tokens) {
  const line = tokens.join("").replace(/[ \t]+$/u, "");
  if (line || !result.length) result.push(line);
}

function trimLeadingWhitespace(tokens) {
  const result = [...tokens];
  while (result.length && isWhitespace(result[0])) result.shift();
  return result;
}

function startsWithForbiddenPunctuation(tokens) {
  const first = tokens.join("").trimStart()[0];
  return Boolean(first && FORBIDDEN_LINE_START.has(first));
}

function endsWithForbiddenPunctuation(tokens) {
  const value = tokens.join("").trimEnd();
  return Boolean(value && FORBIDDEN_LINE_END.has(value.at(-1)));
}

function isWordCharacter(char) {
  return /^[A-Za-z0-9@._:/+\-]$/u.test(char)
    || isAlphabeticProportionalCharacter(char)
    || isCombiningMark(char);
}

function isAlphabeticProportionalCharacter(char) {
  return /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]$/u.test(char);
}

function isCombiningMark(char) {
  return /^\p{Mark}$/u.test(char);
}

function isWhitespace(value) {
  return /^[ \t]+$/u.test(value);
}

function utf16Hex(value) {
  let hex = "";
  for (const char of String(value || "")) {
    const point = char.codePointAt(0);
    hex += (point > 0xffff ? 0x25a1 : point).toString(16).padStart(4, "0").toUpperCase();
  }
  return hex;
}

function prepareFontPair(pair) {
  const prepare=face=>{
    const {meta,codepoints,glyphIds,advances,base64}=face||{};
    if(!meta||!Number.isFinite(meta.unitsPerEm)||meta.unitsPerEm<=0||!/^[A-Za-z0-9_-]+$/.test(meta.postscriptName)||!Array.isArray(codepoints)||!codepoints.length||codepoints.length!==glyphIds?.length||codepoints.length!==advances?.length||typeof base64!=='string')throw new Error('Invalid PDF font data');
    const numbers=[...meta.bbox||[],meta.ascent,meta.descent,meta.capHeight,meta.italicAngle];
    if(meta.bbox?.length!==4||numbers.some(v=>!Number.isFinite(v)))throw new Error('Invalid PDF font metrics');
    if(codepoints.some((p,i)=>!Number.isInteger(p)||p<0||p>65535||(i&&p<=codepoints[i-1])||!Number.isInteger(glyphIds[i])||glyphIds[i]<=0||glyphIds[i]>65535||!Number.isFinite(advances[i])||advances[i]<0))throw new Error('Invalid PDF font glyphs');
    return {...face,advances:new Map(codepoints.map((p,i)=>[p,advances[i]]))};
  };
  return {chinese:prepare(pair.chinese),western:prepare(pair.western)};
}

function prepareCloudFonts(source,text) {
  const chars=[...text].filter(char=>char!=='\n'&&char!=='\r'&&char!=='\t'&&!SERIF_GLYPH_IDS.has(char.codePointAt(0))).join('');
  const face=subsetChineseFont(source,chars||'□');
  return {cloud:true,chinese:{...face,advances:new Map(face.codepoints.map((point,i)=>[point,face.advances[i]]))},western:{meta:PDF_SERIF_FONT_META,codepoints:PDF_SERIF_CODEPOINTS,glyphIds:PDF_SERIF_GLYPH_IDS,advances:SERIF_ADVANCES,base64:PDF_SERIF_FONT_BASE64}};
}

function fontForCharacter(char,fonts) {
  const value=char.codePointAt(0),point=fonts.cloud&&value>65535?0x25a1:value;
  if(fonts.cloud)return SERIF_GLYPH_IDS.has(point)?fonts.western:fonts.chinese;
  const chinese=/\p{Script=Han}/u.test(char)||(point>=0x3000&&point<=0x303f)||(point>=0xff00&&point<=0xffef);
  const face=chinese?fonts.chinese:fonts.western;
  if(!face.advances.has(point))throw new Error(`PDF font ${face.meta.postscriptName} lacks U+${point.toString(16).toUpperCase()}`);
  return face;
}

function embedFont(add,addStream,face) {
  const {meta,codepoints,glyphIds}=face,scale=v=>Math.round(v*1000/meta.unitsPerEm);
  const bytes=face.bytes||base64ToBytes(face.base64),file=addStream(bytes,`/Length1 ${bytes.length}`);
  const map=new Uint8Array((codepoints.at(-1)+1)*2);
  codepoints.forEach((point,i)=>{map[point*2]=glyphIds[i]>>8;map[point*2+1]=glyphIds[i]&255;});
  const cidMap=addStream(map,'',true);
  const cmap=['/CIDInit /ProcSet findresource begin','12 dict begin','begincmap','/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',`/CMapName /${meta.postscriptName}-UCS def`,'/CMapType 2 def','1 begincodespacerange','<0000> <FFFF>','endcodespacerange'];
  for(let i=0;i<codepoints.length;i+=100){const chunk=codepoints.slice(i,i+100);cmap.push(`${chunk.length} beginbfchar`,...chunk.map(p=>{const hex=p.toString(16).padStart(4,'0').toUpperCase();return `<${hex}> <${hex}>`;}),'endbfchar');}
  cmap.push('endcmap','CMapName currentdict /CMap defineresource pop','end','end');
  const unicode=addStream(new TextEncoder().encode(cmap.join('\n')));
  const descriptor=add(`<< /Type /FontDescriptor /FontName /${meta.postscriptName} /Flags 34 /FontBBox [${meta.bbox.map(scale).join(' ')}] /ItalicAngle ${meta.italicAngle} /Ascent ${scale(meta.ascent)} /Descent ${scale(meta.descent)} /CapHeight ${scale(meta.capHeight)} /StemV 80 /FontFile2 ${file} 0 R >>`);
  const widths=codepoints.map(p=>`${p} [${scale(face.advances.get(p))}]`).join(' ');
  const cid=add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${meta.postscriptName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap ${cidMap} 0 R >>`);
  return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${meta.postscriptName} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${unicode} 0 R >>`);
}

function pdfByteStream(bytes, extraDictionary = "",compress=false) {
  let filter='';
  if(compress){const packed=runLengthEncode(bytes);if(packed.length<bytes.length){bytes=packed;filter='/Filter /RunLengthDecode';}}
  return encodedPdfStream(bytes,extraDictionary,filter);
}

function encodedPdfStream(bytes,extraDictionary='',filter='') {
  const encoder=new TextEncoder(),header=encoder.encode(`<< /Length ${bytes.length} ${filter} ${extraDictionary} >>\nstream\n`),end=encoder.encode('\nendstream');
  const stream=new Uint8Array(header.length+bytes.length+end.length);stream.set(header);stream.set(bytes,header.length);stream.set(end,header.length+bytes.length);return stream;
}

function runLengthEncode(bytes) {
  const packed=[];
  for(let i=0;i<bytes.length;){
    let run=1;while(run<128&&i+run<bytes.length&&bytes[i+run]===bytes[i])run++;
    if(run>=3){packed.push(257-run,bytes[i]);i+=run;continue;}
    const start=i;i+=run;
    while(i<bytes.length&&i-start<128){if(i+2<bytes.length&&bytes[i]===bytes[i+1]&&bytes[i]===bytes[i+2])break;i++;}
    packed.push(i-start-1,...bytes.subarray(start,i));
  }
  packed.push(128);return Uint8Array.from(packed);
}
