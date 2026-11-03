// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {defaultRules} from '../src/settings.js';
import {buildStoredPayload} from '../src/content.js';
import {beginArtifact,uploadArtifactChunk,completeArtifact,runArtifactValidationStep,artifactById,pdfDigest,readValidatedArtifactRange} from '../src/pdf-artifacts.js';
import {runDiscoveryStage,stagedMailAllowed,stagedAttachmentRange} from '../src/staged-runtime.js';
import {claimJob,openJobValue} from '../src/background-jobs.js';

const anchor='2030-01-01T00:00:00.000Z',now='2030-01-10T00:00:00.000Z',chunkBytes=128*1024;
function pdf(size=64){const bytes=Uint8Array.from({length:size},(_,index)=>index%251);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));bytes.set(new TextEncoder().encode('\n%%EOF\n'),size-7);return bytes;}
async function fixture(t,kind='private',{legacy=false,size=64,requestedChunkBytes=chunkBytes}={}){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),env={CONTENT_ENCRYPTION_KEY:'synthetic-mail-query-key',BACKGROUND_EXECUTION_MODE:'staged',PDF_GENERATION_MODE:'browser',PDF_ARTIFACT_CHUNK_BYTES:String(requestedChunkBytes),MAIL_PROVIDER:'gmail',INBOUND_PROVIDER:'gmail',MAIL_INBOUND_ENABLED:'true'};
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now:anchor});
  const verifier=await repo.createContact({name:'Verifier',email:'verifier@example.invalid',role:'friend',priority:1,tokenHash:'synthetic'}),recipient=await repo.createRecipient({name:'Recipient',email:'recipient@example.invalid',now:anchor});
  const settings=await repo.getSettings(env),rules=defaultRules([verifier]);rules.private.quorum=1;rules.public.quorum=1;rules.private.grace_hours=0;rules.public.grace_hours=0;rules.public.audience=['contact:'+verifier];
  await repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,selfcheck:false},rules,now:anchor});await repo.checkin(anchor);
  const owner=await repo.getOwner();await repo.updateOwnerState('PUBLIC_RELEASE',anchor,owner.confirmation_round);await repo.rotateContactToken({id:verifier,tokenHash:'synthetic-current',expectedRound:owner.confirmation_round});await repo.createConfirmation({contactId:verifier,status:'confirmed_death',round:owner.confirmation_round,now:anchor});
  await repo.upsertPublicFarewell({title:'Synthetic public',body:'',status:'PUBLIC_RELEASE',now:anchor});await db.prepare('UPDATE release_progress SET ready_at=?,released_at=? WHERE round=?').bind(anchor,anchor,owner.confirmation_round).run();
  let item=0;
  if(kind==='private'){const stored=await buildStoredPayload({body:{plaintext:'Saved synthetic letter'},env});item=await repo.createEncryptedItem({kind:'letter',title:'Synthetic',recipientId:recipient,encryptedPayload:stored,payloadSize:stored.length,vaultToken:'synthetic',vaultTokenHash:'synthetic',updatedAt:anchor});await db.prepare('UPDATE encrypted_items SET released_at=? WHERE id=?').bind(anchor,item).run();}
  const bytes=pdf(size),artifact=await beginArtifact(repo,env,{kind,id:item,locale:'zh'}),blockBytes=artifact.chunk_bytes;assert.equal(blockBytes,requestedChunkBytes);
  for(let index=0;index*blockBytes<size;index++)await uploadArtifactChunk(repo,env,artifact.id,index,Buffer.from(bytes.subarray(index*blockBytes,(index+1)*blockBytes)).toString('base64'));
  await completeArtifact(repo,legacy?{...env,BACKGROUND_EXECUTION_MODE:undefined}:env,artifact.id,{total_bytes:size,chunk_count:Math.ceil(size/blockBytes),sha256:await pdfDigest(bytes)});
  if(!legacy)for(let step=0;step<=Math.ceil(size/blockBytes);step++)await runArtifactValidationStep(repo,env,{artifact_id:artifact.id},now);
  const ready=await artifactById(repo,artifact.id);assert.equal(ready.status,'ready');
  await repo.setCursor('background-discovery',kind==='private'?'1':'2');assert.equal((await runDiscoveryStage(repo,env,now)).created,true);
  const job=await claimJob(repo,{now,kind:'mail'}),payload=await openJobValue(env,job.payload);
  await repo.setCursor('background-inbox',JSON.stringify({round:owner.confirmation_round,generation_id:'synthetic-current',started_at:now,completed_at:now,status:'healthy',closed:true}));
  return {db,repo,env,kind,verifier,recipient,item,owner,rules,ready,bytes,job,payload};
}
async function measured(f,callback){
  const original=f.repo.db,queries=[],stats={roundtrips:0,statements:0},native=new WeakMap();
  function wrap(raw){const statement={bind(...values){return wrap(raw.bind(...values));},async first(){stats.roundtrips++;stats.statements++;return raw.first();},async all(){stats.roundtrips++;stats.statements++;return raw.all();},async run(){stats.roundtrips++;stats.statements++;return raw.run();}};native.set(statement,raw);return statement;}
  f.repo.db={prepare(sql){queries.push(sql);return wrap(original.prepare(sql));},async batch(statements){stats.roundtrips++;stats.statements+=statements.length;return original.batch(statements.map(statement=>native.get(statement)||statement));}};
  try{return {value:await callback(),queries,...stats};}finally{f.repo.db=original;}
}

