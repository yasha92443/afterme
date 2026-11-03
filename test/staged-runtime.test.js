// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {defaultRules} from '../src/settings.js';
import {buildStoredPayload} from '../src/content.js';
import {beginArtifact,uploadArtifactChunk,completeArtifact,runArtifactValidationStep,artifactById,pdfDigest} from '../src/pdf-artifacts.js';
import {enqueueJob,claimJob,openJobValue} from '../src/background-jobs.js';
import {runBackgroundTick,inboxAllowsDelivery} from '../src/background-scheduler.js';
import {runControlStage,runInboxStage,runReleaseStage,runDiscoveryStage,queueConfirmationNotice,runNoticeStage,prepareStagedMessage,stagedMailAllowed,recordStagedResult} from '../src/staged-runtime.js';

const anchor='2030-01-01T00:00:00.000Z',now='2030-01-10T00:00:00.000Z';
const time=minutes=>new Date(Date.parse(now)+minutes*60000).toISOString();
async function fixture(t,{released=true,state=released?'PUBLIC_RELEASE':'VERIFY'}={}){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),env={CONTENT_ENCRYPTION_KEY:'synthetic-staged-runtime-key',PDF_GENERATION_MODE:'browser',BACKGROUND_EXECUTION_MODE:'staged',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',BASE_URL:'https://example.invalid',FROM_EMAIL:'sender@example.invalid'};
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now:anchor});
  for(let index=1;index<=3;index++)await repo.createContact({name:'Contact '+index,email:`c${index}@example.invalid`,role:'friend',priority:index,tokenHash:'synthetic-'+index});
  await db.prepare("UPDATE contacts SET locale='en' WHERE id=2").run();await db.prepare("UPDATE contacts SET locale='ru' WHERE id=3").run();
  const recipient=await repo.createRecipient({name:'Private reader',email:'private@example.invalid',now:anchor});
  const settings=await repo.getSettings(env),rules=defaultRules([1]);rules.private.quorum=1;rules.public.quorum=1;rules.private.grace_hours=0;rules.public.grace_hours=0;rules.public.audience=['contact:1','contact:2'];
  await repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,selfcheck:false},rules,now:anchor});await repo.checkin(anchor);let owner=await repo.getOwner();
  await repo.updateOwnerState(state,anchor,owner.confirmation_round);await repo.rotateContactToken({id:1,tokenHash:'synthetic-current',expectedRound:owner.confirmation_round});await repo.createConfirmation({contactId:1,status:'confirmed_death',round:owner.confirmation_round,now:anchor});
  await repo.upsertPublicFarewell({title:'Synthetic public',body:'',status:released?'PUBLIC_RELEASE':'DRAFT',now:anchor});
  if(released)await db.prepare('UPDATE release_progress SET ready_at=?,released_at=? WHERE round=?').bind(anchor,anchor,owner.confirmation_round).run();
  owner=await repo.getOwner();return {db,repo,env,owner,rules,recipient};
}
async function letter(f,text='SYNTHETIC_PRIVATE_TEXT'){
  const payload=await buildStoredPayload({body:{plaintext:text},env:f.env});const id=await f.repo.createEncryptedItem({kind:'letter',title:'Synthetic letter',recipientId:f.recipient,encryptedPayload:payload,payloadSize:payload.length,vaultToken:crypto.randomUUID(),vaultTokenHash:crypto.randomUUID(),updatedAt:anchor});await f.db.prepare('UPDATE encrypted_items SET released_at=? WHERE id=?').bind(anchor,id).run();return id;
}
async function readyPdf(f,input){
  const bytes=new TextEncoder().encode('%PDF-1.7\n% Synthetic PDF fixture\n%%EOF\n'),artifact=await beginArtifact(f.repo,f.env,input);await uploadArtifactChunk(f.repo,f.env,artifact.id,0,Buffer.from(bytes).toString('base64'));await completeArtifact(f.repo,f.env,artifact.id,{total_bytes:bytes.length,chunk_count:1,sha256:await pdfDigest(bytes)});
  for(let index=0;index<4;index++){const row=await artifactById(f.repo,artifact.id);if(row.status==='ready')return row;await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},now);}assert.fail('Synthetic PDF did not become ready');
}
async function discover(f,kind){await f.repo.setCursor('background-discovery',String({transition:0,private:1,public:2}[kind]));return runDiscoveryStage(f.repo,f.env,now);}
async function mails(f){const rows=(await f.db.prepare("SELECT * FROM background_jobs WHERE kind='mail' ORDER BY rowid").all()).results;return Promise.all(rows.map(async row=>({...row,data:await openJobValue(f.env,row.payload)})));}
async function frozen(f,edit){const rules=structuredClone(f.rules);edit(rules);await f.db.prepare('UPDATE round_rules SET rules_json=? WHERE round=?').bind(JSON.stringify(rules),f.owner.confirmation_round).run();f.rules=rules;}
async function claimedPrivate(f){const id=await letter(f);await readyPdf(f,{kind:'private',id});await discover(f,'private');const job=await claimJob(f.repo,{kind:'mail',now});return {id,job,p:await openJobValue(f.env,job.payload)};}

