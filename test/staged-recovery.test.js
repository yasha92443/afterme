// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import worker,{processContactEmailReplies,runStagedMaintenance} from '../src/worker.js';
import {enqueueJob,claimJob,checkpointJob,saveOwnedJob,openJobValue,cancelObsoleteJobs} from '../src/background-jobs.js';
import {runInboxStage,recordStagedResult} from '../src/staged-runtime.js';
import {runStagedMail} from '../src/staged-mail.js';
import {inboxAllowsDelivery} from '../src/background-scheduler.js';
import {REPLY_COMMANDS} from '../src/i18n.js';
import {GmailMailProvider} from '../src/mail.js';
import {createInvocationBudget} from '../src/invocation-budget.js';

const allow={async limit(){return {success:true};}};
async function fixture(t){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),now=new Date().toISOString();
  const env={DB:db,ADMIN_TOKEN:'synthetic-recovery-admin',CONTENT_ENCRYPTION_KEY:'synthetic-recovery-content',BACKGROUND_EXECUTION_MODE:'staged',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',LOGIN_LIMITER:allow,VERIFY_LIMITER:allow,API_LIMITER:allow,EXPENSIVE_LIMITER:allow,READ_LIMITER:allow};
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now});await repo.getSettings(env);const owner=await repo.getOwner();await repo.getRoundRules(owner);
  const call=body=>worker.fetch(new Request('https://example.invalid/api/mail/reconcile',{method:'POST',headers:{Authorization:'Bearer '+env.ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  return {db,repo,env,now,owner,call};
}
async function pendingFinal(f,{round=f.owner.confirmation_round,key='synthetic-delivery',attempt='synthetic-old-attempt',uncertain=true}={}){
  await enqueueJob(f.repo,f.env,{key:'job-'+key,kind:'mail',round,payload:{dedupeKey:key},now:f.now});const job=await claimJob(f.repo,{now:f.now,kind:'mail'});
  assert.equal(await f.repo.claimMail(key,f.now,20,attempt),true);
  if(uncertain)await f.repo.finishMailClaim(key,'uncertain','response-lost',attempt);
  await f.repo.logDelivery({eventType:'synthetic_mail',recipientEmail:'reader@example.invalid',subject:'Synthetic',provider:'gmail',status:'uncertain',dedupeKey:key,lastError:'response-lost',now:f.now});
  await saveOwnedJob(f.repo,f.env,job,{checkpoint:{phase:'probe',finalAttemptId:attempt,session:{uri:'synthetic-private-session'}},now:f.now});
  return {job,key,attempt};
}

for(const winner of ['receipt','new-attempt'])test('reconciliation cannot overwrite a '+winner+' arriving after its initial read',async t=>{
  const f=await fixture(t),{job,key,attempt}=await pendingFinal(f),batch=f.db.batch.bind(f.db);let injected=false;
  f.db.batch=async statements=>{
    if(!injected){injected=true;if(winner==='receipt')await f.repo.finishMailClaim(key,'sent',null,attempt,{id:'synthetic-receipt'});
      else await f.db.prepare("UPDATE mail_claims SET attempt_id='synthetic-new-attempt',claimed_at=?,status='uncertain' WHERE dedupe_key=?").bind(new Date(Date.parse(f.now)+1000).toISOString(),key).run();}
    return batch(statements);
  };
  const response=await f.call({dedupe_key:key,resolution:'retry'});assert.equal(response.status,409);assert.equal(injected,true);
  const claim=await f.db.prepare('SELECT * FROM mail_claims WHERE dedupe_key=?').bind(key).first(),current=await f.db.prepare('SELECT * FROM background_jobs WHERE id=?').bind(job.id).first();
  assert.equal(claim.status,winner==='receipt'?'sent':'uncertain');assert.equal(claim.attempt_id,winner==='receipt'?attempt:'synthetic-new-attempt');
  assert.equal(current.lease_token,job.lease_token);assert.equal((await openJobValue(f.env,current.checkpoint)).finalAttemptId,attempt);
  assert.equal((await f.db.prepare('SELECT status FROM delivery_log WHERE dedupe_key=?').bind(key).first()).status,'failed');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type='mail_reconciled'").first()).count,0);
});

test('retry fences old receipts and leases before a new canonical attempt starts',async t=>{
  const f=await fixture(t),{job,key,attempt}=await pendingFinal(f);
  assert.equal((await f.call({dedupe_key:key,resolution:'retry'})).status,200);
  const current=await f.db.prepare('SELECT * FROM background_jobs WHERE id=?').bind(job.id).first();assert.equal(current.state,'pending');assert.equal(current.checkpoint,null);assert.equal(current.lease_token,null);
  assert.equal(await f.repo.claimMail(key,f.now,20,'synthetic-new-attempt'),true);
  assert.equal((await f.repo.finishMailClaim(key,'sent',null,attempt,{id:'late-old-receipt'})).meta.changes,0);
  assert.equal(await checkpointJob(f.repo,f.env,job,{state:'completed',now:f.now}),false);
  const claim=await f.db.prepare('SELECT * FROM mail_claims WHERE dedupe_key=?').bind(key).first();assert.equal(claim.status,'sending');assert.equal(claim.attempt_id,'synthetic-new-attempt');assert.equal(claim.provider_message_id,null);
});

test('round changes retain an unresolved canonical dispatch for health and manual reconciliation',async t=>{
  const f=await fixture(t),{job,key,attempt}=await pendingFinal(f,{uncertain:false});
  await f.repo.checkin(f.now);await cancelObsoleteJobs(f.repo,f.now);
  const later=new Date(Date.parse(f.now)+16*60000).toISOString();
  assert.equal((await f.db.prepare('SELECT state FROM background_jobs WHERE id=?').bind(job.id).first()).state,'uncertain');
  assert.equal(await saveOwnedJob(f.repo,f.env,job,{checkpoint:{phase:'upload'},now:f.now}),false);
  await runStagedMaintenance(f.repo,f.env,later,{name:'dry-run'});let health=JSON.parse(await f.repo.getCursor('public-health'));assert.equal(health.checks.deliveries_healthy,false);
  // The stale claim remains eligible for a human even after its round ended.
  await f.db.prepare('UPDATE mail_claims SET claimed_at=? WHERE dedupe_key=?').bind(new Date(Date.parse(f.now)-16*60000).toISOString(),key).run();
  assert.equal((await f.call({dedupe_key:key,resolution:'delivered'})).status,200);
  assert.equal((await f.db.prepare('SELECT state FROM background_jobs WHERE id=?').bind(job.id).first()).state,'completed');
  assert.equal((await f.repo.finishMailClaim(key,'uncertain','late-response',attempt)).meta.changes,0);
  await runStagedMaintenance(f.repo,f.env,later,{name:'dry-run'});health=JSON.parse(await f.repo.getCursor('public-health'));assert.equal(health.checks.deliveries_healthy,true);
});

test('retry resolves an obsolete dispatch without resurrecting its old-round upload',async t=>{
  const f=await fixture(t),{job,key}=await pendingFinal(f);await f.repo.checkin(f.now);await cancelObsoleteJobs(f.repo,f.now);
  assert.equal((await f.call({dedupe_key:key,resolution:'retry'})).status,200);
  const current=await f.db.prepare('SELECT * FROM background_jobs WHERE id=?').bind(job.id).first();assert.equal(current.state,'cancelled');assert.equal(current.checkpoint,null);
  assert.equal(await claimJob(f.repo,{now:f.now,kind:'mail'}),null);
});

test('expired and superseded preparation leases cannot persist a checkpoint',async t=>{
  const f=await fixture(t);await enqueueJob(f.repo,f.env,{key:'synthetic-lease-job',kind:'mail',round:f.owner.confirmation_round,payload:{dedupeKey:'synthetic-lease-key'},now:f.now});const old=await claimJob(f.repo,{now:f.now,kind:'mail'}),later=new Date(Date.parse(f.now)+121000).toISOString();
  assert.equal(await saveOwnedJob(f.repo,f.env,old,{checkpoint:{phase:'stale-expired'},now:later}),false);
  const current=await claimJob(f.repo,{now:later,kind:'mail'});assert.notEqual(current.lease_token,old.lease_token);
  assert.equal(await saveOwnedJob(f.repo,f.env,current,{checkpoint:{phase:'current'},now:later}),true);
  assert.equal(await saveOwnedJob(f.repo,f.env,old,{checkpoint:{phase:'stale-owner'},now:later}),false);
  assert.equal(await checkpointJob(f.repo,f.env,old,{checkpoint:{phase:'stale-owner'},state:'completed',now:later}),false);
  assert.equal((await openJobValue(f.env,(await f.db.prepare('SELECT checkpoint FROM background_jobs WHERE id=?').bind(old.id).first()).checkpoint)).phase,'current');
});

for(const state of ['stale','future','wrong-round','invalid','fresh'])test('maintenance reports '+state+' inbox watermark accurately',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';const completed_at=state==='invalid'?'invalid':new Date(Date.parse(f.now)+(state==='stale'?-300001:state==='future'?1:0)).toISOString();
  await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round+(state==='wrong-round'?1:0),generation_id:'synthetic-generation',started_at:completed_at,status:'healthy',completed_at}));
  await runStagedMaintenance(f.repo,f.env,f.now,{name:'gmail'});
  const audit=await f.db.prepare("SELECT details_json FROM audit_log WHERE event_type='scheduled_check_completed' ORDER BY id DESC LIMIT 1").first(),health=JSON.parse(await f.repo.getCursor('public-health'));
  assert.equal(JSON.parse(audit.details_json).inbox_status,state==='fresh'?'healthy':'degraded');assert.equal(health.checks.gmail_inbound_healthy,state==='fresh');
});