for(const kind of ['private','public'])test(kind+' base and final guards retain the whole decision in one database round trip',async t=>{
  const f=await fixture(t,kind);
  for(const method of ['getOwner','getRoundRules','privateDeliveryAllowed','publicDeliveryAllowed'])f.repo[method]=()=>{throw Error('The merged guard must not issue separate '+method+' reads');};
  for(const final of [false,true]){const result=await measured(f,()=>stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final}));assert.equal(result.value,true);assert.equal(result.roundtrips,1);assert.equal(result.statements,1);assert.equal(result.queries.length,1);}
  await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,generation_id:'synthetic-backlog',started_at:now,status:'scanning',completed_at:null}));
  assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final:false}),true,'non-final preparation can continue while inbox is scanning');
  assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final:true}),false,'final dispatch must wait for a full healthy generation');
});

for(const kind of ['private','public'])test(kind+' merged guard keeps leases, round, quorum, source and artifact fences',async t=>{
  const changes=['lease','expiry','round','state','pause','suspended','progress','channel','quorum','verifier-active','verifier-round','vote','settings','owner-name','artifact-status','artifact-epoch','artifact-source','artifact-layout','artifact-locale','artifact-kind','artifact-item','manifest','algorithm','authentication','validation-cursor','validation-bytes'];
  for(const change of changes){
    const f=await fixture(t,kind);assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final:false}),true,change+' baseline');
    const query=(sql,...values)=>f.db.prepare(sql).bind(...values).run();
    if(change==='lease')f.job.lease_token='another-owner';
    if(change==='expiry')await query('UPDATE background_jobs SET lease_until=? WHERE id=?',now,f.job.id);
    if(change==='round')await query('UPDATE owner SET confirmation_round=confirmation_round+1 WHERE id=1');
    if(change==='state')await query("UPDATE owner SET state='NORMAL' WHERE id=1");
    if(change==='pause')await query("UPDATE owner SET pause_mode='manual' WHERE id=1");
    if(change==='suspended')await query('UPDATE owner SET release_suspended=1 WHERE id=1');
    if(change==='progress')await query('UPDATE release_progress SET released_at=NULL WHERE channel=?',kind);
    if(change==='channel')await query("UPDATE round_rules SET rules_json=json_set(rules_json,?,0) WHERE round=?",'$.'+kind+'.enabled',f.owner.confirmation_round);
    if(change==='quorum')await query("UPDATE round_rules SET rules_json=json_set(rules_json,?,2) WHERE round=?",'$.'+kind+'.quorum',f.owner.confirmation_round);
    if(change==='verifier-active')await query('UPDATE contacts SET active=0 WHERE id=?',f.verifier);
    if(change==='verifier-round')await query('UPDATE contacts SET verification_round=NULL WHERE id=?',f.verifier);
    if(change==='vote')await query("UPDATE confirmation_votes SET status='unable_to_reach'");
    if(change==='settings')await query('UPDATE user_settings SET revision=revision+1 WHERE id=1');
    if(change==='owner-name')await query("UPDATE owner SET display_name='Changed' WHERE id=1");
    if(change==='artifact-status')await query("UPDATE pdf_artifacts SET status='stale' WHERE id=?",f.ready.id);
    if(change==='artifact-epoch')await query('UPDATE pdf_artifacts SET upload_revision=upload_revision+1 WHERE id=?',f.ready.id);
    if(change==='artifact-source')await query("UPDATE pdf_artifacts SET source_revision='changed' WHERE id=?",f.ready.id);
    if(change==='artifact-layout')await query("UPDATE pdf_artifacts SET layout_key='changed' WHERE id=?",f.ready.id);
    if(change==='artifact-locale')await query("UPDATE pdf_artifacts SET locale='en' WHERE id=?",f.ready.id);
    if(change==='artifact-kind')await query('UPDATE pdf_artifacts SET kind=? WHERE id=?',kind==='private'?'public':'private',f.ready.id);
    if(change==='artifact-item')await query('UPDATE pdf_artifacts SET item_id=item_id+1 WHERE id=?',f.ready.id);
    if(change==='manifest')await query('UPDATE pdf_artifacts SET manifest_sha256=? WHERE id=?','f'.repeat(64),f.ready.id);
    if(change==='algorithm')await query('UPDATE pdf_artifacts SET validation_algorithm=NULL WHERE id=?',f.ready.id);
    if(change==='authentication')await query("UPDATE pdf_artifacts SET validation_state='validating' WHERE id=?",f.ready.id);
    if(change==='validation-cursor')await query('UPDATE pdf_artifacts SET validation_cursor=0 WHERE id=?',f.ready.id);
    if(change==='validation-bytes')await query('UPDATE pdf_artifacts SET validation_bytes=0 WHERE id=?',f.ready.id);
    const result=await measured(f,()=>stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final:false}));assert.equal(result.value,false,kind+' '+change);assert.equal(result.roundtrips,1,change);
  }
});