test('missing private PDFs rotate without blocking a later prepared letter or reading original ciphertext',async t=>{
  const f=await fixture(t),first=await letter(f,'FIRST'),second=await letter(f,'SECOND');await readyPdf(f,{kind:'private',id:second});
  f.repo.getEncryptedItemForAdmin=()=>{throw Error('Discovery must read metadata only');};
  assert.equal((await discover(f,'private')).pending,true);assert.equal((await discover(f,'private')).created,true);
  let jobs=await mails(f);assert.equal(jobs.length,1);assert.equal(jobs[0].data.item.id,second);assert.equal(jobs[0].dedupe_key,`private_letter_release:v2:${second}:0:private@example.invalid`);assert.notEqual(jobs[0].job_key,jobs[0].dedupe_key);
  await readyPdf(f,{kind:'private',id:first});await discover(f,'private');jobs=await mails(f);assert.deepEqual(jobs.map(job=>job.data.item.id),[second,first]);assert.equal(new Set(jobs.map(job=>job.dedupe_key)).size,2);
});

test('a missing public locale rotates to another ready recipient and its cursor follows the formal version',async t=>{
  const f=await fixture(t);await readyPdf(f,{kind:'public',locale:'en'});assert.equal((await discover(f,'public')).pending,true);assert.equal((await discover(f,'public')).created,true);const jobs=await mails(f);assert.equal(jobs.length,1);assert.equal(jobs[0].data.contact.audience_key,'contact:2');assert.equal(jobs[0].data.source.locale,'en');
  const oldCursor=jobs[0].data.contact.cursor_key;assert.equal(await f.repo.getCursor(oldCursor),'contact:2');await f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1').run();await discover(f,'public');
  const keys=(await f.db.prepare("SELECT key,value FROM runtime_cursors WHERE key LIKE 'background-discovery-public:%' ORDER BY key").all()).results;assert.equal(keys.length,2);assert.equal(keys.find(row=>row.key!==oldCursor).value,'contact:1');
});

test('discovery reads frozen enabled memberships and ignores pending rule changes',async t=>{
  const f=await fixture(t,{state:'VERIFY'});await frozen(f,rules=>{rules.private.enabled=false;rules.private.contact_ids=[1];rules.public.contact_ids=[2];});
  const settings=await f.repo.getSettings(f.env),pending=structuredClone(f.rules);pending.private.enabled=true;pending.private.contact_ids=[3];pending.public.contact_ids=[3];await f.repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules:pending,now});
  await discover(f,'transition');await discover(f,'transition');const jobs=await mails(f);assert.equal(jobs.length,1);assert.equal(jobs[0].data.contact.id,2);assert.equal(jobs[0].data.state,'VERIFY');
  await frozen(f,rules=>{rules.public.enabled=false;});await letter(f);assert.equal((await discover(f,'private')).skipped,true);assert.equal((await discover(f,'public')).skipped,true);assert.equal((await mails(f)).length,1);
});