test('a cancelled unsubmitted daily security alert can be queued for the current round',async t=>{
  const f=await fixture(t),key='security-alert:'+f.now.slice(0,10)+':service_failure';
  await enqueueJob(f.repo,f.env,{key,kind:'mail',round:f.owner.confirmation_round,payload:{dedupeKey:key},now:f.now});const job=await claimJob(f.repo,{now:f.now,kind:'mail'});await checkpointJob(f.repo,f.env,job,{state:'cancelled',now:f.now});
  await f.db.prepare('INSERT INTO security_events(kind,hour,count) VALUES(?,?,1)').bind('service_failure',f.now.slice(0,13)).run();await f.repo.setCursor('background-maintenance','1');
  await runStagedMaintenance(f.repo,f.env,f.now,{name:'dry-run'});
  const current=await f.db.prepare('SELECT * FROM background_jobs WHERE id=?').bind(job.id).first();assert.equal(current.state,'pending');assert.equal((await openJobValue(f.env,current.payload)).eventType,'security_alert');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM background_jobs WHERE dedupe_key=?').bind(key).first()).count,1);
});

test('bounded ambiguous authenticated replies remain failed, preserve the scan cursor and never confirm',async t=>{
  const f=await fixture(t),token='synthetic_reply_token_abcdefghijklmnopqrstuvwxyz',hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');f.env.INBOUND_PROVIDER='gmail';
  const id=await f.repo.createContact({name:'Synthetic contact',email:'contact@example.invalid',role:'friend',priority:1,tokenHash:hash});
  await f.repo.setCursor('gmail-inbox-page','synthetic-original-page');
  await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,generation_id:'synthetic-active-generation',started_at:f.now,status:'degraded',closed:false}));
  const messages=[{id:'synthetic-ambiguous-reply',threadId:'synthetic-thread',from:'contact@example.invalid',recipients:'inbox+verify-'+token+'@gmail.com',subject:'Synthetic',receivedAt:f.now,authenticationPassed:true,body:REPLY_COMMANDS.en[1]+'\n'+'x'.repeat(17000)}];messages.nextPageToken='synthetic-next-page';
  const provider={name:'gmail',async listInboundMessages(){return messages;}};
  const result=await runInboxStage(f.repo,f.env,f.now,processContactEmailReplies,provider);assert.equal(result.failed,1);assert.equal(result.status,'degraded');
  assert.equal(await f.repo.getCursor('gmail-inbox-page'),'synthetic-original-page');assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,f.now),false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM confirmations WHERE contact_id=?').bind(id).first()).count,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM background_jobs').first()).count,0);
  const log=await f.db.prepare("SELECT status,details_json FROM inbound_mail_log WHERE gmail_message_id='synthetic-ambiguous-reply'").first();assert.equal(log.status,'failed');assert.equal(JSON.parse(log.details_json).reason,'processing-error');
});

