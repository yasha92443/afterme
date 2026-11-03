// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import worker,{processContactEmailReplies,runScheduledCheck} from '../src/worker.js';
import {enqueueJob,claimJob,checkpointJob,saveOwnedJob,openJobValue} from '../src/background-jobs.js';
import {beginArtifact,uploadArtifactChunk,runArtifactValidationStep} from '../src/pdf-artifacts.js';
import {bytesToBase64} from '../src/invocation-budget.js';
import {checkConfiguration} from '../scripts/setup-guided.mjs';
import {readFileSync} from 'node:fs';
const allow={async limit(){return {success:true};}};
async function fixture(t){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),now=new Date().toISOString();
  const env={DB:db,ADMIN_TOKEN:'staged-http-admin',CONTENT_ENCRYPTION_KEY:'staged-http-content',BACKGROUND_EXECUTION_MODE:'staged',PDF_GENERATION_MODE:'browser',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',LOGIN_LIMITER:allow,VERIFY_LIMITER:allow,API_LIMITER:allow,EXPENSIVE_LIMITER:allow,READ_LIMITER:allow};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const call=(path,body)=>worker.fetch(new Request('https://example.test'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+env.ADMIN_TOKEN,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {db,repo,env,now,call};
}
test('completion HTTP returns 202 until independent background validation makes the artifact ready',async t=>{
  const f=await fixture(t),artifact=await beginArtifact(f.repo,f.env,{kind:'public'}),bytes=new TextEncoder().encode('%PDF-1.7\nsynthetic only\n%%EOF\n');
  await uploadArtifactChunk(f.repo,f.env,artifact.id,0,bytesToBase64(bytes));
  const response=await f.call('/api/pdf-artifacts/'+artifact.id+'/complete',{total_bytes:bytes.length,chunk_count:1,sha256:'0'.repeat(64)});
  assert.equal(response.status,202);assert.equal((await response.json()).status,'validating');
  assert.equal((await (await f.call('/api/pdf-artifacts/'+artifact.id)).json()).status,'validating');
  await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);await runArtifactValidationStep(f.repo,f.env,{artifact_id:artifact.id},f.now);
  assert.equal((await (await f.call('/api/pdf-artifacts/'+artifact.id)).json()).status,'ready');
});
test('incomplete inbound input stays failed and blocks release rather than becoming ignored',async t=>{
  const f=await fixture(t),provider={name:'gmail',async listInboundMessages(){const rows=[{id:'incomplete-synthetic',incomplete:true}];rows.nextPageToken='';return rows;}};
  const result=await processContactEmailReplies({...f,provider});assert.equal(result.failed,1);
  assert.equal((await f.db.prepare("SELECT status FROM inbound_mail_log WHERE gmail_message_id='incomplete-synthetic'").first()).status,'failed');
  assert.equal(await f.repo.hasBlockingInbound((await f.repo.getOwner()).confirmation_round),true);
});
test('manual mail reconciliation invalidates the old attempt and its encrypted upload session',async t=>{
  const f=await fixture(t),payload={round:1,dedupeKey:'synthetic-mail',message:{to:'reader@example.invalid'}};
  await enqueueJob(f.repo,f.env,{key:'synthetic-job',kind:'mail',round:1,payload,now:f.now});const job=await claimJob(f.repo,{now:f.now,kind:'mail'});
  assert.equal(await f.repo.claimMail(payload.dedupeKey,f.now,20,'old-attempt'),true);
  await f.repo.finishMailClaim(payload.dedupeKey,'uncertain','lost','old-attempt');
  await saveOwnedJob(f.repo,f.env,job,{checkpoint:{phase:'probe',session:{uri:'synthetic-private-session'},finalAttemptId:'old-attempt'},now:f.now});
  const response=await f.call('/api/mail/reconcile',{dedupe_key:payload.dedupeKey,resolution:'retry'});assert.equal(response.status,200);
  const current=await f.db.prepare('SELECT * FROM background_jobs WHERE id=?').bind(job.id).first();assert.equal(current.state,'pending');assert.equal(current.checkpoint,null);assert.equal(current.lease_token,null);
  const stale=await f.repo.finishMailClaim(payload.dedupeKey,'sent',null,'old-attempt',{id:'late'});assert.equal(stale.meta.changes,0);
  assert.equal(await checkpointJob(f.repo,f.env,job,{state:'completed',now:f.now}),false);
});
test('cancelled pre-dispatch work can be requeued, unresolved final claims cannot',async t=>{
  const f=await fixture(t),payload={dedupeKey:'synthetic-dedupe',message:{to:'reader@example.invalid'}};
  await enqueueJob(f.repo,f.env,{key:'same',kind:'mail',round:1,payload,now:f.now});let job=await claimJob(f.repo,{now:f.now,kind:'mail'});
  await checkpointJob(f.repo,f.env,job,{state:'cancelled',now:f.now});
  assert.equal((await enqueueJob(f.repo,f.env,{key:'same',kind:'mail',round:1,payload,now:f.now})).created,true);
  job=await claimJob(f.repo,{now:f.now,kind:'mail'});assert.equal((await openJobValue(f.env,job.payload)).dedupeKey,payload.dedupeKey);
  await checkpointJob(f.repo,f.env,job,{state:'cancelled',now:f.now});await f.repo.claimMail(payload.dedupeKey,f.now,20,'attempt');
  assert.equal((await enqueueJob(f.repo,f.env,{key:'same',kind:'mail',round:1,payload,now:f.now})).created,false);
});
test('health rejects a fresh-looking snapshot from a different owner round',async t=>{
  const f=await fixture(t);await f.repo.setCursor('public-health',JSON.stringify({ok:true,checks:{worker_reachable:true,cron_fresh:true,gmail_inbound_healthy:true},snapshot_at:f.now}));
  await f.repo.setCursor('background-control',JSON.stringify({round:0,completed_at:f.now}));
  const response=await f.call('/health/operational');assert.equal(response.status,503);assert.equal((await response.json()).checks.cron_fresh,false);
});

