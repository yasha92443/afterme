// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { buildPrivateLetterPdf, buildPublicFarewellPdf, bytesToBase64, base64ToBytes, estimatePdfTextWidth, wrapPdfText } from "./helpers/pdf-fonts.js";
import { privateLetterPdfResponse } from "../src/worker.js";
import {PDF_SERIF_FONT_BASE64,PDF_SERIF_FONT_META,PDF_SERIF_CODEPOINTS,PDF_SERIF_GLYPH_IDS,PDF_SERIF_ADVANCES} from '../src/pdf-serif-font-data.js';
import {t,formatTime} from '../src/i18n.js';

// Inspect actual page text commands, excluding the repeated page footer.
function pdfPages(bytes) {
  return [...new TextDecoder().decode(bytes).matchAll(/\nstream\n([\s\S]*?)\nendstream/g)].flatMap(([,stream])=>{
    const lines=[];
    for(const [,size,x,y,hex] of stream.matchAll(/BT \/F[12] ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm <([A-F0-9]+)> Tj ET/g)){
      if(Number(y)===28)continue;
      const text=hex.match(/.{4}/g).map(value=>String.fromCharCode(parseInt(value,16))).join('');
      if(lines.at(-1)?.y===Number(y))lines.at(-1).text+=text;
      else lines.push({text,size:Number(size),x:Number(x),y:Number(y)});
    }
    return lines.length?[lines]:[];
  });
}

test('public PDF dates follow all text on a separate appendix in every locale and style',()=>{
  const updatedAt='2026-10-06T00:00:00Z',groups=[
    {display_title:'First chapter',display_epigraph:'First line\nSecond line\n——Source',title_updated_at:updatedAt,epigraph_updated_at:updatedAt,entries:[{display_body:'First paragraph\n\nNext paragraph',body_updated_at:updatedAt},{display_body:'Unstamped paragraph'},{display_body:'Last in first chapter',body_updated_at:updatedAt}]},
    {display_title:'Final chapter',display_epigraph:'',title_updated_at:updatedAt,epigraph_updated_at:updatedAt,entries:[{display_body:'FINAL_BODY',body_updated_at:updatedAt}]},
  ];
  for(const locale of ['zh','en','ru'])for(const style of ['night','paper']){
    const pages=pdfPages(buildPublicFarewellPdf({ownerName:'Example',groups,updatedAt,locale,timezone:'UTC',style}));
    const versionPage=pages.findIndex(page=>page.some(line=>line.text===t(locale,'versionInfo')));
    assert.ok(versionPage>0);
    assert.equal(pages[versionPage][0].text,t(locale,'versionInfo'));
    const body=pages.slice(0,versionPage).flat(),metadata=pages.slice(versionPage).flat().map(line=>line.text).join('\n');
    assert.equal(body.at(-1).text,'FINAL_BODY');
    for(const key of ['publicUpdated','chapterUpdated','epigraphUpdated','entryUpdated'])assert.ok(body.every(line=>!line.text.includes(t(locale,key))));
    assert.equal(metadata.split(t(locale,'epigraphUpdated')).length-1,1,'removed epigraph dates are omitted');
    assert.ok(metadata.includes(t(locale,'entryNumber',{number:3})+' · '+t(locale,'entryUpdated')));
    assert.ok(!metadata.includes(t(locale,'entryNumber',{number:2})+' · '+t(locale,'entryUpdated')));
    assert.ok(metadata.includes(formatTime(updatedAt,locale,'UTC')));
    assert.ok(metadata.indexOf('First chapter')<metadata.indexOf('Final chapter'));
    const first=body.find(line=>line.text==='First paragraph'),next=body.find(line=>line.text==='Next paragraph');
    assert.equal(first.y-next.y,40,'paragraph blank lines remain');
    assert.equal(body.find(line=>line.text==='First line').y-body.find(line=>line.text==='Second line').y,18,'epigraph line breaks remain');
  }
});

test('private PDF dates appear only after the complete letter without wasting a page for short letters',()=>{
  for(const locale of ['zh','en','ru'])for(const style of ['night','paper'])for(const length of [1,2,29,30,31,32,33,75]){
    const body=Array.from({length},(_,i)=>`LETTER_LINE_${i+1}`).join('\n'),updatedAt='2026-10-06T00:00:00Z';
    const pages=pdfPages(buildPrivateLetterPdf({ownerName:'Alex',recipientName:'Sam',body,updatedAt,locale,style}));
    const lines=pages.flat(),heading=lines.findIndex(line=>line.text===t(locale,'versionInfo'));
    assert.equal(lines[0].text,'LETTER_LINE_1','private PDFs start directly with the saved body');
    assert.equal(lines[0].size,12);
    assert.equal(lines[0].y,788,'no empty heading space remains');
    assert.ok(lines.every(line=>line.text!==t(locale,'privateHeading',{owner:'Alex',recipient:'Sam'})));
    assert.ok(heading>0);
    assert.equal(lines[heading-1].text,`LETTER_LINE_${length}`);
    assert.ok(lines[heading+1].text.startsWith(t(locale,'savedAt')));
    assert.equal(lines.at(-1),lines[heading+1]);
    assert.equal(lines.filter(line=>line.text.startsWith('LETTER_LINE_')).length,length);
    assert.ok(pages.every(page=>page.every(line=>line.y>=48&&line.y<=788)));
    assert.ok(pages.some(page=>page.includes(lines[heading])&&page.includes(lines[heading+1])),'endnote heading stays with its date');
    assert.ok(pages.find(page=>page.includes(lines[heading])).some(line=>line.text.startsWith('LETTER_LINE_')),'endnote never occupies a page without letter text');
    if(length===2)assert.equal(pages.length,1);
  }
});