test('injected inbound transport consumes the actual list, detail and retry responses within the external budget',async()=>{
  const env={BACKGROUND_EXECUTION_MODE:'staged',GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',FROM_EMAIL:'sender@example.invalid',INVOCATION_BUDGET:createInvocationBudget({external:6})},provider=new GmailMailProvider(env),seen=[];
  provider.getAccessToken=async()=>({ok:true,accessToken:'synthetic'});
  provider.transport=async input=>{const url=new URL(input);assert.equal(url.origin,'https://gmail.googleapis.com');seen.push(url.pathname);
    return url.pathname.endsWith('/messages')?Response.json({messages:[{id:'synthetic-listed',threadId:'synthetic-thread'}]}):Response.json({id:url.pathname.split('/').at(-1),internalDate:String(Date.now()),payload:{mimeType:'text/plain',headers:[],body:{data:Buffer.from('Synthetic only').toString('base64url')}}});};
  const repo={getCursor:async()=>'',completedInboundIds:async()=>new Set(),pendingInboundIds:async()=>[]};
  const listed=await provider.listInboundMessages({maxResults:1,repo});assert.equal(listed[0].body,'Synthetic only');assert.equal(listed[0].id,'synthetic-listed');
  repo.pendingInboundIds=async()=>['synthetic-retry'];const retried=await provider.listInboundMessages({maxResults:1,repo});assert.equal(retried[0].id,'synthetic-retry');assert.equal(retried.backlog,true);
  assert.equal(seen.length,3);assert.equal(env.INVOCATION_BUDGET.usedExternal,3);
  env.INVOCATION_BUDGET.maxExternal=3;
  await assert.rejects(()=>provider.listInboundMessages({maxResults:1,repo}),{name:'InvocationBudgetError'});assert.equal(seen.length,3);
});

test('a reconciliation between canonical receipt and log insertion fences late logs and result hooks',async t=>{
  const f=await fixture(t),key='synthetic-late-log';await enqueueJob(f.repo,f.env,{key,kind:'mail',round:f.owner.confirmation_round,payload:{dedupeKey:key},now:f.now});
  let hooks=0,interleaved=false;
  const options={canSend:async()=>true,prepare:async()=>({message:{to:'reader@example.invalid',subject:'Synthetic',text:'Synthetic'}}),onResult:async()=>{hooks++;},provider:{name:'gmail',async sendMedia(message){assert.equal(await message.canSend(),true);assert.equal(await message.beforeFinal(),true);return {status:'uncertain',error:'synthetic-lost-response',claimed:true};}}};
  assert.equal((await runStagedMail(f.repo,f.env,f.now,options)).status,'prepared');
  const log=f.repo.logDelivery.bind(f.repo);f.repo.logDelivery=async args=>{
    assert.ok(args.expectedAttemptId);interleaved=true;
    assert.equal((await f.call({dedupe_key:key,resolution:'retry'})).status,200);
    assert.equal(await f.repo.claimMail(key,f.now,20,'synthetic-replacement-attempt'),true);
    await f.repo.finishMailClaim(key,'sent',null,'synthetic-replacement-attempt',{id:'synthetic-new-receipt'});
    await log({...args,status:'sent',lastError:null,expectedAttemptId:'synthetic-replacement-attempt'});
    return log(args);
  };
  await runStagedMail(f.repo,f.env,new Date(Date.parse(f.now)+1000).toISOString(),options);
  assert.equal(interleaved,true);assert.equal(hooks,0);
  const claim=await f.db.prepare('SELECT * FROM mail_claims WHERE dedupe_key=?').bind(key).first(),delivery=await f.db.prepare('SELECT * FROM delivery_log WHERE dedupe_key=?').bind(key).first();
  assert.equal(claim.status,'sent');assert.equal(claim.attempt_id,'synthetic-replacement-attempt');assert.equal(delivery.status,'sent');assert.equal(delivery.attempts,1);
  const job=await f.db.prepare('SELECT * FROM background_jobs WHERE dedupe_key=?').bind(key).first();assert.equal(job.state,'pending');assert.equal(job.checkpoint,null);
});

test('late private result callbacks cannot replace a newer attempt or newer content state',async t=>{
  const f=await fixture(t),key='synthetic-private-result',old='synthetic-old-result',current='synthetic-current-result';
  const id=await f.repo.createEncryptedItem({kind:'letter',title:'Synthetic',encryptedPayload:'synthetic',payloadSize:9,vaultToken:'synthetic',vaultTokenHash:'synthetic',updatedAt:f.now});
  const p={type:'private',dedupeKey:key,item:{id,delivery_version:0}};
  assert.equal(await f.repo.claimMail(key,f.now,20,old),true);await f.repo.finishMailClaim(key,'uncertain','response-lost',old);
  await f.db.prepare('UPDATE mail_claims SET status=\'sending\',attempt_id=? WHERE dedupe_key=?').bind(current,key).run();await f.repo.finishMailClaim(key,'sent',null,current);
  await recordStagedResult(f.repo,{},p,{finalAttemptId:current},{status:'sent'},f.now);
  await recordStagedResult(f.repo,{},p,{finalAttemptId:old},{status:'uncertain'},f.now);
  let row=await f.db.prepare('SELECT * FROM private_delivery_state WHERE item_id=?').bind(id).first();assert.equal(row.status,'sent');assert.equal(row.content_version,0);
  await f.db.prepare('UPDATE encrypted_items SET delivery_version=1 WHERE id=?').bind(id).run();await f.repo.recordPrivateDeliveryState(id,'pending','new-content',f.now,1);
  await recordStagedResult(f.repo,{},p,{finalAttemptId:current},{status:'sent'},f.now);
  row=await f.db.prepare('SELECT * FROM private_delivery_state WHERE item_id=?').bind(id).first();assert.equal(row.status,'pending');assert.equal(row.content_version,1);
  assert.equal(await recordStagedResult(f.repo,{},p,{}, {status:'uncertain'},f.now),false);
});

test('verification thread callbacks compare the attempt and canonical result in the actual update',async t=>{
  const f=await fixture(t),key='synthetic-thread-result',old='synthetic-old-thread',current='synthetic-current-thread';
  const id=await f.repo.createContact({name:'Synthetic contact',email:'contact@example.invalid',role:'friend',priority:1,tokenHash:'synthetic'});await f.repo.rotateContactToken({id,tokenHash:'synthetic-current-token',expectedRound:f.owner.confirmation_round});
  assert.equal(await f.repo.claimMail(key,f.now,20,old),true);await f.repo.finishMailClaim(key,'uncertain','response-lost',old);
  const prepare=f.db.prepare.bind(f.db);let interleaved=false;
  f.db.prepare=sql=>{if(!interleaved&&sql.startsWith('UPDATE contacts SET verification_thread_id=')){interleaved=true;prepare("UPDATE mail_claims SET status='sent',attempt_id=? WHERE dedupe_key=?").bind(current,key).run();prepare('UPDATE contacts SET verification_thread_id=? WHERE id=?').bind('synthetic-current-gmail-thread',id).run();}return prepare(sql);};
  const p={type:'transition',state:'VERIFY',round:f.owner.confirmation_round,contact:{id},dedupeKey:key};
  await recordStagedResult(f.repo,{},p,{finalAttemptId:old},{status:'uncertain',threadId:'synthetic-stale-gmail-thread'},f.now);
  assert.equal(interleaved,true);assert.equal((await f.repo.getContact(id)).verification_thread_id,'synthetic-current-gmail-thread');
  // The right attempt with a mismatched result is also rejected.
  await recordStagedResult(f.repo,{},p,{finalAttemptId:current},{status:'uncertain',threadId:'synthetic-wrong-status'},f.now);assert.equal((await f.repo.getContact(id)).verification_thread_id,'synthetic-current-gmail-thread');
  await recordStagedResult(f.repo,{},p,{finalAttemptId:current},{status:'sent',threadId:'synthetic-confirmed-thread'},f.now);assert.equal((await f.repo.getContact(id)).verification_thread_id,'synthetic-confirmed-thread');
});

test('a new round discards an old generation tail cursor before requesting its first page',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';
  await f.repo.setCursor('gmail-inbox-page','synthetic-old-tail');await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,generation_id:'synthetic-old-generation',started_at:f.now,status:'degraded',closed:false}));
  await f.repo.checkin(f.now);const owner=await f.repo.getOwner();
  const result=await runInboxStage(f.repo,f.env,f.now,async()=>{assert.equal(await f.repo.getCursor('gmail-inbox-page'),'');const scanning=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(scanning.round,owner.confirmation_round);assert.equal(scanning.status,'scanning');assert.notEqual(scanning.generation_id,'synthetic-old-generation');assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,f.now),false);return {failed:0,backlog:false};},{name:'gmail'});
  assert.equal(result.status,'healthy');const saved=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(saved.started_at,f.now);assert.equal(saved.closed,true);assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,f.now),true);
});

