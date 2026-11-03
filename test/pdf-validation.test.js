// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {buildStoredPayload} from '../src/content.js';
import {bytesToBase64} from '../src/invocation-budget.js';
import {artifactContext,artifactById,beginArtifact,uploadArtifactChunk,completeArtifact,runArtifactValidationStep,readValidatedArtifactChunk,readArtifactBytes,pdfDigest,pdfPreparationSource,assertPublicPdfSourceSize,PDF_CHUNK_BYTES,PDF_SOURCE_PAGE_BYTES,publicArtifact,pdfByteLimit} from '../src/pdf-artifacts.js';
import {verifiedValidationManifest} from '../src/pdf-validation.js';

async function fixture(t){
  const db=database({through:24});t.after(()=>db.close());const repo=new Repository(db),now='2030-01-01T00:00:00.000Z';
  const env={CONTENT_ENCRYPTION_KEY:'synthetic-pdf-content-key',BACKGROUND_EXECUTION_MODE:'staged'};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});
  const recipientId=await repo.createRecipient({name:'Reader',email:'reader@example.invalid',now});
  const id=await repo.createEncryptedItem({kind:'letter',title:'',recipientId,encryptedPayload:await buildStoredPayload({body:{plaintext:'Saved source'},env}),payloadSize:12,vaultToken:'synthetic',vaultTokenHash:'synthetic',updatedAt:now});
  return {db,repo,env,id,now};
}
function pdf(size=PDF_CHUNK_BYTES+2){
  const bytes=new Uint8Array(size).fill(65);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));bytes.set(new TextEncoder().encode('%%EOF\n'),bytes.length-6);return bytes;
}
async function upload(f,bytes=pdf()){
  const artifact=await beginArtifact(f.repo,f.env,{kind:'private',id:f.id});
  for(let i=0;i<Math.ceil(bytes.length/PDF_CHUNK_BYTES);i++)await uploadArtifactChunk(f.repo,f.env,artifact.id,i,bytesToBase64(bytes.subarray(i*PDF_CHUNK_BYTES,(i+1)*PDF_CHUNK_BYTES)));
  const input={total_bytes:bytes.length,chunk_count:Math.ceil(bytes.length/PDF_CHUNK_BYTES),sha256:'0'.repeat(64)};
  return {artifact,input,bytes};
}
async function finish(f,artifact){
  for(let step=0;step<20;step++){const result=await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);if(result.done)return result;}
  throw Error('Validation did not finish');
}

for(const size of [16*1024,32*1024,64*1024])test('artifact chunk profile '+size+' binds its size and preserves every PDF byte',async t=>{
  const f=await fixture(t);f.env.PDF_ARTIFACT_CHUNK_BYTES=String(size);
  const bytes=pdf(size*3+100),artifact=await beginArtifact(f.repo,f.env,{kind:'private',id:f.id});assert.equal(artifact.chunk_bytes,size);
  for(let index=0;index<4;index++)await uploadArtifactChunk(f.repo,f.env,artifact.id,index,bytesToBase64(bytes.subarray(index*size,(index+1)*size)));
  await assert.rejects(uploadArtifactChunk(f.repo,f.env,artifact.id,0,bytesToBase64(new Uint8Array(size+1))),error=>error.status===400||error.status===413);
  await completeArtifact(f.repo,f.env,artifact.id,{total_bytes:bytes.length,chunk_count:4,sha256:'0'.repeat(64)});assert.equal((await finish(f,artifact)).status,'ready');
  const row=await artifactById(f.repo,artifact.id),manifest=await verifiedValidationManifest(f.env,row,{complete:true});assert.equal(manifest.chunk_bytes,size);assert.equal(row.chunk_bytes,size);assert.deepEqual(await readArtifactBytes(f.repo,f.env,row),bytes);assert.deepEqual(await readValidatedArtifactChunk(f.repo,f.env,row,1),bytes.subarray(size,size*2));
  await assert.rejects(verifiedValidationManifest(f.env,{...row,chunk_bytes:PDF_CHUNK_BYTES},{complete:true}),/manifest changed/);
  // A changed deployment profile never changes an interrupted artifact's wire format.
  const second=await beginArtifact(f.repo,f.env,{kind:'public',locale:'en'});f.env.PDF_ARTIFACT_CHUNK_BYTES=String(PDF_CHUNK_BYTES);assert.equal((await beginArtifact(f.repo,f.env,{kind:'public',locale:'en'})).chunk_bytes,second.chunk_bytes);
});

