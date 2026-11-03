// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {ensurePeopleLinks} from '../src/people.js';
import {buildStoredPayload,openStoredPayload,keyFingerprint} from '../src/content.js';
import {migrateContentKeys} from '../src/content-key-migration.js';
import {requiredBackupTables,restoreBackup,validateBackupShape} from '../scripts/restore-backup.mjs';
import {exportLocalBackup} from '../scripts/export-backup-local.mjs';
import {initialValidationManifest,appendValidationPart,authenticateValidationManifest,verifiedValidationManifest,digestPdfBytes,PDF_CHUNK_BYTES,PDF_MANIFEST_ALGORITHM} from '../src/pdf-validation.js';

const now='2026-10-23T00:00:00.000Z';
async function fixture(t){
  const db=database({through:24});t.after(()=>db.close());const repo=new Repository(db),env={CONTENT_ENCRYPTION_KEY:'synthetic-old-background-key'};
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const recipient=await repo.createRecipient({name:'Synthetic reader',email:'reader@example.invalid',now});await ensurePeopleLinks(db);
  const payload=await buildStoredPayload({body:{plaintext:'ORIGINAL_PRIVATE_TEXT'},env});
  const item=await repo.createEncryptedItem({kind:'letter',title:'Synthetic letter',recipientId:recipient,encryptedPayload:payload,payloadSize:payload.length,vaultToken:'synthetic-token',vaultTokenHash:'synthetic-hash',updatedAt:now});
  const dir=mkdtempSync(join(tmpdir(),'afterme-background-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {db,repo,env,item,dir};
}
async function job(f,index,state='running'){
  const payload=await buildStoredPayload({body:{plaintext:JSON.stringify({descriptor:{messageId:'synthetic-'+index},session:'https://upload.example.invalid/private-capability-'+index})},env:f.env});
  const checkpoint=await buildStoredPayload({body:{plaintext:JSON.stringify({uri:'https://upload.example.invalid/session-'+index,offset:index})},env:f.env});
  await f.db.prepare('INSERT INTO background_jobs(id,job_key,kind,confirmation_round,state,payload,checkpoint,lease_token,lease_until,attempt_id,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind('job-'+index,'synthetic-job-'+index,'mail-upload',1,state,payload,checkpoint,'synthetic-lease-'+index,now,'synthetic-attempt-'+index,now,now,now).run();
}
async function artifact(f,id,{ready=false}={}){
  const bytes=new Uint8Array(PDF_CHUNK_BYTES+64);bytes.fill(120);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));bytes.set(new TextEncoder().encode('\n%%EOF'),bytes.length-6);
  await f.db.prepare("INSERT INTO pdf_artifacts(id,kind,item_id,source_revision,layout_key,locale,status,total_bytes,chunk_count,upload_revision,sha256,created_at,updated_at) VALUES(?,'private',?,'source-v1','synthetic-layout','zh','pending',?,2,2,?,?,?)").bind(id,f.item,bytes.length,await digestPdfBytes(bytes),now,now).run();
  const chunks=[];for(let index=0;index<2;index++){
    const part=bytes.subarray(index*PDF_CHUNK_BYTES,(index+1)*PDF_CHUNK_BYTES),encoded=Buffer.from(part).toString('base64'),payload=await buildStoredPayload({body:{plaintext:encoded},env:f.env}),sha256=await digestPdfBytes(part);
    await f.db.prepare('INSERT INTO pdf_artifact_chunks(artifact_id,chunk_index,payload,sha256,byte_length) VALUES(?,?,?,?,?)').bind(id,index,payload,sha256,part.length).run();chunks.push({artifact_id:id,chunk_index:index,payload,sha256,byte_length:part.length});
  }
  const row={...await f.db.prepare('SELECT * FROM pdf_artifacts WHERE id=?').bind(id).first(),validation_state:'validating',validation_cursor:0,validation_upload_revision:2,validation_bytes:0,validation_algorithm:PDF_MANIFEST_ALGORITHM};
  let manifest=initialValidationManifest(row);for(let index=0;index<(ready?2:1);index++){manifest=await appendValidationPart(f.env,row,manifest,chunks[index]);row.validation_cursor++;row.validation_bytes+=chunks[index].byte_length;}
  if(ready){row.status='ready';row.validation_state='verified';}const auth=await authenticateValidationManifest(f.env,manifest);
  await f.db.prepare('UPDATE pdf_artifacts SET status=?,validation_state=?,validation_cursor=?,validation_upload_revision=?,validation_manifest=?,validation_algorithm=?,validation_bytes=?,validation_mac=?,manifest_sha256=? WHERE id=?').bind(row.status,row.validation_state,row.validation_cursor,row.validation_upload_revision,auth.text,row.validation_algorithm,row.validation_bytes,auth.mac,auth.sha256,id).run();
  return f.db.prepare('SELECT * FROM pdf_artifacts WHERE id=?').bind(id).first();
}
async function snapshot(f){const recovery_tables={};for(const table of requiredBackupTables(24))recovery_tables[table]=(await f.db.prepare('SELECT * FROM '+table).all()).results;return {schema_version:24,includes_payloads:true,format_version:2,recovery_tables};}

test('schema 24 restores content but drops every derived job/session and resets incomplete PDF verification',async t=>{
  const f=await fixture(t);for(const [index,state] of ['pending','running','completed','cancelled','failed','uncertain'].entries())await job(f,index,state);
  await artifact(f,'incomplete');await artifact(f,'ready',{ready:true});
  for(const status of ['sending','uncertain'])await f.db.prepare('INSERT INTO mail_claims(dedupe_key,status,claimed_at,attempt_id,provider_message_id,provider_thread_id) VALUES(?,?,?,?,?,?)').bind('synthetic-'+status,status,now,'attempt-'+status,'message-'+status,'thread-'+status).run();
  const backup=await snapshot(f),input=join(f.dir,'backup.json'),output=join(f.dir,'restored.sqlite');writeFileSync(input,JSON.stringify(backup));const result=await restoreBackup(input,output,f.env);assert.equal(result.ok,true);assert.equal(result.schema_version,24);assert.equal(result.release_suspended,true);
  const db=new DatabaseSync(output,{readOnly:true});try{
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM background_jobs').get().count,0);
    for(const status of ['sending','uncertain']){const row=db.prepare('SELECT * FROM mail_claims WHERE dedupe_key=?').get('synthetic-'+status);assert.equal(row.status,status);assert.equal(row.attempt_id,'attempt-'+status);assert.equal(row.provider_message_id,'message-'+status);assert.equal(row.provider_thread_id,'thread-'+status);}
    const pending=db.prepare("SELECT * FROM pdf_artifacts WHERE id='incomplete'").get();assert.equal(pending.status,'pending');assert.equal(pending.validation_cursor,0);assert.equal(pending.validation_bytes,0);for(const name of ['validation_state','validation_upload_revision','validation_manifest','validation_algorithm','validation_mac','manifest_sha256'])assert.equal(pending[name],null,name);
    const ready=db.prepare("SELECT * FROM pdf_artifacts WHERE id='ready'").get();assert.equal(ready.status,'ready');await verifiedValidationManifest(f.env,ready,{complete:true});
    const owner=db.prepare('SELECT * FROM owner').get();assert.equal(owner.release_suspended,1);assert.equal(owner.confirmation_round,backup.recovery_tables.owner[0].confirmation_round+1);assert.equal(owner.last_checkin_at,now);
  }finally{db.close();}
  const second=join(f.dir,'second.json');assert.equal((await exportLocalBackup(output,second)).schema_version,24);assert.deepEqual(JSON.parse(readFileSync(second,'utf8')).recovery_tables.background_jobs,[]);
});

test('schema 24 backup validation rejects missing jobs, plaintext job state and unauthenticated PDF manifests',async t=>{
  const f=await fixture(t);await job(f,1);await artifact(f,'authenticated',{ready:true});const original=await snapshot(f);
  const missing=structuredClone(original);delete missing.recovery_tables.background_jobs;assert.throws(()=>validateBackupShape(missing),/background_jobs/);
  const plaintext=structuredClone(original);plaintext.recovery_tables.background_jobs[0].payload='{"session":"https://upload.example.invalid/private"}';assert.throws(()=>validateBackupShape(plaintext),/后台任务/);
  for(const mutate of [b=>b.recovery_tables.pdf_artifacts[0].validation_mac='0'.repeat(64),b=>b.recovery_tables.pdf_artifacts[0].validation_manifest=b.recovery_tables.pdf_artifacts[0].validation_manifest.replace('source-v1','modified-source'),b=>b.recovery_tables.pdf_artifacts[0].validation_cursor=0]){
    const backup=structuredClone(original);mutate(backup);const input=join(f.dir,crypto.randomUUID()+'.json'),output=join(f.dir,crypto.randomUUID()+'.sqlite');writeFileSync(input,JSON.stringify(backup));await assert.rejects(restoreBackup(input,output,f.env));assert.equal(existsSync(output),false);
  }
});

test('bounded key rotation migrates encrypted job state and authenticates ready/partial manifests with the new key only',async t=>{
  const f=await fixture(t);for(let index=0;index<3;index++)await job(f,index);await artifact(f,'partial');await artifact(f,'ready',{ready:true});
  const changed={...f.env,CONTENT_ENCRYPTION_KEY:'synthetic-new-background-key',LEGACY_CONTENT_ENCRYPTION_KEY:f.env.CONTENT_ENCRYPTION_KEY},current={...changed,LEGACY_CONTENT_ENCRYPTION_KEY:undefined};let cursors={cursor:0,artifact_cursor:0,job_cursor:0,manifest_cursor:0},pages=0,result;
  do{result=await migrateContentKeys(f.repo,changed,{...cursors,limit:1});assert.equal(result.conflicts,0);assert.equal(result.ok,true);assert.ok(result.migrated<=1,'one shared row budget across all content types');for(const key of Object.keys(cursors)){assert.ok(result[key]>=cursors[key]);cursors[key]=result[key];}assert.ok(++pages<20);}while(result.has_more);
  assert.ok(pages>1);const fingerprint=await keyFingerprint(current.CONTENT_ENCRYPTION_KEY);
  for(const row of (await f.db.prepare('SELECT * FROM background_jobs').all()).results)for(const key of ['payload','checkpoint']){assert.equal(JSON.parse(row[key]).key_id,fingerprint);assert.ok((await openStoredPayload(row[key],current)).plaintext.includes('synthetic')||(await openStoredPayload(row[key],current)).plaintext.includes('upload.example.invalid'));}
  for(const row of (await f.db.prepare('SELECT * FROM pdf_artifacts').all()).results){const manifest=await verifiedValidationManifest(current,row,{complete:row.status==='ready'});if(manifest.ending){assert.equal(JSON.parse(manifest.ending).key_id,fingerprint);assert.ok((await openStoredPayload(manifest.ending,current)).plaintext);}}
  for(const row of (await f.db.prepare('SELECT payload FROM pdf_artifact_chunks').all()).results)assert.ok((await openStoredPayload(row.payload,current)).plaintext);
});

test('a concurrent job checkpoint wins over key-rotation CAS and can be retried',async t=>{
  const f=await fixture(t);await job(f,0);const changed={...f.env,CONTENT_ENCRYPTION_KEY:'synthetic-new-background-key',LEGACY_CONTENT_ENCRYPTION_KEY:f.env.CONTENT_ENCRYPTION_KEY},replacement=await buildStoredPayload({body:{plaintext:'CONCURRENT_CHECKPOINT'},env:f.env}),prepare=f.db.prepare.bind(f.db);let injected=false;
  f.db.prepare=sql=>{if(!injected&&sql.startsWith('UPDATE background_jobs SET payload=')){injected=true;prepare("UPDATE background_jobs SET checkpoint=? WHERE id='job-0'").bind(replacement).run();}return prepare(sql);};
  const first=await migrateContentKeys(f.repo,changed,{cursor:f.item,limit:1});assert.equal(first.ok,false);assert.equal(first.conflicts,1);assert.equal((await openStoredPayload((await f.db.prepare("SELECT checkpoint FROM background_jobs WHERE id='job-0'").first()).checkpoint,f.env)).plaintext,'CONCURRENT_CHECKPOINT');
  const second=await migrateContentKeys(f.repo,changed,{cursor:f.item,limit:1});assert.equal(second.ok,true);const row=await f.db.prepare("SELECT checkpoint FROM background_jobs WHERE id='job-0'").first();assert.equal((await openStoredPayload(row.checkpoint,{CONTENT_ENCRYPTION_KEY:changed.CONTENT_ENCRYPTION_KEY})).plaintext,'CONCURRENT_CHECKPOINT');
});
