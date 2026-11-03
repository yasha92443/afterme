// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {buildStoredPayload} from '../src/content.js';
import {beginArtifact,uploadArtifactChunk,completeArtifact,runArtifactValidationStep,artifactById,pdfDigest} from '../src/pdf-artifacts.js';
import {pdfPreviewDescriptor,pdfPreviewChunk} from '../src/pdf-download.js';
import worker from '../src/worker.js';

async function fixture(t){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),now='2030-01-01T00:00:00.000Z',env={CONTENT_ENCRYPTION_KEY:'synthetic-download-content',BACKGROUND_EXECUTION_MODE:'staged',PDF_MAX_BYTES:String(16*1024*1024)};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const recipientId=await repo.createRecipient({name:'Reader',email:'reader@example.invalid',now});
  const id=await repo.createEncryptedItem({kind:'letter',title:'',recipientId,encryptedPayload:await buildStoredPayload({body:{plaintext:'Private saved source'},env}),payloadSize:20,vaultToken:'fixture',vaultTokenHash:'fixture',updatedAt:now});
  return {db,repo,env,id,now};
}
const pdf=size=>{const bytes=new Uint8Array(size).fill(65);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));bytes.set(new TextEncoder().encode('%%EOF\n'),size-6);return bytes;};
async function ready(f,{kind='private',id=f.id,bytes=pdf(131100),legacy=false}={}){
  const artifact=await beginArtifact(f.repo,f.env,{kind,id});
  for(let index=0;index<Math.ceil(bytes.length/artifact.chunk_bytes);index++)await uploadArtifactChunk(f.repo,f.env,artifact.id,index,Buffer.from(bytes.subarray(index*artifact.chunk_bytes,(index+1)*artifact.chunk_bytes)).toString('base64'));
  const digest=await pdfDigest(bytes),env=legacy?{...f.env,BACKGROUND_EXECUTION_MODE:undefined}:f.env;
  await completeArtifact(f.repo,env,artifact.id,{total_bytes:bytes.length,chunk_count:Math.ceil(bytes.length/artifact.chunk_bytes),sha256:digest});
  for(let i=0;i<Math.ceil(bytes.length/artifact.chunk_bytes)+2&&!legacy;i++){const step=await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);if(step.done)break;}
  return {row:await artifactById(f.repo,artifact.id),bytes};
}
const request=(descriptor,index)=>({artifact_id:descriptor.artifact_id,index,upload_revision:descriptor.upload_revision,pin:descriptor.manifest_sha256||descriptor.sha256});

test('preview descriptors load only metadata and a greater-than-8MiB artifact is read as bounded authenticated chunks',async t=>{
  const f=await fixture(t),{row,bytes}=await ready(f,{bytes:pdf(9*1024*1024+17)}),raw=f.db,queries=[];
  f.repo.getEncryptedItemForAdmin=()=>{throw Error('Preview metadata must not load the letter ciphertext');};
  f.repo.db={prepare(sql){queries.push(sql);if(/FROM pdf_artifact_chunks/i.test(sql))assert.match(sql,/chunk_index\s*=\s*\?/i,'preview cannot read every PDF chunk');return raw.prepare(sql);},batch:values=>raw.batch(values)};
  const descriptor=await pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id});assert.equal(descriptor.artifact_id,row.id);assert.equal(descriptor.total_bytes,bytes.length);assert.equal(queries.some(sql=>/FROM pdf_artifact_chunks/i.test(sql)),false);
  queries.length=0;
  const index=descriptor.chunk_count-1,response=await pdfPreviewChunk(f.repo,f.env,request(descriptor,index));assert.equal(response.headers.get('Content-Type'),'application/octet-stream');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-AfterMe-Artifact'),row.id);assert.equal(response.headers.get('X-AfterMe-Chunk'),String(index));
  const tail=new Uint8Array(await response.arrayBuffer());assert.deepEqual(tail,bytes.subarray(index*descriptor.chunk_bytes));assert.ok(tail.length<=descriptor.chunk_bytes);assert.equal(queries.filter(sql=>/FROM pdf_artifact_chunks/i.test(sql)).length,1);
});

test('the final descriptor rejects a changed source while immutable chunks never mix artifact epochs',async t=>{
  const f=await fixture(t);await ready(f);const descriptor=await pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id});
  await f.db.prepare('UPDATE encrypted_items SET revision=revision+1 WHERE id=?').bind(f.id).run();
  await assert.rejects(pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id}),{status:409});
  // A pinned old artifact can finish an in-flight read, but no current descriptor
  // can authorize displaying it after the source changed.
  const old=await pdfPreviewChunk(f.repo,f.env,request(descriptor,0));assert.equal(old.status,200);
  await f.db.prepare("UPDATE pdf_artifacts SET status='stale' WHERE id=?").bind(descriptor.artifact_id).run();
  await assert.rejects(pdfPreviewChunk(f.repo,f.env,request(descriptor,0)),{status:409});
});

