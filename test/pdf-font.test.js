// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cloudChineseFont,subsetChineseFont,parseFont} from '../src/pdf-chinese-font.js';
import {buildPrivateLetterPdf as rawPrivatePdf} from '../src/pdf.js';
import {testChineseFont,buildPrivateLetterPdf} from './helpers/pdf-fonts.js';
import {privatePdfPayload,cachedPublicPdf} from '../src/pdf-cache.js';
import {openStoredPayload} from '../src/content.js';
import {testFontAssets} from './helpers/pdf-fonts.js';
import {PDF_SERIF_CODEPOINTS,PDF_SERIF_GLYPH_IDS} from '../src/pdf-serif-font-data.js';

test('cloud PDFs embed a Simplified Chinese font and retain extractable Unicode',()=>{
  const bytes=buildPrivateLetterPdf({body:'简体中文：国门骨语，龘㐀。English 123. Привет.'}),source=new TextDecoder().decode(bytes);
  assert.doesNotMatch(source,/STSong-Light|UniGB-UCS2-H/);
  assert.match(source,/\/BaseFont \/AfterMePDFSongSC/);
  assert.equal([...source.matchAll(/\/FontFile2 \d+ 0 R/g)].length,2);
  assert.equal([...source.matchAll(/\/ToUnicode \d+ 0 R/g)].length,2);
  assert.ok(bytes.length<300000,'short letters do not embed the complete 14 MB font');
  assert.throws(()=>rawPrivatePdf({body:'中文'}),/embedded PDF Chinese font is required/);
});

test('document subsets have valid checksums, remapped glyphs and original widths',()=>{
  const characters='简体中文，国门骨语。é㐀龘',face=subsetChineseFont(testChineseFont,characters);
  // The output has a UCS-4 cmap; validate its bytes/checksum independently of parseFont's BMP input path.
  const view=new DataView(face.bytes.buffer),sum=Array.from({length:face.bytes.length/4},(_,i)=>view.getUint32(i*4)).reduce((a,b)=>(a+b)>>>0,0);
  assert.equal(sum,0xb1b0afba);
  assert.ok(face.bytes.length<80000);
  for(const [i,point] of face.codepoints.entries()){
    assert.ok(face.glyphIds[i]>0);
    assert.equal(face.advances[i],testChineseFont.metrics(testChineseFont.glyphFor(point))[0]);
  }
  assert.equal(new Set(face.codepoints).size,new Set([...characters]).size);
  assert.throws(()=>subsetChineseFont(testChineseFont,'\u0378'),error=>error.status===422);
});

test('font loading shares concurrent reads, retries failures and stays separate from document data',async()=>{
  let requests=0;
  const bytes=readFileSync(new URL('../assets/fonts/afterme-song-sc.ttf',import.meta.url));
  const binding={async fetch(request){requests++;assert.equal(new URL(request.url).pathname,'/fonts/afterme-song-sc.ttf');if(requests===1)return new Response('',{status:503});return new Response(bytes);}};
  await assert.rejects(cloudChineseFont({PDF_FONTS:binding}),/unavailable/);
  const fonts=await Promise.all(Array.from({length:5},()=>cloudChineseFont({PDF_FONTS:binding})));
  assert.equal(requests,2);assert.ok(fonts.every(font=>font===fonts[0]));
  assert.ok(fonts[0].glyphFor('国'.codePointAt(0)));
  await cloudChineseFont({PDF_FONTS:binding});assert.equal(requests,2);
  await assert.rejects(cloudChineseFont({}),/binding is missing/);
});

test('font parsing rejects invalid or truncated static resources',()=>{
  for(const bytes of [new Uint8Array(),new Uint8Array(100),new Uint8Array([0,1,0,0,0,64,0,0,0,0,0,0])])assert.throws(()=>parseFont(bytes),/Invalid/);
});

test('compressed PDF glyph maps preserve every Western glyph ID',()=>{
  const bytes=Buffer.from(buildPrivateLetterPdf({body:'中文 English 123 Русский'})),source=bytes.toString('latin1');
  const ids=[...source.matchAll(/\/CIDToGIDMap (\d+) 0 R/g)].map(match=>Number(match[1]));
  const start=bytes.indexOf(Buffer.from('\n'+ids[1]+' 0 obj\n')),stream=bytes.indexOf(Buffer.from('\nstream\n'),start),header=bytes.subarray(start,stream).toString('ascii');
  assert.match(header,/\/RunLengthDecode/);
  const packed=bytes.subarray(stream+8,stream+8+Number(header.match(/\/Length (\d+)/)[1])),decoded=[];
  for(let i=0;i<packed.length;){const control=packed[i++];if(control===128)break;if(control<128){decoded.push(...packed.subarray(i,i+control+1));i+=control+1;}else{decoded.push(...Array(257-control).fill(packed[i++]));}}
  const data=Uint8Array.from(decoded),view=new DataView(data.buffer);
  assert.equal(data.length,(PDF_SERIF_CODEPOINTS.at(-1)+1)*2);
  PDF_SERIF_CODEPOINTS.forEach((point,i)=>assert.equal(view.getUint16(point*2),PDF_SERIF_GLYPH_IDS[i]));
});

test('oversized derived private PDFs do not prevent storing the original letter',async()=>{
  const env={CONTENT_ENCRYPTION_KEY:'independent-fixture-key'};
  assert.equal(await privatePdfPayload(new Uint8Array(1100000),env,'ciphertext'),null);
  const bytes=new Uint8Array([37,80,68,70]);
  const payload=await privatePdfPayload(bytes,env,'ciphertext');
  assert.equal((await openStoredPayload(payload,env)).plaintext,btoa('%PDF'));
});

test('oversized public PDFs are returned without an invalid D1 cache write',async()=>{
  const document={updated_at:'2030-01-01T00:00:00Z'};
  let saves=0;
  const repo={async getPublicFarewell(){return document;},async getDocumentArtifact(){return null;},farewell:{async listFormalGroups(){return [{display_title:'Large letter',entries:[{display_body:'Line\n'.repeat(20000)}]}];}},async saveDocumentArtifact(){saves++;}};
  const artifact=await cachedPublicPdf(repo,{PDF_FONTS:testFontAssets},{display_name:'Example'});
  assert.ok(artifact.content_base64.length>1800000);
  assert.equal(saves,0);assert.equal(artifact.updated_at,document.updated_at);
});