test('normal lane scanning reports service health separately from final inbox readiness',async t=>{
  const f=await fixture(t);f.env.BACKGROUND_LANE_SCHEDULING='true';f.env.INBOUND_PROVIDER='gmail';f.env.MAIL_INBOUND_ENABLED='true';
  await f.repo.setCursor('public-health',JSON.stringify({ok:false,checks:{worker_reachable:true,cron_fresh:true,gmail_inbound_healthy:false,deliveries_healthy:true,inbound_processing_healthy:true,mail_outbound_fresh:true},snapshot_at:f.now}));
  await f.repo.setCursor('background-control',JSON.stringify({round:1,completed_at:f.now}));
  const metadata={round:1,generation_id:'synthetic-live-scan',started_at:f.now,observed_at:f.now,provider_verified_at:f.now,provider_failed:false,status:'scanning',phase:'detail',closed:false,backlog:false,incomplete:false};
  await f.repo.setCursor('background-inbox',JSON.stringify(metadata));
  let response=await f.call('/health/operational');assert.equal(response.status,200);const result=await response.json();assert.equal(result.checks.gmail_inbound_healthy,true);assert.equal(result.verification_inbox_ready,false);
  await f.repo.setCursor('background-inbox',JSON.stringify({...metadata,backlog:true}));response=await f.call('/health/operational');assert.equal(response.status,503);
  await f.repo.setCursor('background-inbox',JSON.stringify(metadata));const old=JSON.parse(await f.repo.getCursor('public-health'));old.snapshot_at=new Date(Date.parse(f.now)-16*60000).toISOString();await f.repo.setCursor('public-health',JSON.stringify(old));response=await f.call('/health/operational');assert.equal(response.status,503,'live scan progress cannot bless a stale diagnostic snapshot');
});
test('staged scheduled invocation performs control, inbox and maintenance on distinct ticks',async t=>{
  const f=await fixture(t),stages=[];
  for(let i=0;i<3;i++){const result=await runScheduledCheck(f.repo,f.env,new Date(Date.parse(f.now)+i*60000));stages.push(result.stage);}
  assert.deepEqual(stages,['control','inbox','maintenance']);
});
test('setup requires the minute Cron and a supported provider for staged execution',()=>{
  const base=readFileSync(new URL('../wrangler.example.toml',import.meta.url),'utf8').replace('00000000-0000-4000-8000-000000000000',crypto.randomUUID()).replace('PDF_GENERATION_MODE = "browser"','PDF_GENERATION_MODE = "browser"\nBACKGROUND_EXECUTION_MODE = "staged"');
  assert.equal(checkConfiguration(base).ok,false);
  const minute=base.replace('crons = ["*/5 * * * *"]','crons = ["* * * * *"]');assert.equal(checkConfiguration(minute).ok,true);
  assert.equal(checkConfiguration(minute.replace('MAIL_PROVIDER = "dry-run"','MAIL_PROVIDER = "resend"')).ok,false);
});