test('paused or disabled contact notifications do not discover transition jobs',async t=>{
  const f=await fixture(t,{state:'VERIFY'});f.env.CONTACT_NOTIFICATIONS_ENABLED=' FALSE ';assert.equal((await discover(f,'transition')).skipped,true);await f.repo.pause({mode:'manual',until:now,now});assert.equal((await runDiscoveryStage(f.repo,f.env,now)).skipped,true);assert.equal((await mails(f)).length,0);
});

test('control advances state without sending mail and records the actual new round after a concurrent check-in',async t=>{
  const f=await fixture(t,{released:false,state:'NORMAL'});const result=await runControlStage(f.repo,f.env,time(0));assert.equal(result.to,'VERIFY');assert.equal((await mails(f)).length,0);
  await f.repo.checkin(anchor);const before=await f.repo.getOwner(),original=f.repo.updateOwnerState.bind(f.repo);let once=false;f.repo.updateOwnerState=async(...args)=>{if(!once){once=true;await f.repo.checkin(now);}return original(...args);};
  const concurrent=await runControlStage(f.repo,f.env,now),owner=await f.repo.getOwner(),cursor=JSON.parse(await f.repo.getCursor('background-control'));assert.equal(concurrent.to,'NORMAL');assert.equal(owner.confirmation_round,before.confirmation_round+1);assert.equal(cursor.round,owner.confirmation_round);assert.equal(cursor.state,'NORMAL');
});

test('release progresses independently by channel and retains threshold, pause and inbox barriers',async t=>{
  const f=await fixture(t,{released:false});await f.db.prepare('DELETE FROM confirmation_votes').run();await runReleaseStage(f.repo,f.env,now);assert.ok((await f.repo.getProgress(f.owner.confirmation_round)).every(row=>!row.released_at));await f.repo.setCursor('background-release-channel','public');await f.repo.createConfirmation({contactId:1,status:'confirmed_death',round:f.owner.confirmation_round,now});assert.equal((await runReleaseStage(f.repo,f.env,now)).channel,'private');let progress=await f.repo.getProgress(f.owner.confirmation_round);assert.ok(progress.find(row=>row.channel==='private').released_at);assert.equal(progress.find(row=>row.channel==='public').released_at,null);
  assert.equal((await runReleaseStage(f.repo,f.env,now)).channel,'public');progress=await f.repo.getProgress(f.owner.confirmation_round);assert.ok(progress.every(row=>row.released_at));await f.repo.pause({mode:'manual',until:now,now});assert.equal((await runReleaseStage(f.repo,f.env,now)).released,false);
});

test('an inbox scan crossing rounds fails closed until a new complete current-round scan',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';const provider={name:'gmail'};
  const crossed=await runInboxStage(f.repo,f.env,now,async()=>{await f.repo.checkin(now);return {failed:0,backlog:false};},provider),owner=await f.repo.getOwner();assert.equal(crossed.status,'degraded');assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,now),false);
  await runInboxStage(f.repo,f.env,time(1),async()=>({failed:0,backlog:false}),provider);assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,time(1)),true);
  await f.db.prepare("INSERT INTO inbound_mail_log(gmail_message_id,status,processed_at,confirmation_round,source) VALUES('synthetic-current-failure','failed',?,?,'gmail')").bind(now,owner.confirmation_round).run();assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,time(1)),false);
  await f.db.prepare('UPDATE inbound_mail_log SET confirmation_round=?').bind(owner.confirmation_round-1).run();assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,time(1)),true);assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,time(7)),false);
});

test('private final guards recheck lease, source, recipient, pause, round and artifact identity',async t=>{
  for(const change of ['lease','expired','round','pause','recipient','source','artifact']){
    const f=await fixture(t),{id,job,p}=await claimedPrivate(f);assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,{},now),true,change+' baseline');
    if(change==='lease')job.lease_token='different-owner';
    if(change==='expired')await f.db.prepare('UPDATE background_jobs SET lease_until=? WHERE id=?').bind(now,job.id).run();
    if(change==='round')await f.repo.checkin(now);
    if(change==='pause')await f.repo.pause({mode:'manual',until:now,now});
    if(change==='recipient')await f.db.prepare("UPDATE recipients SET email='changed@example.invalid' WHERE id=?").bind(f.recipient).run();
    if(change==='source')await f.db.prepare('UPDATE encrypted_items SET revision=revision+1 WHERE id=?').bind(id).run();
    if(change==='artifact')await f.db.prepare('UPDATE pdf_artifacts SET upload_revision=upload_revision+1 WHERE id=?').bind(p.artifactId).run();
    assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,{},now),false,change);
  }
});