test('a scan that changes round cannot publish healthy or carry its tail into the next generation',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';let oldGeneration;
  const first=await runInboxStage(f.repo,f.env,f.now,async()=>{oldGeneration=JSON.parse(await f.repo.getCursor('background-inbox')).generation_id;await f.repo.checkin(f.now);await f.repo.setCursor('gmail-inbox-page','synthetic-old-tail');return {failed:0,backlog:false};},{name:'gmail'});
  assert.equal(first.status,'degraded');const owner=await f.repo.getOwner();assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,f.now),false);
  const now=new Date(Date.parse(f.now)+60000).toISOString();await runInboxStage(f.repo,f.env,now,async()=>{assert.equal(await f.repo.getCursor('gmail-inbox-page'),'');assert.notEqual(JSON.parse(await f.repo.getCursor('background-inbox')).generation_id,oldGeneration);return {failed:0,backlog:false};},{name:'gmail'});
  assert.equal(await inboxAllowsDelivery(f.repo,f.env,owner.confirmation_round,now),true);
});

test('backlog pages retain their generation start and an expired final page never refreshes it to healthy',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';const at=minute=>new Date(Date.parse(f.now)+minute*60000).toISOString(),provider={name:'gmail'};
  await runInboxStage(f.repo,f.env,at(0),async()=>{await f.repo.setCursor('gmail-inbox-page','synthetic-tail-a');return {failed:0,backlog:true};},provider);const first=JSON.parse(await f.repo.getCursor('background-inbox'));
  await runInboxStage(f.repo,f.env,at(4),async()=>{assert.equal(await f.repo.getCursor('gmail-inbox-page'),'synthetic-tail-a');await f.repo.setCursor('gmail-inbox-page','synthetic-tail-b');return {failed:0,backlog:true};},provider);let saved=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(saved.generation_id,first.generation_id);assert.equal(saved.started_at,at(0));
  const final=await runInboxStage(f.repo,f.env,at(6),async()=>{assert.equal(await f.repo.getCursor('gmail-inbox-page'),'synthetic-tail-b');await f.repo.setCursor('gmail-inbox-page','');return {failed:0,backlog:false};},provider);saved=JSON.parse(await f.repo.getCursor('background-inbox'));
  assert.equal(final.status,'degraded');assert.equal(saved.closed,true);assert.equal(saved.generation_id,first.generation_id);assert.equal(saved.started_at,at(0));assert.equal(saved.completed_at,null);assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,at(6)),false);
  const fresh=await runInboxStage(f.repo,f.env,at(7),async()=>{assert.equal(await f.repo.getCursor('gmail-inbox-page'),'');return {failed:0,backlog:false};},provider);saved=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(fresh.status,'healthy');assert.notEqual(saved.generation_id,first.generation_id);assert.equal(saved.started_at,at(7));
});