test('staged completion freezes uploads and validates one chunk per resumable step without trusting the client whole digest',async t=>{
  const f=await fixture(t),{artifact,input,bytes}=await upload(f);
  const completed=await completeArtifact(f.repo,f.env,artifact.id,input);assert.equal(completed.status,'validating');
  assert.equal((await beginArtifact(f.repo,f.env,{kind:'private',id:f.id})).status,'validating');
  await assert.rejects(uploadArtifactChunk(f.repo,f.env,artifact.id,0,bytesToBase64(pdf(20))),/not pending/);
  assert.equal((await completeArtifact(f.repo,f.env,artifact.id,input)).status,'validating');
  await assert.rejects(completeArtifact(f.repo,f.env,artifact.id,{...input,total_bytes:input.total_bytes+1}),/already started/);
  const raw=f.db,queries=[];f.repo.db={prepare(sql){queries.push(sql);assert.doesNotMatch(sql,/FROM pdf_artifact_chunks WHERE artifact_id=\? ORDER BY/);return raw.prepare(sql);},batch:values=>raw.batch(values)};
  let first=await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);assert.deepEqual(first,{done:false,status:'validating',artifact_id:artifact.id,cursor:1,total:2});
  assert.equal(queries.filter(sql=>/^SELECT \* FROM pdf_artifact_chunks/.test(sql)).length,1);
  const halfway=await artifactById(f.repo,artifact.id),manifest=await verifiedValidationManifest(f.env,halfway);assert.equal(JSON.parse(manifest.ending).mode,'link','private PDF ending must remain encrypted');
  f.repo=new Repository(raw);f.env={...f.env};
  const second=await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);assert.equal(second.cursor,2);assert.equal(second.done,false);
  const finalQueries=[];f.repo.db={prepare(sql){finalQueries.push(sql);assert.doesNotMatch(sql,/FROM pdf_artifact_chunks/,'finalization must not reread PDF bytes');return raw.prepare(sql);},batch:values=>raw.batch(values)};
  const ready=await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);assert.equal(ready.status,'ready');assert.equal(ready.done,true);
  f.repo.db=raw;const row=await artifactById(f.repo,artifact.id);assert.equal(row.sha256,'0'.repeat(64));assert.match(row.manifest_sha256,/^[a-f0-9]{64}$/);assert.notEqual(row.manifest_sha256,row.sha256);
  assert.equal(row.validation_upload_revision,row.upload_revision);assert.equal(row.validation_bytes,bytes.length);
  assert.deepEqual(await readArtifactBytes(f.repo,f.env,row),bytes);assert.deepEqual(await readValidatedArtifactChunk(f.repo,f.env,row,1),bytes.subarray(PDF_CHUNK_BYTES));
  assert.equal((await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now)).status,'ready');
});

test('missing or modified chunks, altered manifests and a replayed artifact identity never become trusted',async t=>{
  const f=await fixture(t),{artifact,input}=await upload(f,pdf(80));await completeArtifact(f.repo,f.env,artifact.id,input);
  await f.db.prepare("UPDATE pdf_artifact_chunks SET payload='not ciphertext' WHERE artifact_id=?").bind(artifact.id).run();
  assert.equal((await finish(f,artifact)).status,'failed');
  const next=await upload(f,pdf(80));await completeArtifact(f.repo,f.env,next.artifact.id,next.input);assert.equal((await finish(f,next.artifact)).status,'ready');
  const row=await artifactById(f.repo,next.artifact.id);await verifiedValidationManifest(f.env,row,{complete:true});
  await assert.rejects(verifiedValidationManifest(f.env,{...row,source_revision:'another source'},{complete:true}),/manifest changed/);
  const changed=JSON.parse(row.validation_manifest);changed.parts[0].sha256='0'.repeat(64);const text=JSON.stringify(changed);
  await assert.rejects(verifiedValidationManifest(f.env,{...row,validation_manifest:text,manifest_sha256:await pdfDigest(new TextEncoder().encode(text))},{complete:true}),/authentication failed/);
  const altered=pdf(80);altered[20]=66;
  await f.db.prepare('UPDATE pdf_artifact_chunks SET payload=?,sha256=? WHERE artifact_id=?').bind(await buildStoredPayload({body:{plaintext:bytesToBase64(altered)},env:f.env}),await pdfDigest(altered),row.id).run();
  await assert.rejects(readValidatedArtifactChunk(f.repo,f.env,row,0),/metadata changed/);
});

test('concurrent validation steps advance a durable cursor once and final source CAS rejects a racing edit',async t=>{
  const f=await fixture(t),{artifact,input}=await upload(f,pdf(80));await completeArtifact(f.repo,f.env,artifact.id,input);
  await Promise.all([runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now),runArtifactValidationStep(f.repo,{...f.env},{artifact_id:artifact.id},f.now)]);
  assert.equal((await artifactById(f.repo,artifact.id)).validation_cursor,1);
  const raw=f.db;let raced=false;
  f.repo.db={prepare(sql){const statement=raw.prepare(sql);if(!sql.startsWith("UPDATE pdf_artifacts SET status='ready'"))return statement;return {bind(...values){const bound=statement.bind(...values);return {async run(){raced=true;await raw.prepare('UPDATE encrypted_items SET revision=revision+1 WHERE id=?').bind(f.id).run();return bound.run();}};}};},batch:values=>raw.batch(values)};
  const result=await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);assert.equal(raced,true);assert.notEqual(result.status,'ready');
  f.repo.db=raw;assert.equal((await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now)).status,'stale');
});