test('private source and recipient changes cannot authorize an old prepared letter',async t=>{
  for(const change of ['delivery','revision','updated','recipient-active','recipient-email','recipient-name','recipient-locale','revoked','unreleased']){
    const f=await fixture(t),sql={delivery:'UPDATE encrypted_items SET delivery_version=delivery_version+1 WHERE id=?',revision:'UPDATE encrypted_items SET revision=revision+1 WHERE id=?',updated:"UPDATE encrypted_items SET updated_at='2030-01-09T00:00:00.000Z' WHERE id=?",'recipient-active':'UPDATE recipients SET active=0 WHERE id=?','recipient-email':"UPDATE recipients SET email='changed@example.invalid' WHERE id=?",'recipient-name':"UPDATE recipients SET name='Changed' WHERE id=?",'recipient-locale':"UPDATE recipients SET locale='en' WHERE id=?",revoked:'UPDATE encrypted_items SET revoked_at=? WHERE id=?',unreleased:'UPDATE encrypted_items SET released_at=NULL WHERE id=?'}[change];
    await f.db.prepare(sql).bind(...(change==='revoked'?[now,f.item]:[change.startsWith('recipient-')?f.recipient:f.item])).run();
    assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final:false}),false,change);
  }
});
test('public delivery retains its frozen audience, PDF channel, formal revision and current mail language',async t=>{
  for(const change of ['audience','pdf','revision','updated','locale','email']){
    const f=await fixture(t,'public');
    if(change==='audience')await f.db.prepare("UPDATE round_rules SET rules_json=json_set(rules_json,'$.public.audience',json('[]'))").run();
    if(change==='pdf')await f.db.prepare("UPDATE round_rules SET rules_json=json_set(rules_json,'$.public.pdf',0)").run();
    if(change==='revision')await f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1').run();
    if(change==='updated')await f.db.prepare("UPDATE public_farewell SET updated_at='2030-01-09T00:00:00.000Z'").run();
    if(change==='locale')await f.db.prepare("UPDATE contacts SET locale='en' WHERE id=?").bind(f.verifier).run();
    if(change==='email')await f.db.prepare("UPDATE contacts SET email='changed@example.invalid' WHERE id=?").bind(f.verifier).run();
    assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now,{final:false}),false,change);
  }
});
test('final authorization rejects stale, wrong-round, malformed and blocked inbox state in the same query',async t=>{
  for(const change of ['old-start','future-completion','old-round','malformed','failed','processing']){
    const f=await fixture(t,'public'),state={round:f.owner.confirmation_round,generation_id:'synthetic-current',started_at:now,completed_at:now,status:'healthy'};
    if(change==='old-start')state.started_at=anchor;if(change==='future-completion')state.completed_at='2030-01-10T00:01:00.000Z';if(change==='old-round')state.round--;
    await f.repo.setCursor('background-inbox',change==='malformed'?'not JSON':JSON.stringify(state));
    if(['failed','processing'].includes(change))await f.db.prepare("INSERT INTO inbound_mail_log(gmail_message_id,status,processed_at,confirmation_round,source) VALUES('synthetic-blocker',?,?,?,'gmail')").bind(change,now,f.owner.confirmation_round).run();
    const result=await measured(f,()=>stagedMailAllowed(f.repo,f.env,f.job,f.payload,{},now));assert.equal(result.value,false,change);assert.equal(result.roundtrips,1);
  }
});