test('delivery freshness measures the generation start as well as its recent completion',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';const at=minute=>new Date(Date.parse(f.now)+minute*60000).toISOString(),provider={name:'gmail'};
  await runInboxStage(f.repo,f.env,at(0),async()=>({failed:0,backlog:true}),provider);await runInboxStage(f.repo,f.env,at(2),async()=>({failed:0,backlog:false}),provider);
  const saved=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(saved.started_at,at(0));assert.equal(saved.completed_at,at(2));assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,at(4)),true);assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,at(6)),false);
});

for(const status of ['failed','processing'])test('an existing current-round '+status+' record prevents a clean empty scan becoming healthy',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';await f.db.prepare("INSERT INTO inbound_mail_log(gmail_message_id,status,processed_at,confirmation_round,source) VALUES('synthetic-blocking-generation',?,?,?,'gmail')").bind(status,f.now,f.owner.confirmation_round).run();
  const result=await runInboxStage(f.repo,f.env,f.now,async()=>({failed:0,backlog:false}),{name:'gmail'});assert.equal(result.status,'degraded');let saved=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(saved.closed,false);assert.equal(saved.completed_at,null);assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,f.now),false);
  await f.db.prepare("UPDATE inbound_mail_log SET status='ignored' WHERE gmail_message_id='synthetic-blocking-generation'").run();const now=new Date(Date.parse(f.now)+60000).toISOString();assert.equal((await runInboxStage(f.repo,f.env,now,async()=>({failed:0,backlog:false}),{name:'gmail'})).status,'healthy');const current=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(current.generation_id,saved.generation_id);assert.equal(current.started_at,saved.started_at);
});