test('PDFs without recorded dates omit empty version sections',()=>{
  const publicPages=pdfPages(buildPublicFarewellPdf({groups:[{display_title:'Chapter',entries:[{display_body:'Text'}]}]}));
  const privatePages=pdfPages(buildPrivateLetterPdf({body:'Text'}));
  for(const pages of [publicPages,privatePages]){
    assert.equal(pages.length,1);
    assert.ok(pages.flat().every(line=>line.text!==t('zh','versionInfo')));
    assert.equal(pages.flat().at(-1).text,'Text');
  }
});

test('long public text and version appendices paginate without mixing or losing entries',()=>{
  const updatedAt='2026-10-06T00:00:00Z';
  const groups=Array.from({length:4},(_,i)=>({display_title:`Chapter ${i+1}`,title_updated_at:updatedAt,entries:Array.from({length:25},(_,j)=>({display_body:`BODY_${i+1}_${j+1}`,body_updated_at:updatedAt}))}));
  const pages=pdfPages(buildPublicFarewellPdf({ownerName:'Example',groups,updatedAt,locale:'en'}));
  const index=pages.findIndex(page=>page[0].text==='Version information');
  assert.ok(index>1&&pages.length-index>1);
  assert.deepEqual(pages.slice(0,index).flat().filter(line=>line.text.startsWith('BODY_')).map(line=>line.text),groups.flatMap(group=>group.entries.map(entry=>entry.display_body)));
  const notes=pages.slice(index).flat();
  assert.equal(notes.filter(line=>/^Entry \d+ · Entry updated:/.test(line.text)).length,100);
  assert.equal(notes.filter(line=>line.text==='Version information').length,1);
  assert.ok(pages.every(page=>page.length&&page.every(line=>line.y>=48&&line.y<=788)));
  assert.ok(pages.slice(index).every(page=>!page.at(-1).text.includes('Chapter ')),'appendix chapter headings are not orphaned');
});

function embeddedFixture(){const face={base64:PDF_SERIF_FONT_BASE64,meta:PDF_SERIF_FONT_META,codepoints:PDF_SERIF_CODEPOINTS,glyphIds:PDF_SERIF_GLYPH_IDS,advances:PDF_SERIF_ADVANCES};return {chinese:face,western:face};}

test('explicit PDF fonts embed both faces and use the Western face for text and digits',()=>{
  const source=new TextDecoder().decode(buildPrivateLetterPdf({ownerName:'Alex',recipientName:'Friend',locale:'en',body:'Hello 0123456789. Привет.',fontPair:embeddedFixture()}));
  assert.equal([...source.matchAll(/\/FontFile2 \d+ 0 R/g)].length,2);
  assert.equal([...source.matchAll(/\/ToUnicode \d+ 0 R/g)].length,2);
  assert.doesNotMatch(source,/STSong-Light/);
  assert.match(source,/\/F2 12 Tf[^\n]*<00480065006C006C006F00200030003100320033003400350036003700380039/);
});

test('explicit PDF fonts fail on missing Chinese glyphs instead of using a reader substitute',()=>{
  assert.throws(()=>buildPrivateLetterPdf({ownerName:'Alex',recipientName:'Friend',locale:'en',body:'中',fontPair:embeddedFixture()}),/lacks U\+4E2D/);
});

test('explicit PDF fonts reject malformed metrics before writing a PDF',()=>{
  const pair=embeddedFixture();pair.western={...pair.western,meta:{...pair.western.meta,unitsPerEm:0}};
  assert.throws(()=>buildPrivateLetterPdf({body:'Hello',fontPair:pair}),/Invalid PDF font data/);
});

