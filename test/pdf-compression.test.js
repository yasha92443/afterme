// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {buildPrivateLetterPdf,buildPublicFarewellPdf,buildPrivateLetterPdfAsync,buildPublicFarewellPdfAsync} from '../src/pdf.js';
import {testChineseFont} from './helpers/pdf-fonts.js';

// Read objects through their actual xref offsets and declared stream lengths:
// compressed bytes can contain text resembling PDF delimiters.
function inspectPdf(value){
  const bytes=Buffer.from(value),source=bytes.toString('latin1');
  const xrefAt=Number(source.match(/startxref\n(\d+)\n%%EOF$/)?.[1]);
  assert.ok(Number.isSafeInteger(xrefAt)&&xrefAt>0);
  const xref=source.slice(xrefAt).split('\n');assert.equal(xref[0],'xref');
  const count=Number(xref[1].match(/^0 (\d+)$/)?.[1]);assert.ok(count>1);assert.equal(xref[2],'0000000000 65535 f ');
  const offsets=xref.slice(3,3+count-1).map(line=>{assert.match(line,/^\d{10} 00000 n $/);return Number(line.slice(0,10));});
  const objects=offsets.map((offset,index)=>{
    const object=bytes.subarray(offset,offsets[index+1]??xrefAt),head=Buffer.from(`${index+1} 0 obj\n`);
    assert.ok(object.subarray(0,head.length).equals(head),`xref object ${index+1}`);assert.ok(object.subarray(-8).equals(Buffer.from('\nendobj\n')));
    const body=object.subarray(head.length,-8),streamAt=body.indexOf(Buffer.from('\nstream\n'));
    if(streamAt<0)return {body};
    const dictionary=body.subarray(0,streamAt).toString('ascii'),length=Number(dictionary.match(/\/Length (\d+)\b/)?.[1]);assert.ok(Number.isSafeInteger(length));
    const start=streamAt+8,packed=body.subarray(start,start+length);assert.equal(packed.length,length);assert.equal(body.subarray(start+length).toString('ascii'),'\nendstream');
    let decoded=packed;
    if(dictionary.includes('/FlateDecode'))decoded=inflateSync(packed);
    else if(dictionary.includes('/RunLengthDecode')){
      const parts=[];let ended=false;
      for(let i=0;i<packed.length;){const control=packed[i++];if(control===128){assert.equal(i,packed.length);ended=true;break;}if(control<128){parts.push(packed.subarray(i,i+control+1));i+=control+1;}else parts.push(Buffer.alloc(257-control,packed[i++]));}
      assert.equal(ended,true);decoded=Buffer.concat(parts);
    }
    const length1=dictionary.match(/\/Length1 (\d+)\b/);if(length1)assert.equal(decoded.length,Number(length1[1]),'font Length1 remains uncompressed length');
    return {dictionary,decoded,length1:Boolean(length1)};
  });
  return {bytes,objects};
}

function assertEquivalent(original,compressed){
  const before=inspectPdf(original),after=inspectPdf(compressed);assert.equal(after.objects.length,before.objects.length);
  for(let i=0;i<before.objects.length;i++){
    const a=before.objects[i],b=after.objects[i];
    if(a.decoded){assert.ok(b.decoded);assert.deepEqual(b.decoded,a.decoded,`decoded object ${i+1} is unchanged`);assert.equal(b.dictionary.replace(/\/Length \d+|\/Filter \/(?:FlateDecode|RunLengthDecode)/g,'').replace(/\s+/g,' '),a.dictionary.replace(/\/Length \d+|\/Filter \/(?:FlateDecode|RunLengthDecode)/g,'').replace(/\s+/g,' '));}
    else assert.deepEqual(b.body,a.body,`nonstream object ${i+1} is unchanged`);
  }
  return after;
}

function pageText(pdf){return pdf.objects.filter(object=>object.decoded&&!object.length1).flatMap(object=>[...object.decoded.toString('ascii').matchAll(/BT \/F[12] [^\n]*? Tm <([A-F0-9]+)> Tj ET/g)].map(([,hex])=>hex.match(/.{4}/g).map(code=>String.fromCharCode(parseInt(code,16))).join(''))).join('');}

