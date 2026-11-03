// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import worker from '../src/worker.js';
import {startVerificationProof} from '../src/verification-security.js';
import {backupCryptoFactory} from '../src/backup-crypto.js';
import {restoreBackup,requiredBackupTables} from '../scripts/restore-backup.mjs';
import {checkConfiguration} from '../scripts/setup-guided.mjs';
import {beginEnrollment,finishEnrollment,totp,consumeFactor,securityState} from '../src/mfa.js';
import {migrateContentKeys} from '../src/content-key-migration.js';
import {buildStoredPayload,openStoredPayload} from '../src/content.js';
import {rateLimit} from '../src/request-security.js';

const allow={async limit(){return {success:true};}};
function temp(t){const dir=mkdtempSync(join(tmpdir(),'afterme-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
async function fixture(t,{through=23}={}){const db=database({through});t.after(()=>db.close());const repo=new Repository(db),env={DB:db,ADMIN_TOKEN:'fixture-admin',CONTENT_ENCRYPTION_KEY:'fixture-content',MAIL_PROVIDER:'dry-run',MAX_DAILY_EMAILS:'100',LOGIN_LIMITER:allow,API_LIMITER:allow,VERIFY_LIMITER:allow,EXPENSIVE_LIMITER:allow,READ_LIMITER:allow};await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:new Date().toISOString()});if(through>=18){await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());}return {db,repo,env};}
async function snapshot(f,version){const rows={};for(const name of requiredBackupTables(version))rows[name]=(await f.db.prepare('SELECT * FROM '+name).all()).results;return {schema_version:version,includes_payloads:true,recovery_tables:rows};}