test('a failed poll retains its generation and can only close after a successful retry',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';await assert.rejects(()=>runInboxStage(f.repo,f.env,f.now,async()=>{throw Error('Synthetic fetch failure');},{name:'gmail'}));const first=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(first.status,'failed');assert.equal(first.closed,false);
  const now=new Date(Date.parse(f.now)+60000).toISOString();assert.equal((await runInboxStage(f.repo,f.env,now,async()=>({failed:0,backlog:false}),{name:'gmail'})).status,'healthy');const current=JSON.parse(await f.repo.getCursor('background-inbox'));assert.equal(current.generation_id,first.generation_id);assert.equal(current.started_at,first.started_at);
});

test('live operational health rejects old generation starts and newly blocking messages despite a healthy cached snapshot',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';const request=()=>worker.fetch(new Request('https://example.invalid/health/operational'),f.env);
  await f.repo.setCursor('public-health',JSON.stringify({ok:true,snapshot_at:f.now,checks:{worker_reachable:true,cron_fresh:true,gmail_inbound_healthy:true}}));await f.repo.setCursor('background-control',JSON.stringify({round:f.owner.confirmation_round,completed_at:f.now}));
  const good={round:f.owner.confirmation_round,generation_id:'synthetic-live-generation',started_at:f.now,status:'healthy',completed_at:f.now};await f.repo.setCursor('background-inbox',JSON.stringify({...good,started_at:new Date(Date.parse(f.now)-360000).toISOString()}));assert.equal((await request()).status,503);
  await f.repo.setCursor('background-inbox',JSON.stringify(good));assert.equal((await request()).status,200);
  await f.db.prepare("INSERT INTO inbound_mail_log(gmail_message_id,status,processed_at,confirmation_round,source) VALUES('synthetic-live-block','failed',?,?,'gmail')").bind(f.now,f.owner.confirmation_round).run();let response=await request();assert.equal(response.status,503);assert.equal((await response.json()).checks.gmail_inbound_healthy,false);
  await f.db.prepare('UPDATE inbound_mail_log SET confirmation_round=?').bind(f.owner.confirmation_round-1).run();assert.equal((await request()).status,200);
});