for(const locale of ['zh','en','ru'])for(const style of ['night','paper']){
  test(`Flate preserves private/public fonts, page commands and searchable text (${locale}/${style})`,async()=>{
    const line='中文国门骨语，完整保留。 English searchable text 123. Русский текст сохранён. ',updatedAt='2026-10-23T00:00:00Z';
    const options={chineseFont:testChineseFont,ownerName:'Example 示例',locale,style,timezone:'UTC',updatedAt,body:Array.from({length:70},(_,i)=>`${i+1}: ${line}`).join('\n')};
    const privateSync=buildPrivateLetterPdf(options);assert.ok(privateSync instanceof Uint8Array,'sync API stays synchronous');
    const privateCompressed=await buildPrivateLetterPdfAsync(options),privatePdf=assertEquivalent(privateSync,privateCompressed);
    assert.ok(privateCompressed.length<privateSync.length*0.65,`private compression ${privateCompressed.length}/${privateSync.length}`);
    const text=pageText(privatePdf);for(const phrase of ['中文国门骨语，完整保留。','English searchable text 123.','Русский текст сохранён.'])assert.ok(text.includes(phrase),phrase);
    const groups=[{display_title:'第一章 Chapter Русский',display_epigraph:'保留引文\n——Example',title_updated_at:updatedAt,epigraph_updated_at:updatedAt,entries:[{display_body:options.body,body_updated_at:updatedAt},{display_body:'FINAL_PUBLIC_ENTRY',body_updated_at:updatedAt}]}];
    const publicSync=buildPublicFarewellPdf({...options,groups}),publicCompressed=await buildPublicFarewellPdfAsync({...options,groups}),publicPdf=assertEquivalent(publicSync,publicCompressed);
    assert.ok(publicCompressed.length<publicSync.length*0.65,`public compression ${publicCompressed.length}/${publicSync.length}`);assert.ok(pageText(publicPdf).includes('FINAL_PUBLIC_ENTRY'));
    for(const pdf of [privatePdf,publicPdf]){
      assert.equal(pdf.objects.filter(object=>object.length1&&object.dictionary.includes('/FlateDecode')).length,2,'both embedded fonts are compressed');
      assert.equal(pdf.objects.filter(object=>object.decoded?.includes(Buffer.from('begincmap'))&&object.dictionary.includes('/FlateDecode')).length,2,'both Unicode maps are compressed');
      assert.ok(pdf.objects.filter(object=>object.decoded?.includes(Buffer.from('BT /F'))).every(object=>object.dictionary.includes('/FlateDecode')),'page command streams are compressed');
    }
  });
}

test('async generation preserves synchronous fallback when native compression is unavailable',async()=>{
  const native=globalThis.CompressionStream;
  try{
    globalThis.CompressionStream=undefined;
    const options={chineseFont:testChineseFont,body:'中文 English Русский',locale:'ru'};
    assert.deepEqual(await buildPrivateLetterPdfAsync(options),buildPrivateLetterPdf(options));
    assert.deepEqual(await buildPublicFarewellPdfAsync(options),buildPublicFarewellPdf(options));
  }finally{globalThis.CompressionStream=native;}
});

test('native compression failures reject without emitting a partial PDF or mutating source',async()=>{
  const native=globalThis.CompressionStream,options={chineseFont:testChineseFont,body:'SAVED_SOURCE 中文 Русский'};
  const original=buildPrivateLetterPdf(options);
  try{globalThis.CompressionStream=class{constructor(){throw Error('Synthetic native compressor failure');}};await assert.rejects(buildPrivateLetterPdfAsync(options),/Synthetic native compressor failure/);assert.deepEqual(buildPrivateLetterPdf(options),original);assert.equal(options.body,'SAVED_SOURCE 中文 Русский');}
  finally{globalThis.CompressionStream=native;}
});