test('public final guards retain audience, formal revision and fresh-inbox checks',async t=>{
  for(const change of ['audience','formal','inbox']){
    const f=await fixture(t);await readyPdf(f,{kind:'public',locale:'zh'});await discover(f,'public');const job=await claimJob(f.repo,{kind:'mail',now}),p=await openJobValue(f.env,job.payload);assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,{},now),true);
    if(change==='audience')await frozen(f,rules=>{rules.public.audience=[];});
    if(change==='formal')await f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1').run();
    if(change==='inbox')f.env.INBOUND_PROVIDER='gmail';
    assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,{},now),false,change);
  }
});

test('transition preparation rotates a round-bound usable token and results preserve the verification thread',async t=>{
  const f=await fixture(t,{state:'VERIFY'});await discover(f,'transition');const job=await claimJob(f.repo,{kind:'mail',now}),p=await openJobValue(f.env,job.payload),prepared=await prepareStagedMessage(f.repo,f.env,job,p,{}),token=prepared.message.text.match(/https:\/\/example\.invalid\/verify\/([A-Za-z0-9_-]+)/)[1],hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
  assert.equal(hash,prepared.preparedTokenHash);const contact=await f.repo.findContactByTokenHash(hash);assert.equal(contact.id,p.contact.id);assert.equal(contact.verification_round,p.round);assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,prepared,now),true);
  const attempt='synthetic-transition-attempt';assert.equal(await f.repo.claimMail(p.dedupeKey,now,20,attempt),true);await f.repo.finishMailClaim(p.dedupeKey,'sent',null,attempt,{threadId:'synthetic-gmail-thread'});
  await recordStagedResult(f.repo,job,p,{...prepared,finalAttemptId:attempt},{status:'sent',threadId:'synthetic-gmail-thread'},now);assert.equal((await f.repo.getContact(contact.id)).verification_thread_id,'synthetic-gmail-thread');await f.repo.checkin(now);assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,prepared,now),false);
});

test('service guards allow an explicit selfcheck destination and keep security notices bound to the owner',async t=>{
  const f=await fixture(t);f.env.MAIL_HEALTHCHECK_EMAIL='selfcheck@example.invalid';
  for(const [eventType,to,allowed] of [['mail_healthcheck','selfcheck@example.invalid',true],['mail_healthcheck','owner@example.invalid',false],['security_alert','owner@example.invalid',true],['security_alert','selfcheck@example.invalid',false],['unknown','owner@example.invalid',false]]){
    const payload={type:'service',round:f.owner.confirmation_round,eventType,dedupeKey:crypto.randomUUID(),message:{to,subject:'Synthetic',text:'Synthetic'}};await enqueueJob(f.repo,f.env,{key:payload.dedupeKey,kind:'mail',round:payload.round,payload,now});const job=await claimJob(f.repo,{kind:'mail',now});assert.equal(await stagedMailAllowed(f.repo,f.env,job,payload,{},now),allowed,eventType+' '+to);await f.db.prepare("UPDATE background_jobs SET state='completed',lease_token=NULL WHERE id=?").bind(job.id).run();
  }
});

test('confirmation notice fanout uses its source-round roster and stays one recipient per stage',async t=>{
  const f=await fixture(t);await frozen(f,rules=>{rules.private.contact_ids=[1,2];rules.public.contact_ids=[2,3];});const actor=await f.repo.getContact(1);await f.repo.checkin(now);await queueConfirmationNotice({repo:f.repo,env:f.env,contact:actor,owner:f.owner,status:'false_alarm',now});
  for(let index=0;index<4;index++){await runNoticeStage(f.repo,f.env,now);assert.ok((await mails(f)).length<=index+1);}
  const jobs=await mails(f);assert.deepEqual(jobs.map(job=>job.data.message.to),['owner@example.invalid','c2@example.invalid','c3@example.invalid']);assert.ok(jobs.every(job=>job.data.type==='notice'&&job.data.round===f.owner.confirmation_round+1));assert.equal((await f.db.prepare("SELECT state FROM background_jobs WHERE kind='notice'").first()).state,'completed');
});