test('legacy ready artifacts remain readable and profile PDF caps are configurable above the default',async t=>{
  const f=await fixture(t);delete f.env.BACKGROUND_EXECUTION_MODE;const {artifact,input,bytes}=await upload(f,pdf(80));input.sha256=await pdfDigest(bytes);
  assert.equal((await completeArtifact(f.repo,f.env,artifact.id,input)).status,'ready');const row=await artifactById(f.repo,artifact.id);assert.equal(row.validation_algorithm,null);
  assert.deepEqual(await readValidatedArtifactChunk(f.repo,f.env,row,0),bytes);assert.deepEqual(await readArtifactBytes(f.repo,f.env,row),bytes);
  assert.equal(pdfByteLimit({}),8*1024*1024);assert.equal(pdfByteLimit({PDF_MAX_BYTES:12*1024*1024}),12*1024*1024);assert.equal(pdfByteLimit({PDF_MAX_BYTES:100*1024*1024}),64*1024*1024);
  const capArtifact=await beginArtifact(f.repo,{...f.env,PDF_MAX_BYTES:12*1024*1024},{kind:'public',locale:'en'});assert.equal(capArtifact.max_bytes,12*1024*1024);
});

test('metadata-only artifact contexts preserve source identity without materializing encrypted source text',async t=>{
  const f=await fixture(t),full=await artifactContext(f.repo,f.env,{kind:'private',id:f.id}),raw=f.db,queries=[];
  f.repo.getEncryptedItemForAdmin=()=>{throw Error('Metadata guard must not load ciphertext');};
  f.repo.db={prepare(sql){queries.push(sql);assert.doesNotMatch(sql,/SELECT (?:i|encrypted_items)\.\*/);return raw.prepare(sql);},batch:statements=>raw.batch(statements)};
  const metadata=await artifactContext(f.repo,f.env,{kind:'private',id:f.id,metadataOnly:true});
  for(const field of ['source_revision','layout_key','locale','item_id'])assert.equal(metadata[field],full[field]);
  assert.equal(metadata.item.access_mode,'link');assert.equal(metadata.item.encrypted_payload,undefined);assert.equal(metadata.item.delivery_version,full.item.delivery_version);
  assert.ok(queries.some(sql=>sql.includes('AS access_mode')));
  assert.equal((await pdfPreparationSource(f.repo,f.env,metadata)).options.body,'Saved source');
  await raw.prepare("UPDATE encrypted_items SET encrypted_payload='not json' WHERE id=?").bind(f.id).run();
  await assert.rejects(artifactContext(f.repo,f.env,{kind:'private',id:f.id,metadataOnly:true}),/manual delivery/);
});

test('public PDF source pages preserve every large Unicode field beyond the old total source cap',async t=>{
  const f=await fixture(t),groupId=await f.repo.farewell.createGroup({title:'Public chapter',now:f.now});
  const epigraph='😀题辞'.repeat(12000),bodies=['AB中文😀'.repeat(180000),'Second entry\n'.repeat(170000)];
  await f.repo.farewell.saveGroupDraft({id:groupId,title:'Public chapter',epigraph,now:f.now});
  const ids=[];for(const body of bodies)ids.push(await f.repo.farewell.createEntry({groupId,body,isPublic:true,now:f.now}));
  await f.repo.farewell.createEntry({groupId,body:'Private entry must stay private',isPublic:false,now:f.now});
  await f.repo.farewell.applyDraft({now:f.now});
  await assert.rejects(assertPublicPdfSourceSize(f.repo),/4 MiB/);await assertPublicPdfSourceSize(f.repo,f.env);
  const context=await artifactContext(f.repo,f.env,{kind:'public',locale:'en'}),fields=new Map();let cursor=null,pages=0,lastCursor;
  do{
    const page=await pdfPreparationSource(f.repo,f.env,context,{cursor});assert.equal(page.source_revision,context.source_revision);assert.equal(page.layout_key,context.layout_key);
    assert.ok(page.fragments.reduce((n,p)=>n+Buffer.byteLength(p.text),0)<=PDF_SOURCE_PAGE_BYTES);
    for(const fragment of page.fragments){const key=fragment.entry_id+':'+fragment.field,prior=fields.get(key)||'';assert.equal(fragment.offset,[...prior].length);fields.set(key,prior+fragment.text);}
    lastCursor=cursor;cursor=page.next_cursor;pages++;assert.ok(pages<1000);
  }while(cursor!==null);
  assert.ok(pages>20);assert.ok(bodies.reduce((n,body)=>n+Buffer.byteLength(body),0)>4*1024*1024);
  assert.equal(fields.get('0:display_title'),'Public chapter');assert.equal(fields.get('0:display_epigraph'),epigraph);
  for(let i=0;i<ids.length;i++)assert.equal(fields.get(ids[i]+':display_body'),bodies[i]);assert.equal(fields.size,4);
  await f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1 WHERE id=1').run();
  const newer=await artifactContext(f.repo,f.env,{kind:'public',locale:'en'});await assert.rejects(pdfPreparationSource(f.repo,f.env,newer,{cursor:lastCursor}),/source or layout changed/);
  await assert.rejects(pdfPreparationSource(f.repo,f.env,context),/source or layout changed/);
});
