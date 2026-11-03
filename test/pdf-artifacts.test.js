// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import worker from '../src/worker.js';
import {buildPrivateLetterPdf,bytesToBase64} from './helpers/pdf-fonts.js';
import {artifactContext,beginArtifact,uploadArtifactChunk,completeArtifact,pdfDigest,preparedPdf,pruneObsoleteArtifacts,PDF_CHUNK_BYTES} from '../src/pdf-artifacts.js';
import {cachedPrivatePdf} from '../src/pdf-cache.js';
import {defaultRules} from '../src/settings.js';
import {runScheduledCheck,deliverPublicFarewell} from '../src/worker.js';
import {createInvocationBudget} from '../src/invocation-budget.js';
const allow={async limit(){return {success:true};}};
async function fixture(t){
  const db=database();t.after(()=>db.close());const repo=new Repository(db);
  const env={DB:db,ADMIN_TOKEN:'artifact-test-password',CONTENT_ENCRYPTION_KEY:'artifact-test-content-key',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',PDF_GENERATION_MODE:'browser',LOGIN_LIMITER:allow,API_LIMITER:allow,READ_LIMITER:allow,VERIFY_LIMITER:allow,EXPENSIVE_LIMITER:allow,PDF_FONTS:{async fetch(){throw Error('font offline');}}};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:new Date().toISOString()});
  const recipientId=await repo.createRecipient({name:'Recipient',email:'reader@example.invalid',now:new Date().toISOString()});
  const call=(path,body,method)=>worker.fetch(new Request('https://example.test'+path,{method:method||(body===undefined?'GET':'POST'),headers:{Authorization:'Bearer '+env.ADMIN_TOKEN,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env);
  const response=await call('/api/items',{recipient_id:recipientId,plaintext:'Saved even when the font service is unavailable. 中文。'});
  assert.equal(response.status,201);const saved=await response.json();return {db,repo,env,call,id:saved.id,recipientId};
}
async function upload(repo,env,target,bytes){
  const artifact=await beginArtifact(repo,env,target);
  for(let i=0;i<Math.ceil(bytes.length/PDF_CHUNK_BYTES);i++)await uploadArtifactChunk(repo,env,artifact.id,i,bytesToBase64(bytes.subarray(i*PDF_CHUNK_BYTES,(i+1)*PDF_CHUNK_BYTES)));
  return {artifact,manifest:{total_bytes:bytes.length,chunk_count:Math.ceil(bytes.length/PDF_CHUNK_BYTES),sha256:await pdfDigest(bytes)}};
}
test('font failure never blocks text saves and browser PDFs are encrypted and atomically ready',async t=>{
  const {db,repo,env,call,id,recipientId}=await fixture(t),item=await repo.getEncryptedItemForAdmin(id);
  assert.equal(item.pdf_payload,null);
  const bytes=buildPrivateLetterPdf({body:'Saved even when the font service is unavailable. 中文。',ownerName:'Example',recipientName:'Recipient',updatedAt:item.updated_at});
  const {artifact,manifest}=await upload(repo,env,{kind:'private',id},bytes);
  assert.equal((await beginArtifact(repo,env,{kind:'private',id})).id,artifact.id,'interrupted upload resumes its artifact');
  await assert.rejects(cachedPrivatePdf(repo,env,item,await repo.getOwner()),/preparation is pending/);
  const chunks=(await db.prepare('SELECT * FROM pdf_artifact_chunks WHERE artifact_id=?').bind(artifact.id).all()).results;
  assert.ok(chunks.every(c=>!c.payload.includes('%PDF')&&JSON.parse(c.payload).mode==='link'));
  assert.equal((await completeArtifact(repo,env,artifact.id,manifest)).status,'ready');
  assert.deepEqual((await cachedPrivatePdf(repo,env,item,await repo.getOwner())).bytes,bytes);
  assert.equal((await beginArtifact(repo,env,{kind:'private',id})).status,'ready');
  const updated=await call('/api/items/'+id,{recipient_id:recipientId,plaintext:'A newer saved letter',expected_revision:item.revision});
  assert.equal(updated.status,200);assert.equal((await updated.json()).pdf_status,'pending');
  await assert.rejects(completeArtifact(repo,env,artifact.id,manifest),/source or layout changed/);
});
test('incomplete, changed and corrupt artifact chunks cannot become deliverable',async t=>{
  const {db,repo,env,id}=await fixture(t),bytes=buildPrivateLetterPdf({body:'A'.repeat(30000),ownerName:'Example'}),{artifact,manifest}=await upload(repo,env,{kind:'private',id},bytes);
  await assert.rejects(completeArtifact(repo,env,artifact.id,{...manifest,sha256:'0'.repeat(64)}),/validation failed/);
  const last=manifest.chunk_count-1;
  const original=await db.prepare('SELECT * FROM pdf_artifact_chunks WHERE artifact_id=? AND chunk_index=?').bind(artifact.id,last).first();
  await db.prepare('DELETE FROM pdf_artifact_chunks WHERE artifact_id=? AND chunk_index=?').bind(artifact.id,last).run();
  await assert.rejects(completeArtifact(repo,env,artifact.id,manifest),/incomplete/);
  await db.prepare('INSERT INTO pdf_artifact_chunks(artifact_id,chunk_index,payload,sha256,byte_length) VALUES(?,?,?,?,?)').bind(artifact.id,last,original.payload,original.sha256,original.byte_length).run();
  await completeArtifact(repo,env,artifact.id,manifest);
  await assert.rejects(uploadArtifactChunk(repo,env,artifact.id,0,bytesToBase64(bytes.subarray(0,100))),/not pending/);
  await db.prepare("UPDATE pdf_artifact_chunks SET sha256=? WHERE artifact_id=? AND chunk_index=0").bind('0'.repeat(64),artifact.id).run();
  assert.equal(await preparedPdf(repo,env,await artifactContext(repo,env,{kind:'private',id})),null);
  assert.equal((await db.prepare('SELECT status FROM pdf_artifacts WHERE id=?').bind(artifact.id).first()).status,'failed');
});

test('a chunk write concurrent with completion cannot publish unvalidated bytes',async t=>{
  const {repo,env,id}=await fixture(t),bytes=buildPrivateLetterPdf({body:'Concurrent upload',ownerName:'Example'}),{artifact,manifest}=await upload(repo,env,{kind:'private',id},bytes);
  let raced=false;
  const guardedRepo=Object.create(repo);
  guardedRepo.db={prepare(sql){const statement=repo.db.prepare(sql);if(!sql.startsWith("UPDATE pdf_artifacts SET status='ready'"))return statement;return {bind(...values){const bound=statement.bind(...values);return {async run(){raced=true;await uploadArtifactChunk(repo,env,artifact.id,0,bytesToBase64(bytes.subarray(0,Math.min(bytes.length,PDF_CHUNK_BYTES))));return bound.run();}};}};}};
  await assert.rejects(completeArtifact(guardedRepo,env,artifact.id,manifest),/source changed during upload/);
  assert.equal(raced,true);assert.equal((await repo.db.prepare('SELECT status FROM pdf_artifacts WHERE id=?').bind(artifact.id).first()).status,'pending');
});

test('artifact pruning is bounded and preserves the current ready file and other languages',async t=>{
  const {db,repo,env,id}=await fixture(t),context=await artifactContext(repo,env,{kind:'private',id});
  const old=new Date(Date.now()-8*86400000).toISOString();
  for(const [suffix,source,locale] of [['old1','obsolete','zh'],['old2','obsolete','zh'],['old3','obsolete','zh'],['current',context.source_revision,'zh'],['english','obsolete','en']]){
    await db.prepare("INSERT INTO pdf_artifacts(id,kind,item_id,source_revision,layout_key,locale,status,created_at,updated_at) VALUES(?,'private',?,?,?,?, 'ready',?,?)").bind(suffix,id,source,context.layout_key,locale,old,old).run();
  }
  const result=await pruneObsoleteArtifacts(repo,context);assert.equal(result.meta.changes,2);
  const remaining=(await db.prepare('SELECT id FROM pdf_artifacts').all()).results.map(r=>r.id);
  assert.equal(remaining.length,3);assert.ok(remaining.includes('current'));assert.ok(remaining.includes('english'));
});

test('a public PDF missing in one language does not block other prepared languages',async t=>{
  const {repo,env}=await fixture(t),now=new Date().toISOString();
  const zh=await repo.createContact({name:'Chinese reader',email:'zh@example.invalid',role:'friend',priority:1,tokenHash:'zh',locale:'zh'});
  const en=await repo.createContact({name:'English reader',email:'en@example.invalid',role:'friend',priority:2,tokenHash:'en',locale:'en'});
  await repo.db.prepare("UPDATE contacts SET locale='en' WHERE id=?").bind(en).run();
  const settings=await repo.getSettings(env),rules=defaultRules([zh,en]);rules.public.audience=['contact:'+zh,'contact:'+en];
  await repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules,now});await repo.checkin(now);
  await repo.upsertPublicFarewell({title:'Public',body:'',status:'DRAFT',now});
  const bytes=buildPrivateLetterPdf({body:'Public fixture',ownerName:'Example'}),{artifact,manifest}=await upload(repo,env,{kind:'public',locale:'en'},bytes);await completeArtifact(repo,env,artifact.id,manifest);
  repo.publicDeliveryAllowed=async()=>true;
  const sent=[],provider={name:'capture',async send(message){sent.push(message.to);return {status:'sent'};}};
  const results=await deliverPublicFarewell(repo,env,now,await repo.getOwner(),provider);
  assert.ok(results.some(r=>r.contact_id===zh&&r.reason==='pdf-not-ready'));assert.deepEqual(sent,['en@example.invalid']);
  const document=await repo.getPublicFarewell(),version=(await repo.farewell.getVersions()).formal_revision;
  await repo.db.prepare("INSERT INTO mail_claims(dedupe_key,status,claimed_at) VALUES(?,'uncertain',?)").bind(`public_farewell_release:v2:${version}:${document.updated_at}:contact:${zh}:zh@example.invalid`,now).run();
  const raw=repo.db;repo.db={prepare(sql){assert.doesNotMatch(sql,/SELECT \* FROM pdf_artifact/,'terminal deliveries must not read, decrypt or hash a PDF again');return raw.prepare(sql);},batch:statements=>raw.batch(statements)};
  const completed=await deliverPublicFarewell(repo,env,now,await repo.getOwner(),provider);assert.ok(completed.every(row=>row.reason==='dedupe'));assert.equal(sent.length,1);
});
test('artifact HTTP endpoints require authorization and chunk byte limits',async t=>{
  const {env,call,id}=await fixture(t);
  const denied=await worker.fetch(new Request('https://example.test/api/pdf-artifacts/targets'),env);assert.equal(denied.status,401);
  const created=await call('/api/pdf-artifacts',{kind:'private',id});assert.equal(created.status,201);const artifact=await created.json();
  const source=await call('/api/pdf-artifacts/'+artifact.id+'/source');assert.equal(source.status,200);assert.match((await source.json()).options.body,/Saved even/);
  const oversized=await call('/api/pdf-artifacts/'+artifact.id+'/chunks/0',{data:bytesToBase64(new Uint8Array(PDF_CHUNK_BYTES+1))},'PUT');assert.ok([400,413].includes(oversized.status));
  const missing=await call('/api/pdf-artifacts/'+artifact.id+'/complete',{total_bytes:20,chunk_count:1,sha256:'0'.repeat(64)});assert.equal(missing.status,409);
});
test('prepared browser artifacts are actually delivered across bounded scheduled batches',async t=>{
  const {repo,env,id}=await fixture(t),bytes=buildPrivateLetterPdf({body:'Prepared browser delivery',ownerName:'Example'}),{artifact,manifest}=await upload(repo,env,{kind:'private',id},bytes);
  await completeArtifact(repo,env,artifact.id,manifest);
  const anchor='2030-01-01T00:00:00.000Z',now='2030-01-10T00:00:00.000Z';
  const contactId=await repo.createContact({name:'C',email:'c@example.invalid',role:'friend',priority:1,tokenHash:'initial'});
  const settings=await repo.getSettings(env),rules=defaultRules([contactId]);rules.private.quorum=1;rules.private.grace_hours=0;rules.public.enabled=false;
  await repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules,now:anchor});await repo.checkin(anchor);
  const owner=await repo.getOwner();await repo.updateOwnerState('VERIFY',now,owner.confirmation_round);await repo.rotateContactToken({id:contactId,tokenHash:'current'});await repo.createConfirmation({contactId,status:'confirmed_death',round:owner.confirmation_round,now});
  const sent=[];const provider={name:'capture',async send(message){if(message.attachments?.length)sent.push(message);return {status:'sent'};}};
  for(let tick=0;tick<20&&sent.length===0;tick++){
    const budget=createInvocationBudget();await runScheduledCheck(repo,{...env,INVOCATION_BUDGET:budget},new Date(Date.parse(now)+tick*300000),provider);assert.ok(budget.usedStatements<=48);
  }
  assert.equal(sent.length,1,'ready browser artifact must not starve behind repeated release bookkeeping');assert.deepEqual(sent[0].attachments[0].data,bytes);
  await runScheduledCheck(repo,env,new Date(Date.parse(now)+21*300000),provider);assert.equal(sent.length,1);
});