test('chunk identity, revision, manifest authentication and ciphertext must all match',async t=>{
  const f=await fixture(t);await ready(f);const descriptor=await pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id});
  for(const bad of [{...request(descriptor,0),pin:'f'.repeat(64)},{...request(descriptor,0),upload_revision:descriptor.upload_revision+1},request(descriptor,descriptor.chunk_count)])await assert.rejects(pdfPreviewChunk(f.repo,f.env,bad),{status:409});
  for(const bad of [{...request(descriptor,0),index:-1},{...request(descriptor,0),upload_revision:''},{...request(descriptor,0),upload_revision:null},{...request(descriptor,0),pin:'invalid'}])await assert.rejects(pdfPreviewChunk(f.repo,f.env,bad),{status:400});
  await f.db.prepare("UPDATE pdf_artifact_chunks SET payload='corrupted encrypted block' WHERE artifact_id=? AND chunk_index=0").bind(descriptor.artifact_id).run();
  await assert.rejects(pdfPreviewChunk(f.repo,f.env,request(descriptor,0)));
});

test('public and legacy prepared files retain their original integrity identities',async t=>{
  const f=await fixture(t),{bytes}=await ready(f,{kind:'public',id:0,legacy:true}),descriptor=await pdfPreviewDescriptor(f.repo,f.env,{kind:'public'});
  assert.equal(descriptor.manifest_sha256,null);assert.equal(descriptor.sha256,await pdfDigest(bytes));
  const chunks=[];for(let index=0;index<descriptor.chunk_count;index++)chunks.push(Buffer.from(await(await pdfPreviewChunk(f.repo,f.env,request(descriptor,index))).arrayBuffer()));
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(bytes));
});

test('passphrase and non-letter items cannot bypass the private preview rules',async t=>{
  const f=await fixture(t);await f.db.prepare("UPDATE encrypted_items SET encrypted_payload=? WHERE id=?").bind(JSON.stringify({v:2,mode:'passphrase',payload:'opaque'}),f.id).run();
  await assert.rejects(pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id}),{status:409});
  await f.db.prepare("UPDATE encrypted_items SET kind='task',encrypted_payload=? WHERE id=?").bind(await buildStoredPayload({body:{plaintext:'Not a letter'},env:f.env}),f.id).run();
  await assert.rejects(pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id}),{status:404});
});

test('manifest-backed artifacts cannot be silently downgraded to legacy chunk-only verification',async t=>{
  const f=await fixture(t);await ready(f);const descriptor=await pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id});
  await f.db.prepare('UPDATE pdf_artifacts SET validation_algorithm=NULL WHERE id=?').bind(descriptor.artifact_id).run();
  await assert.rejects(pdfPreviewChunk(f.repo,f.env,request(descriptor,0)),{status:409});
  await assert.rejects(pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id}),{status:409});
});

test('preview follows each artifact stored block size instead of assuming the former 128KiB default',async t=>{
  for(const chunkBytes of [16384,32768,65536,131072]){
    const f=await fixture(t);f.env.PDF_ARTIFACT_CHUNK_BYTES=String(chunkBytes);const {bytes}=await ready(f,{bytes:pdf(chunkBytes+17)}),descriptor=await pdfPreviewDescriptor(f.repo,f.env,{kind:'private',id:f.id});assert.equal(descriptor.chunk_bytes,chunkBytes);
    const response=await pdfPreviewChunk(f.repo,f.env,request(descriptor,1));assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes.subarray(chunkBytes));
  }
});

test('worker descriptor and chunk routes require current admin authorization and preserve immutable binary pins',async t=>{
  const f=await fixture(t),{bytes}=await ready(f),allow={async limit(){return {success:true};}};
  const env={...f.env,DB:f.db,ADMIN_TOKEN:'synthetic-preview-admin',MAIL_PROVIDER:'dry-run',LOGIN_LIMITER:allow,API_LIMITER:allow,READ_LIMITER:allow,VERIFY_LIMITER:allow,EXPENSIVE_LIMITER:allow};
  const call=(path,{method='GET',body,headers={}}={})=>worker.fetch(new Request('https://example.test'+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),env);
  const input={kind:'private',id:f.id},preview='/api/pdf-artifacts/preview';
  assert.equal((await call(preview,{method:'POST',body:input})).status,401);
  const bearer={Authorization:'Bearer '+env.ADMIN_TOKEN},resolved=await call(preview,{method:'POST',body:input,headers:bearer});assert.equal(resolved.status,200);
  const descriptor=await resolved.json(),path='/api/pdf-artifacts/'+descriptor.artifact_id+'/chunks/0?revision='+descriptor.upload_revision+'&pin='+descriptor.manifest_sha256;
  assert.equal((await call(path)).status,401);
  const response=await call(path,{headers:bearer});assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes.subarray(0,descriptor.chunk_bytes));assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await call(path.replace(descriptor.manifest_sha256,'f'.repeat(64)),{headers:bearer})).status,409);
  const login=await call('/api/session',{method:'POST',body:{admin_token:env.ADMIN_TOKEN}}),cookie=login.headers.get('Set-Cookie').split(';')[0],session=await login.json();
  assert.equal((await call(preview,{method:'POST',body:input,headers:{Cookie:cookie}})).status,403);
  const headers={Cookie:cookie,'X-CSRF-Token':session.csrf};assert.equal((await call(preview,{method:'POST',body:input,headers})).status,200);assert.equal((await call(path,{headers})).status,200);
  await f.db.prepare('UPDATE admin_sessions SET revoked_at=?').bind(Date.now()).run();
  assert.equal((await call(path,{headers})).status,401,'each chunk reauthenticates the current session');
});