for(const legacy of [false,true])test((legacy?'legacy':'authenticated')+' PDF ranges read one batch and verify only their bounded covering chunks',async t=>{
  const f=await fixture(t,'private',{legacy,size:3*chunkBytes+19}),start=chunkBytes-23,length=192*1024;
  const result=await measured(f,()=>stagedAttachmentRange(f.repo,f.env,f.job,f.payload,{},start,length));
  assert.deepEqual(result.value,f.bytes.subarray(start,start+length));assert.equal(result.roundtrips,1);assert.equal(result.statements,2);assert.equal(result.queries.filter(sql=>/FROM pdf_artifact_chunks/.test(sql)).length,1);assert.match(result.queries[1],/LIMIT 18/);
  await f.db.prepare("UPDATE pdf_artifact_chunks SET payload='modified' WHERE artifact_id=? AND chunk_index=1").bind(f.ready.id).run();
  await assert.rejects(stagedAttachmentRange(f.repo,f.env,f.job,f.payload,{},start,length),/PDF|encrypted|JSON|密钥|decrypt/i);
});
for(const blockBytes of [16*1024,32*1024,64*1024,128*1024])test(blockBytes+' byte PDF chunks remain bound while one batch reads a maximum-sized unaligned range',async t=>{
  const f=await fixture(t,'private',{size:3*chunkBytes+19,requestedChunkBytes:blockBytes}),start=blockBytes-13,length=256*1024;
  const payload={...f.payload,artifactChunkBytes:blockBytes};
  assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,payload,{},now),true);
  const result=await measured(f,()=>stagedAttachmentRange(f.repo,f.env,f.job,payload,{},start,length));assert.deepEqual(result.value,f.bytes.subarray(start,start+length));assert.equal(result.roundtrips,1);assert.equal(result.statements,2);
  const unbound=await stagedAttachmentRange(f.repo,f.env,f.job,{...f.payload,artifactChunkBytes:undefined},{},start,length);assert.deepEqual(unbound,result.value,'earlier jobs can infer a stored block size without a reference field');
  const different=blockBytes===32*1024?64*1024:32*1024,changed={...payload,artifactChunkBytes:different};
  assert.equal(await stagedMailAllowed(f.repo,f.env,f.job,changed,{},now),false);await assert.rejects(stagedAttachmentRange(f.repo,f.env,f.job,changed,{},start,length),/PDF artifact changed/);
});
test('range reads bind the artifact epoch and authenticated algorithm without silently falling back to legacy',async t=>{
  for(const change of ['epoch','manifest','algorithm','missing-chunk','changed-digest']){
    const f=await fixture(t,'private',{size:chunkBytes+31});
    if(change==='epoch')f.payload.artifactRevision++;
    if(change==='manifest')f.payload.manifest='e'.repeat(64);
    if(change==='algorithm')await f.db.prepare('UPDATE pdf_artifacts SET validation_algorithm=NULL WHERE id=?').bind(f.ready.id).run();
    if(change==='missing-chunk')await f.db.prepare('DELETE FROM pdf_artifact_chunks WHERE artifact_id=? AND chunk_index=1').bind(f.ready.id).run();
    if(change==='changed-digest')await f.db.prepare('UPDATE pdf_artifact_chunks SET sha256=? WHERE artifact_id=? AND chunk_index=1').bind('e'.repeat(64),f.ready.id).run();
    await assert.rejects(stagedAttachmentRange(f.repo,f.env,f.job,f.payload,{},chunkBytes-7,25),/PDF|artifact|chunk/i,change);
  }
});
test('an old schema23 ready PDF can still be read without requiring chunk or manifest columns',async t=>{
  const db=database({through:23});t.after(()=>db.close());const repo=new Repository(db),env={CONTENT_ENCRYPTION_KEY:'synthetic-range-legacy'},bytes=pdf(chunkBytes+11),id=crypto.randomUUID();
  await db.prepare("INSERT INTO pdf_artifacts(id,kind,item_id,source_revision,layout_key,locale,status,total_bytes,chunk_count,upload_revision,sha256,created_at,updated_at) VALUES(?,'private',1,'synthetic','synthetic','zh','ready',?,2,1,?,?,?)").bind(id,bytes.length,await pdfDigest(bytes),anchor,anchor).run();
  for(let index=0;index<2;index++){const part=bytes.subarray(index*chunkBytes,(index+1)*chunkBytes),payload=await buildStoredPayload({body:{plaintext:Buffer.from(part).toString('base64')},env});await db.prepare('INSERT INTO pdf_artifact_chunks(artifact_id,chunk_index,payload,sha256,byte_length) VALUES(?,?,?,?,?)').bind(id,index,payload,await pdfDigest(part),part.length).run();}
  assert.deepEqual(await readValidatedArtifactRange(repo,env,{artifact_id:id,upload_revision:1,manifest_sha256:null},chunkBytes-5,16),bytes.subarray(chunkBytes-5));
});
test('invalid or oversized ranges fail before reading stored PDF bytes',async()=>{
  const repo={db:{batch(){assert.fail('Invalid ranges must not query');}}},reference={artifact_id:'synthetic',upload_revision:1,manifest_sha256:null};
  for(const [start,length] of [[-1,1],[0,256*1024+1],[0,-1],[Number.MAX_SAFE_INTEGER,1]])await assert.rejects(readValidatedArtifactRange(repo,{},reference,start,length),/Invalid PDF range/);
  await assert.rejects(readValidatedArtifactRange(repo,{}, {...reference,chunk_bytes:1},0,1),/Invalid PDF range/);
});
