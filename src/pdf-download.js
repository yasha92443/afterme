// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {artifactContext,artifactIsCurrent,artifactById,findReadyArtifact,readValidatedArtifactChunk} from './pdf-artifacts.js';
import {artifactChunkBytes,HARD_MAX_PDF_BYTES,PDF_MANIFEST_ALGORITHM} from './pdf-validation.js';

const error=(status,message)=>Object.assign(new Error(message),{status});
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>(typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))?Number(value):NaN;
function shape(row){
  const chunkBytes=artifactChunkBytes(row),pin=row.manifest_sha256||row.sha256;
  const signed=row.validation_algorithm===PDF_MANIFEST_ALGORITHM;
  if(row.status!=='ready'||!Number.isSafeInteger(row.upload_revision)||row.upload_revision<0||!Number.isSafeInteger(row.total_bytes)||row.total_bytes<16||row.total_bytes>HARD_MAX_PDF_BYTES||row.chunk_count!==Math.ceil(row.total_bytes/chunkBytes)||!hash(pin)||!hash(row.sha256)||(signed?!hash(row.manifest_sha256):row.validation_algorithm!=null||row.manifest_sha256!=null))throw error(409,'PDF artifact is not ready or is incomplete');
  return {chunkBytes,pin};
}

// Resolve metadata only. The management browser reads and assembles the PDF in
// bounded authenticated chunks rather than charging one request for every byte.
export async function pdfPreviewDescriptor(repo,env,input){
  const context=await artifactContext(repo,env,{...input,metadataOnly:true});
  if(context.kind==='private'&&context.item?.kind!=='letter')throw error(404,'Private letter not found');
  const row=await findReadyArtifact(repo,context);
  if(!row)throw error(409,'PDF preparation is pending; prepare the saved version first');
  const {chunkBytes}=shape(row);
  if(!await artifactIsCurrent(repo,context))throw error(409,'PDF source or layout changed; prepare the current version');
  return {artifact_id:row.id,upload_revision:row.upload_revision,manifest_sha256:row.manifest_sha256??null,sha256:row.sha256,total_bytes:row.total_bytes,chunk_bytes:chunkBytes,chunk_count:row.chunk_count,source_revision:row.source_revision,layout_key:row.layout_key,kind:row.kind,item_id:row.item_id,locale:row.locale,filename:row.kind==='private'?`${context.owner?.display_name||'AfterMe'}留给您的一封信.pdf`:'afterme-public-farewell.pdf'};
}

export async function pdfPreviewChunk(repo,env,{artifact_id,index,upload_revision,pin}){
  index=integer(index);upload_revision=integer(upload_revision);
  if(typeof artifact_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(artifact_id)||!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(upload_revision)||upload_revision<0||!hash(pin))throw error(400,'Invalid PDF chunk request');
  const row=await artifactById(repo,artifact_id);if(!row)throw error(404,'PDF artifact not found');
  const {chunkBytes,pin:currentPin}=shape(row);
  if(row.upload_revision!==upload_revision||currentPin!==pin||index>=row.chunk_count)throw error(409,'PDF artifact changed; restart the preview');
  const bytes=await readValidatedArtifactChunk(repo,env,row,index),expected=Math.min(chunkBytes,row.total_bytes-index*chunkBytes);
  if(bytes.length!==expected)throw error(409,'PDF artifact chunk is incomplete');
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'Content-Range':`bytes ${index*chunkBytes}-${index*chunkBytes+bytes.length-1}/${row.total_bytes}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-AfterMe-Artifact':row.id,'X-AfterMe-Chunk':String(index),ETag:`"${row.upload_revision}-${currentPin}"`}});
}