test('parallel code requests reserve at most three slots without wasting the global budget',async t=>{
 const f=await fixture(t);await f.repo.createContact({name:'Contact',email:'contact@example.invalid',role:'contact',priority:1,tokenHash:'fixture-token'});await f.repo.rotateContactToken({id:1,tokenHash:'fixture-token'});await f.repo.updateOwnerState('VERIFY',new Date().toISOString(),1);
 const owner=await f.repo.getOwner(),contact=await f.repo.getContact(1);let sends=0;const provider={name:'fixture',async send(){sends++;return {status:'sent'};}};
 await Promise.allSettled(Array.from({length:12},()=>startVerificationProof({...f,owner,contact,provider})));
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM verification_challenges').first()).count,3);
 assert.equal((await f.db.prepare('SELECT count FROM verification_code_budget').first()).count,3);assert.ok(sends>=1&&sends<=3);
});
test('public health and reading routes fail before database access when their binding is missing or denies',async()=>{
 let queries=0;const DB={prepare(){queries++;throw Error('DB must not be reached');}},deny={async limit(){return {success:false};}};
 for(const path of ['/health/operational','/farewell','/vault/fixture']){
  const missing=await worker.fetch(new Request('https://example.test'+path),{DB});assert.equal(missing.status,503);
  const denied=await worker.fetch(new Request('https://example.test'+path),{DB,READ_LIMITER:deny});assert.equal(denied.status,429);
 }
 // Error aggregation may attempt one diagnostic INSERT, but route queries never run.
 assert.ok(queries<=2);
});
test('setup validates all five bindings and accepts the five-minute schedule',()=>{
 const config=readFileSync(new URL('../wrangler.example.toml',import.meta.url),'utf8').replace('00000000-0000-4000-8000-000000000000',crypto.randomUUID());assert.equal(checkConfiguration(config).ok,true);
 assert.equal(checkConfiguration(config.replace(/crons = \["[^"]+"\]/,'crons = ["*/5 * * * *"]')).ok,true);
 for(const name of ['LOGIN_LIMITER','VERIFY_LIMITER','EXPENSIVE_LIMITER','API_LIMITER','READ_LIMITER'])assert.equal(checkConfiguration(config.replace('name = "'+name+'"','name = "REMOVED"')).ok,false);
 assert.equal(checkConfiguration(config.replace('MAX_DAILY_EMAILS = "20"','MAX_DAILY_EMAILS = "20"\nALLOW_LOCAL_RATE_LIMIT_FALLBACK = "true"')).ok,false);
 assert.equal(checkConfiguration(config.replace('"nodejs_compat"','"removed"')).ok,false);
 assert.equal(checkConfiguration(config.replace('PDF_GENERATION_MODE = "browser"','PDF_GENERATION_MODE = "server"')).ok,false);
});
test('local fallback requires an explicit environment opt-in even on loopback',async()=>{
 const request=new Request('http://127.0.0.1/api/settings');await assert.rejects(rateLimit(request,{}),error=>error.status===503);await rateLimit(request,{ALLOW_LOCAL_RATE_LIMIT_FALLBACK:'true'});
});
test('unrelated requests and invalid states do not terminate the loopback OAuth callback listener',async t=>{
 const dir=temp(t),probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['scripts/gmail-oauth.mjs'],{windowsHide:true,env:{...process.env,GMAIL_CLIENT_ID:'fixture-client',GMAIL_CLIENT_SECRET:'fixture-secret',GMAIL_OAUTH_PORT:String(port),GMAIL_OAUTH_OUTPUT:join(dir,'credentials.local.json'),GMAIL_OAUTH_URL_OUTPUT:join(dir,'url.local'),GMAIL_OAUTH_CODE_OUTPUT:join(dir,'code.local')},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('OAuth fixture did not become ready')),5000);child.stdout.on('data',chunk=>{if(String(chunk).includes('Listening on')){clearTimeout(timer);resolve();}});child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);reject(Error('OAuth fixture exited before becoming ready'));});});
 let unrelated;try{unrelated=await fetch('http://127.0.0.1:'+port+'/favicon.ico');}catch(error){if(['EACCES','EPERM'].includes(error.cause?.code)){t.skip('Host does not permit loopback connections');return;}throw error;}
 assert.equal(unrelated.status,404);await new Promise(resolve=>setTimeout(resolve,650));assert.equal((await fetch('http://127.0.0.1:'+port+'/oauth2callback?state=invalid')).status,400);assert.equal(existsSync(join(dir,'code.local')),false);assert.equal(existsSync(join(dir,'credentials.local.json')),false);
});
for(const version of [16,17,18,19,20,21,22,23,24])test('actual schema '+version+' restores and passes application smoke checks',async t=>{
 const f=await fixture(t,{through:version}),dir=temp(t),file=join(dir,'backup.json'),out=join(dir,'restored.sqlite');
 if(version>=21){const now=new Date().toISOString(),id=await f.repo.farewell.createGroup({title:'Unapplied fixture',now});await f.repo.farewell.createEntry({groupId:id,body:'Unapplied body',isPublic:true,now});assert.equal((await f.repo.farewell.getVersions()).pending_count,2);}
 writeFileSync(file,JSON.stringify(await snapshot(f,version)));
 const result=await restoreBackup(file,out,f.env);assert.equal(result.application_smoke_verified,true);assert.equal(result.release_suspended,true);assert.equal(result.network_used,false);
});
test('incomplete tables, singleton records and malformed rules fail closed without an output file',async t=>{
 const f=await fixture(t),original=await snapshot(f,22),dir=temp(t);const cases=[b=>delete b.recovery_tables.user_settings,b=>b.recovery_tables.owner=[],b=>b.recovery_tables.admin_security=[],b=>b.recovery_tables.farewell_document_versions=[],b=>delete b.recovery_tables.farewell_document_versions[0].pending_count,b=>b.recovery_tables.farewell_document_versions[0].pending_count=-1,b=>b.recovery_tables.farewell_document_versions[0].pending_count='0',b=>b.recovery_tables.farewell_document_versions[0].pending_count=1,b=>b.recovery_tables.user_settings[0].active_rules_json='{}',b=>b.recovery_tables.round_rules=[]];
 for(let i=0;i<cases.length;i++){const value=structuredClone(original);cases[i](value);const file=join(dir,'invalid-'+i+'.json'),out=join(dir,'invalid-'+i+'.sqlite');writeFileSync(file,JSON.stringify(value));await assert.rejects(restoreBackup(file,out,f.env));assert.equal(existsSync(out),false);}
});
test('authenticated chunk envelopes reject reorder, removal, duplication and header changes across UTF-8 boundaries',async()=>{
 const c=backupCryptoFactory(),password='chunk fixture passphrase',data={text:'文🙂'.repeat(360000)},envelope=await c.encrypt(data,password);assert.ok(envelope.chunks.length>2);assert.deepEqual(await c.decrypt(envelope,password),data);
 for(const altered of [{...envelope,chunks:[...envelope.chunks].reverse()},{...envelope,chunks:envelope.chunks.slice(1)},{...envelope,chunks:[envelope.chunks[0],envelope.chunks[0],...envelope.chunks.slice(2)]},{...envelope,plaintext_bytes:envelope.plaintext_bytes-1}])await assert.rejects(c.decrypt(altered,password));
});
test('legacy version-one encrypted envelopes remain readable',async()=>{
 const password='legacy fixture password',salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),b64=b=>Buffer.from(b).toString('base64'),header={format:'afterme-encrypted-backup',version:1,kdf:{name:'PBKDF2',hash:'SHA-256',iterations:600000,salt:b64(salt)},cipher:{name:'AES-GCM',iv:b64(iv)}};
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']),key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:600000,salt},material,{name:'AES-GCM',length:256},false,['encrypt']);const data={legacy:true},cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(JSON.stringify(header))},key,new TextEncoder().encode(JSON.stringify(data)));
 assert.deepEqual(await backupCryptoFactory().decrypt({...header,ciphertext:b64(cipher)},password),data);
});
test('bounded content-key rotation includes active MFA, pending enrollment and private PDF chunks',async t=>{
 const f=await fixture(t),enrollment=await beginEnrollment(f.env);await finishEnrollment(f.env,{enrollment_id:enrollment.enrollment_id,code:await totp(enrollment.secret,Math.floor(Date.now()/30000)),acknowledged:true});
 const pending=await buildStoredPayload({body:{plaintext:'pending fixture secret'},env:f.env});await f.db.prepare('UPDATE admin_security SET pending_payload=? WHERE id=1').bind(pending).run();
 await f.repo.createRecipient({name:'Reader',email:'reader@example.invalid',now:new Date().toISOString()});
 for(let i=0;i<3;i++){const payload=await buildStoredPayload({body:{plaintext:'Fixture '+i},env:f.env});await f.repo.createEncryptedItem({kind:'letter',title:'Fixture',recipientId:1,releaseStage:'PRIVATE_RELEASE',encryptedPayload:payload,pdfPayload:null,payloadSize:payload.length,vaultToken:'token-'+i,vaultTokenHash:'hash-'+i,updatedAt:new Date().toISOString()});}
 const now=new Date().toISOString();await f.db.prepare("INSERT INTO pdf_artifacts(id,kind,item_id,source_revision,layout_key,locale,status,created_at,updated_at) VALUES('fixture','private',1,'0','layout','zh','pending',?,?)").bind(now,now).run();await f.db.prepare("INSERT INTO pdf_artifact_chunks(artifact_id,chunk_index,payload,sha256,byte_length) VALUES('fixture',0,?,'hash',1)").bind(await buildStoredPayload({body:{plaintext:'YQ=='},env:f.env})).run();
 const changed={...f.env,CONTENT_ENCRYPTION_KEY:'new-fixture-content',LEGACY_CONTENT_ENCRYPTION_KEY:f.env.CONTENT_ENCRYPTION_KEY};let cursor=0,artifact_cursor=0,pages=0,result;do{result=await migrateContentKeys(f.repo,changed,{cursor,artifact_cursor,limit:1});cursor=result.cursor;artifact_cursor=result.artifact_cursor;pages++;assert.equal(result.conflicts,0);}while(result.has_more);assert.equal(pages,4);
 const current={...changed,LEGACY_CONTENT_ENCRYPTION_KEY:undefined};assert.equal(await consumeFactor(current,await totp(enrollment.secret,Math.floor(Date.now()/30000)+1)),true);assert.equal((await openStoredPayload((await securityState(current)).pending_payload,current)).plaintext,'pending fixture secret');
 for(const row of (await f.db.prepare('SELECT encrypted_payload FROM encrypted_items').all()).results)assert.match((await openStoredPayload(row.encrypted_payload,current)).plaintext,/Fixture/);assert.equal((await openStoredPayload((await f.db.prepare('SELECT payload FROM pdf_artifact_chunks').first()).payload,current)).plaintext,'YQ==');
});
test('backup verify CLI requires and reports completed application smoke checks',async t=>{
 const f=await fixture(t),dir=temp(t),file=join(dir,'complete.json');writeFileSync(file,JSON.stringify(await snapshot(f,22)));const result=spawnSync(process.execPath,['scripts/verify-backup.mjs',file],{encoding:'utf8',env:{...process.env,CONTENT_ENCRYPTION_KEY:f.env.CONTENT_ENCRYPTION_KEY},windowsHide:true});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).application_smoke_verified,true);
});