test('completion-only legacy watermarks are blocked until a complete generation replaces them',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,status:'healthy',completed_at:f.now}));await f.repo.setCursor('gmail-inbox-page','synthetic-legacy-tail');
  assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,f.now),false);
  const result=await runInboxStage(f.repo,f.env,f.now,async()=>{assert.equal(await f.repo.getCursor('gmail-inbox-page'),'');return {failed:0,backlog:false};},{name:'gmail'});assert.equal(result.status,'healthy');assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,f.now),true);
});

test('a superseded poll cannot overwrite a newer completion watermark',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';const newer=new Date(Date.parse(f.now)+1000).toISOString();let finished;
  const outer=await runInboxStage(f.repo,f.env,f.now,async()=>{assert.equal((await runInboxStage(f.repo,f.env,newer,async()=>({failed:0,backlog:false}),{name:'gmail'})).status,'healthy');finished=await f.repo.getCursor('background-inbox');return {failed:0,backlog:true};},{name:'gmail'});
  assert.equal(outer.status,'degraded');assert.equal(await f.repo.getCursor('background-inbox'),finished);assert.equal(JSON.parse(finished).completed_at,newer);assert.equal(await f.repo.getCursor('inbox-status'),'healthy');
});

async function supersedingBacklog(f){
  const at=minutes=>new Date(Date.parse(f.now)+minutes*60000).toISOString();
  await runInboxStage(f.repo,f.env,at(1),async()=>({failed:0,backlog:false}),{name:'gmail'});
  await runInboxStage(f.repo,f.env,at(2),async({repo})=>{await repo.setCursor('gmail-inbox-page','synthetic-new-generation-tail');return {failed:0,backlog:true};},{name:'gmail'});
  return await f.repo.getCursor('background-inbox');
}