test('a cancelled source checkpoint can be safely rediscovered without changing the canonical delivery identity',async t=>{
  const f=await fixture(t),{job,p}=await claimedPrivate(f),settings=await f.repo.getSettings(f.env);
  await f.repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,font_size:19},rules:settings.active,now});assert.equal(await stagedMailAllowed(f.repo,f.env,job,p,{},now),false);
  await f.db.prepare("UPDATE background_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=?").bind(job.id).run();await discover(f,'private');let jobs=await mails(f);assert.equal(jobs.length,1);assert.equal(jobs[0].state,'pending');assert.equal(jobs[0].dedupe_key,p.dedupeKey);assert.equal(jobs[0].data.artifactId,p.artifactId);assert.equal(jobs[0].data.source.settings_revision,settings.revision+1);
  await f.db.prepare("INSERT INTO mail_claims(dedupe_key,status,claimed_at) VALUES(?,'dry_run',?)").bind(p.dedupeKey,now).run();await discover(f,'private');jobs=await mails(f);assert.equal(jobs.length,1,'a changed PDF/source checkpoint does not resend a completed canonical delivery');
});

test('private result records the canonical content version without altering source text',async t=>{
  const f=await fixture(t),{id,job,p}=await claimedPrivate(f),attempt='synthetic-private-attempt';assert.equal(await f.repo.claimMail(p.dedupeKey,now,20,attempt),true);await f.repo.finishMailClaim(p.dedupeKey,'dry_run',null,attempt);
  await recordStagedResult(f.repo,job,p,{finalAttemptId:attempt},{status:'dry_run'},now);const state=await f.db.prepare('SELECT * FROM private_delivery_state WHERE item_id=?').bind(id).first();assert.equal(state.status,'dry_run');assert.equal(state.content_version,p.item.delivery_version);assert.equal((await f.repo.getEncryptedItemForAdmin(id)).revision,0);
});

test('each scheduler tick advances one stage with control/inbox deadlines ahead of mail rotation',async t=>{
  const f=await fixture(t),calls=[],hooks=Object.fromEntries(['control','inbox','maintenance','mail','validate','discover','release','notice'].map(kind=>[kind,async()=>{calls.push(kind);return {kind};}]));hooks.available=async kind=>kind!=='validate'&&kind!=='notice';const control=[];
  for(let minute=0;minute<13;minute++){const before=calls.length,result=await runBackgroundTick(f.repo,f.env,time(minute),hooks);assert.equal(calls.length,before+1);if(result.stage==='control')control.push(minute);}
  assert.deepEqual(control,[0,4,8,12]);assert.ok(calls.includes('mail'));assert.ok(calls.includes('discover'));assert.ok(calls.includes('release'));assert.ok(calls.includes('maintenance'));
});

test('failed inbox attempts stay unhealthy while allowing maintenance and owner mail to continue',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';await f.db.prepare('UPDATE background_scheduler SET control_at=? WHERE id=1').bind(now).run();let maintenance=0,mail=0;
  const hooks={control:async()=>({}),inbox:()=>runInboxStage(f.repo,f.env,now,async()=>{throw Error('Synthetic inbox outage');},{name:'gmail'}),maintenance:async()=>{maintenance++;},mail:async()=>{mail++;},validate:async()=>({}),discover:async()=>({}),release:async()=>({}),notice:async()=>({}),available:async kind=>kind==='mail'};
  await assert.rejects(runBackgroundTick(f.repo,f.env,now,hooks),/Synthetic inbox outage/);assert.equal((await f.db.prepare('SELECT inbox_at FROM background_scheduler').first()).inbox_at,now);assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,now),false);
  await runBackgroundTick(f.repo,f.env,time(1),hooks);await runBackgroundTick(f.repo,f.env,time(2),hooks);assert.equal(maintenance,1);assert.equal(mail,1);assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,time(2)),false);
});
