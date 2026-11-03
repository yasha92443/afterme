// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {base64ToBytes,bytesToBase64} from './invocation-budget.js';
import {openStoredPayload,buildStoredPayload} from './content.js';

export const PDF_CHUNK_BYTES=128*1024;
export const MAX_PDF_MANIFEST_BYTES=1024*1024;
export function artifactChunkBytes(row={}){const value=row.chunk_bytes??PDF_CHUNK_BYTES;if(![16384,32768,65536,131072].includes(value))throw fail('Invalid PDF chunk size');return value;}
export const DEFAULT_MAX_PDF_BYTES=8*1024*1024;
// Resource protection guard. Set production capacity after provider acceptance:
// profiles must also satisfy the provider's MIME limit and measured CPU budget.
export const HARD_MAX_PDF_BYTES=64*1024*1024;
export const PDF_MANIFEST_ALGORITHM='chunk-manifest-v1';
const encoder=new TextEncoder(),keyCache=new WeakMap(),manifestCache=new WeakMap();
const fail=message=>Object.assign(new Error(message),{status:409,code:'pdf_artifact_integrity'});
export function pdfByteLimit(env={}){const value=Number(env.PDF_MAX_BYTES||DEFAULT_MAX_PDF_BYTES);return Number.isSafeInteger(value)&&value>=16?Math.min(value,HARD_MAX_PDF_BYTES):DEFAULT_MAX_PDF_BYTES;}
export async function digestPdfBytes(bytes){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
function hex(bytes){return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');}
function unhex(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail('Invalid PDF manifest authentication');return Uint8Array.from(value.match(/../g),part=>parseInt(part,16));}
async function macKey(env,secret){
  if(!secret)throw fail('PDF manifest content key is unavailable');
  let entries=keyCache.get(env);if(!entries){entries=new Map();keyCache.set(env,entries);}
  if(!entries.has(secret)){if(entries.size>=2)entries.clear();entries.set(secret,(async()=>crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode('afterme:pdf-artifact-manifest:v1\0'+secret)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']))());}
  return entries.get(secret);
}
export function initialValidationManifest(row){return {v:1,algorithm:PDF_MANIFEST_ALGORITHM,artifact_id:row.id,kind:row.kind,item_id:row.item_id,source_revision:row.source_revision,layout_key:row.layout_key,locale:row.locale,upload_revision:row.upload_revision,total_bytes:row.total_bytes,chunk_count:row.chunk_count,chunk_bytes:artifactChunkBytes(row),parts:[],header_valid:false,eof_valid:false};}
export async function authenticateValidationManifest(env,manifest){
  const text=JSON.stringify(manifest),bytes=encoder.encode(text);
  return {text,sha256:await digestPdfBytes(bytes),mac:hex(new Uint8Array(await crypto.subtle.sign('HMAC',await macKey(env,env.CONTENT_ENCRYPTION_KEY),bytes)))};
}
function assertBinding(row,manifest,{complete=false}={}){
  const chunkBytes=artifactChunkBytes(row);
  if(manifest?.v!==1||manifest.algorithm!==PDF_MANIFEST_ALGORITHM||manifest.artifact_id!==row.id||manifest.kind!==row.kind||manifest.item_id!==row.item_id||manifest.source_revision!==row.source_revision||manifest.layout_key!==row.layout_key||manifest.locale!==row.locale||manifest.upload_revision!==row.validation_upload_revision||manifest.upload_revision!==row.upload_revision||manifest.total_bytes!==row.total_bytes||manifest.chunk_count!==row.chunk_count||(manifest.chunk_bytes??PDF_CHUNK_BYTES)!==chunkBytes||!Number.isSafeInteger(row.total_bytes)||row.total_bytes<16||row.total_bytes>HARD_MAX_PDF_BYTES||!Number.isSafeInteger(row.chunk_count)||row.chunk_count!==Math.ceil(row.total_bytes/chunkBytes)||!Array.isArray(manifest.parts)||manifest.parts.length!==row.validation_cursor||manifest.parts.length>row.chunk_count)throw fail('PDF validation manifest changed');
  let total=0;
  for(let index=0;index<manifest.parts.length;index++){
    const part=manifest.parts[index],expected=Math.min(chunkBytes,row.total_bytes-index*chunkBytes);
    if(part.index!==index||part.bytes!==expected||typeof part.sha256!=='string'||!/^[a-f0-9]{64}$/.test(part.sha256))throw fail('Invalid ordered PDF manifest');
    total+=part.bytes;
  }
  if(total!==row.validation_bytes)throw fail('PDF validation byte count changed');
  if(complete&&(row.status!=='ready'||row.validation_state!=='verified'||manifest.parts.length!==row.chunk_count||total!==row.total_bytes||!manifest.header_valid||!manifest.eof_valid))throw fail('PDF validation is incomplete');
  return manifest;
}
export async function verifiedValidationManifest(env,row,{complete=false}={}){
  if(row.validation_algorithm!==PDF_MANIFEST_ALGORITHM||typeof row.validation_manifest!=='string'||row.validation_manifest.length>MAX_PDF_MANIFEST_BYTES)throw fail('Missing PDF validation manifest');
  // Cache only authenticated metadata, never PDF plaintext. Bind the row again on
  // every call, including callers that carry a different source or upload epoch.
  let entries=manifestCache.get(env);if(!entries){entries=new Map();manifestCache.set(env,entries);}
  const cacheKey=JSON.stringify([row.validation_manifest,row.validation_mac,row.manifest_sha256,env.CONTENT_ENCRYPTION_KEY,env.LEGACY_CONTENT_ENCRYPTION_KEY]);
  if(!entries.has(cacheKey)){
    if(entries.size>=4)entries.clear();
    entries.set(cacheKey,(async()=>{
      const bytes=encoder.encode(row.validation_manifest);if(await digestPdfBytes(bytes)!==row.manifest_sha256)throw fail('PDF manifest digest changed');
      const signature=unhex(row.validation_mac);let valid=false;
      for(const secret of [...new Set([env.CONTENT_ENCRYPTION_KEY,env.LEGACY_CONTENT_ENCRYPTION_KEY].filter(Boolean))])if(await crypto.subtle.verify('HMAC',await macKey(env,secret),signature,bytes)){valid=true;break;}
      if(!valid)throw fail('PDF manifest authentication failed');
      try{const manifest=JSON.parse(row.validation_manifest);if(Array.isArray(manifest.parts)){for(const part of manifest.parts)Object.freeze(part);Object.freeze(manifest.parts);}return Object.freeze(manifest);}catch{throw fail('Invalid PDF validation manifest');}
    })());
  }
  return assertBinding(row,await entries.get(cacheKey),{complete});
}
export async function validatedPdfChunk(env,row,chunk,expected){
  if(!chunk||chunk.artifact_id!==row.id||chunk.chunk_index!==expected.index||chunk.byte_length!==expected.bytes||chunk.sha256!==expected.sha256)throw fail('PDF artifact chunk metadata changed');
  let encoded=chunk.payload;
  if(row.kind==='private'){
    const opened=await openStoredPayload(encoded,env);if(opened.mode!=='link'||!opened.plaintext)throw fail('Invalid encrypted PDF chunk');encoded=opened.plaintext;
  }
  const bytes=base64ToBytes(encoded);
  if(bytes.length!==expected.bytes||await digestPdfBytes(bytes)!==expected.sha256)throw fail('PDF artifact chunk was modified');
  return bytes;
}
export async function appendValidationPart(env,row,manifest,chunk){
  const index=row.validation_cursor,chunkBytes=artifactChunkBytes(row),expected={index,bytes:Math.min(chunkBytes,row.total_bytes-index*chunkBytes),sha256:chunk?.sha256};
  const bytes=await validatedPdfChunk(env,row,chunk,expected),next={...manifest,parts:[...manifest.parts,expected]};
  if(index===0){next.header_valid=new TextDecoder().decode(bytes.subarray(0,8)).startsWith('%PDF-1.');if(!next.header_valid)throw fail('Invalid PDF header');}
  if(index===row.chunk_count-1){
    let tail=bytes.subarray(Math.max(0,bytes.length-1024));
    if(bytes.length<1024&&manifest.ending){
      let encoded=manifest.ending;if(row.kind==='private'){const opened=await openStoredPayload(encoded,env);if(opened.mode!=='link')throw fail('Invalid PDF ending');encoded=opened.plaintext;}
      const prior=base64ToBytes(encoded),combined=new Uint8Array(prior.length+bytes.length);combined.set(prior);combined.set(bytes,prior.length);tail=combined.subarray(Math.max(0,combined.length-1024));
    }
    next.eof_valid=new TextDecoder().decode(tail).includes('%%EOF');if(!next.eof_valid)throw fail('Invalid PDF ending');delete next.ending;
  }else if(index===row.chunk_count-2){
    const encoded=bytesToBase64(bytes.subarray(Math.max(0,bytes.length-1024)));
    next.ending=row.kind==='private'?await buildStoredPayload({body:{plaintext:encoded},env}):encoded;
  }
  return next;
}