test("public farewell PDF is a dark multi-section PDF with Chinese CID text", () => {
  const pdf = buildPublicFarewellPdf({
    ownerName: "示例用户",
    updatedAt: "2026-07-22T08:00:00.000Z",
    groups: [{
      display_title: "总则",
      display_epigraph: "认识你自己。\n——德尔斐箴言",
      epigraph_updated_at: "2026-07-21T07:00:00.000Z",
      title_updated_at: "2026-07-21T08:00:00.000Z",
      entries: [{ display_body: "这是公开遗言正文。", body_updated_at: "2026-07-20T08:00:00.000Z" }],
    }],
  });
  const source = new TextDecoder().decode(pdf);
  assert.match(source, /^%PDF-1.7/);
  assert.match(source, /0 0 595 842 re f/);
  assert.match(source, /\/BaseFont \/AfterMePDFSongSC/);
  assert.doesNotMatch(source, /STSong-Light/);
  assert.match(source, /\/BaseFont \/AfterMePDFSerif/);
  assert.match(source, /\/FontFile2 \d+ 0 R/);
  assert.match(source, /\/Encoding \/Identity-H/);
  assert.match(source, /\/F2 \d+ 0 R/);
  assert.match(source, /516C5F0090578A00/);
  assert.match(source, /8BA48BC64F6081EA5DF1/);
  assert.match(source, /5FB75C1465907BB48A00/);
  assert.match(source, /\d+(?:\.\d+)? \d+(?:\.\d+)? m \d+(?:\.\d+)? \d+(?:\.\d+)? l S/);
});

test("PDF text layout uses half-width Latin text and Chinese line-breaking rules", () => {
  assert.ok(estimatePdfTextWidth("ppt", 12) < 24);
  assert.notEqual(estimatePdfTextWidth("p", 12), estimatePdfTextWidth("t", 12));
  assert.equal(estimatePdfTextWidth("中文", 12), 24);

  const text = "你之前为自己做过ppt，写过悼词，你说你是全党全军全国各族人民公认的优秀玉玉症患者。";
  const lines = wrapPdfText(text, 126, 12);
  assert.equal(lines.join(""), text);
  assert.ok(lines.length > 1);
  for (const line of lines.slice(1)) assert.doesNotMatch(line, /^[，。、；：？！）》】〕〉」』”’…—,.!?;:%\)\]\}>]/u);
  for (const line of lines.slice(0, -1)) assert.doesNotMatch(line, /[（《【〔〈「『“‘\(\[\{<]$/u);
  assert.ok(lines.some((line) => line.includes("ppt，")), "Latin word and following Chinese punctuation should stay visually adjacent");

  const narrowPunctuationLines = wrapPdfText("他说：“这些标点不应该跑到下一行开头。”（括号也不应该孤零零留在上一行末尾。）《书名号》、问号？感叹号！", 66, 12);
  assert.equal(narrowPunctuationLines.join(""), "他说：“这些标点不应该跑到下一行开头。”（括号也不应该孤零零留在上一行末尾。）《书名号》、问号？感叹号！");
  for (const line of narrowPunctuationLines.slice(1)) assert.doesNotMatch(line, /^[，。、；：？！）》】〕〉」』”’…—,.!?;:%\)\]\}>]/u);
  for (const line of narrowPunctuationLines.slice(0, -1)) assert.doesNotMatch(line, /[（《【〔〈「『“‘\(\[\{<]$/u);
});

test("PDF text layout uses proportional Cyrillic widths and preserves Russian words", () => {
  assert.ok(estimatePdfTextWidth("Человек", 12) < 12 * 7);
  assert.notEqual(estimatePdfTextWidth("Ш", 12), estimatePdfTextWidth("и", 12));

  const text = "Человек должен жить достойно. Пролетарии всех стран, соединяйтесь!";
  const lines = wrapPdfText(text, 102, 12);
  assert.equal(lines.join(" ").replace(/\s+/gu, " "), text);
  assert.ok(lines.length > 1);
  for (const word of text.match(/\p{Script=Cyrillic}+/gu)) {
    assert.ok(lines.some((line) => line.includes(word)), `Russian word should not split: ${word}`);
  }

  const pdf = buildPrivateLetterPdf({ ownerName: "Фэн Бо", recipientName: "друг", body: text });
  const source = new TextDecoder().decode(pdf);
  assert.match(source, /\/F2 12 Tf[^\n]*<04270435043B043E04320435043A0020/);
});

test("private letter PDF survives base64 storage round trip", () => {
  const pdf = buildPrivateLetterPdf({ ownerName: "示例用户", recipientName: "朋友", body: "正文", updatedAt: "2026-07-22T08:00:00.000Z" });
  assert.deepEqual(base64ToBytes(bytesToBase64(pdf)), pdf);
  assert.match(new TextDecoder().decode(pdf), /^%PDF-1.7/);
});

test("private letter preview opens inline with the intended Chinese filename", async () => {
  const pdf = buildPrivateLetterPdf({ ownerName: "示例用户", recipientName: "朋友", body: "正文" });
  const response = privateLetterPdfResponse(pdf, "示例用户");
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /^inline;/);
  assert.ok(response.headers.get("content-disposition").includes(encodeURIComponent('示例用户留给您的一封信.pdf')));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
});