test('a delayed reply batch cannot overwrite the page cursor of a newer same-round generation',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';let current;
  const provider={name:'gmail',async listInboundMessages(){current=await supersedingBacklog(f);const messages=[];messages.nextPageToken='synthetic-stale-tail';messages.backlog=true;return messages;}};
  const result=await runInboxStage(f.repo,f.env,f.now,processContactEmailReplies,provider);assert.equal(result.status,'degraded');assert.equal(await f.repo.getCursor('gmail-inbox-page'),'synthetic-new-generation-tail');assert.equal(await f.repo.getCursor('background-inbox'),current);
  const now=new Date(Date.parse(f.now)+180000).toISOString();await runInboxStage(f.repo,f.env,now,async({repo})=>{assert.equal(await repo.getCursor('gmail-inbox-page'),'synthetic-new-generation-tail');return {failed:0,backlog:false};},{name:'gmail'});assert.equal(await inboxAllowsDelivery(f.repo,f.env,f.owner.confirmation_round,now),true);
});

test('an old Gmail invalid-page response cannot clear the cursor of a newer same-round generation',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,generation_id:'synthetic-old-invalid-page',started_at:f.now,status:'degraded',closed:false}));await f.repo.setCursor('gmail-inbox-page','synthetic-expired-page');
  const provider=new GmailMailProvider({...f.env,GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',FROM_EMAIL:'sender@example.invalid'});provider.getAccessToken=async()=>({ok:true,accessToken:'synthetic'});let current;
  provider.transport=async input=>{assert.equal(new URL(input).searchParams.get('pageToken'),'synthetic-expired-page');current=await supersedingBacklog(f);return new Response(null,{status:400});};
  await assert.rejects(()=>runInboxStage(f.repo,f.env,f.now,processContactEmailReplies,provider),/gmail inbox list failed/);assert.equal(await f.repo.getCursor('gmail-inbox-page'),'synthetic-new-generation-tail');assert.equal(await f.repo.getCursor('background-inbox'),current);
});

test('a superseded poll cannot read and adopt the newer generation page cursor',async t=>{
  const f=await fixture(t);f.env.INBOUND_PROVIDER='gmail';let current;
  const result=await runInboxStage(f.repo,f.env,f.now,async({repo})=>{current=await supersedingBacklog(f);await assert.rejects(()=>repo.getCursor('gmail-inbox-page'),/Inbox generation changed/);return {failed:0,backlog:true};},{name:'gmail'});
  assert.equal(result.status,'degraded');assert.equal(await f.repo.getCursor('background-inbox'),current);assert.equal(await f.repo.getCursor('gmail-inbox-page'),'synthetic-new-generation-tail');
});
