// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {runInboxPipelineStep} from '../src/staged-inbox.js';
import {openJobValue} from '../src/background-jobs.js';
import {inboxAllowsDelivery} from '../src/background-scheduler.js';
import {processContactEmailReplies} from '../src/worker.js';
import {REPLY_COMMANDS} from '../src/i18n.js';
import {createInvocationBudget,wrapBudgetDatabase} from '../src/invocation-budget.js';

const anchor='2030-01-01T00:00:00.000Z',time=minutes=>new Date(Date.parse(anchor)+minutes*60000).toISOString();
const base64url=bytes=>Buffer.from(bytes).toString('base64url');
async function fixture(t,{ids=['synthetic-a']}={}){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),env={CONTENT_ENCRYPTION_KEY:'synthetic-inbox-content',BACKGROUND_EXECUTION_MODE:'staged',BACKGROUND_LANE_SCHEDULING:'true',MAIL_PROVIDER:'gmail',INBOUND_PROVIDER:'gmail',MAIL_INBOUND_ENABLED:'true',BASE_URL:'https://example.invalid',FROM_EMAIL:'synthetic@example.invalid'};
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now:anchor});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const messages=new Map(ids.map(id=>[id,{id,threadId:'thread-'+id,from:'unknown@example.invalid',recipients:'synthetic@example.invalid',subject:'Synthetic message',body:'SYNTHETIC_PRIVATE_MESSAGE_BODY_'+id,authenticationPassed:true,receivedAt:time(0)}])),calls=[];
  const provider={name:'gmail',async listInboundPage({pageToken}){calls.push({phase:'list',pageToken});return {messages:ids.map(id=>({id,threadId:'thread-'+id})),nextPageToken:''};},async fetchInboundDetail({id}){calls.push({phase:'detail',id});return messages.get(id);}};
  const f={db,repo,env,provider,messages,calls};f.step=(minute,options={})=>runInboxPipelineStep(repo,env,time(minute),{provider,processReplies:processContactEmailReplies,...options});f.meta=async()=>JSON.parse(await repo.getCursor('background-inbox'));f.job=async()=>db.prepare("SELECT * FROM background_jobs WHERE kind='inbox' ORDER BY created_at DESC,id DESC LIMIT 1").first();return f;
}
async function contact(f,{command=REPLY_COMMANDS.en[1]}={}){
  const token=base64url(new TextEncoder().encode('synthetic-inbox-token-material')),hash=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))));
  const id=await f.repo.createContact({name:'Synthetic contact',email:'contact@example.invalid',role:'friend',priority:1,tokenHash:hash});
  await f.repo.rotateContactToken({id,tokenHash:hash,expectedRound:1});await f.repo.updateOwnerState('VERIFY',anchor,1);
  const message={...f.messages.get('synthetic-a'),from:'contact@example.invalid',recipients:'synthetic+verify-'+token+'@gmail.com',body:command};f.messages.set(message.id,message);return {id,token,message};
}

test('inbox bootstrap, list, detail and apply are separate durable steps with encrypted contents',async t=>{
  const f=await fixture(t);
  assert.equal((await f.step(0)).phase,'bootstrap');assert.equal(f.calls.length,0);
  assert.equal(await inboxAllowsDelivery(f.repo,f.env,1,time(0)),false);
  const listed=await f.step(1);assert.equal(listed.phase,'list');assert.equal(listed.candidate,true);assert.equal(f.calls.length,1);
  let row=await f.job(),checkpoint=await openJobValue(f.env,row.checkpoint);assert.equal(checkpoint.phase,'detail');assert.equal(checkpoint.id,'synthetic-a');
  assert.equal((await f.step(2)).phase,'detail');assert.equal(f.calls.length,2);
  row=await f.job();checkpoint=await openJobValue(f.env,row.checkpoint);assert.equal(checkpoint.phase,'apply');assert.equal(checkpoint.message.body,f.messages.get('synthetic-a').body);assert.doesNotMatch(row.payload+row.checkpoint,/SYNTHETIC_PRIVATE_MESSAGE_BODY/);
  const applied=await f.step(3);assert.equal(applied.phase,'apply');assert.equal(applied.ignored,1);assert.equal(applied.status,'healthy');assert.equal(f.calls.length,2);
  row=await f.job();assert.equal(row.state,'completed');assert.equal(row.lease_token,null);assert.equal((await f.db.prepare('SELECT status FROM inbound_mail_log').first()).status,'ignored');
  const metadata=await f.meta();assert.equal(metadata.closed,true);assert.ok(Date.parse(metadata.started_at)>=Date.parse(time(1)));assert.ok(Date.parse(metadata.started_at)<Date.parse(time(2)));
  assert.equal(await inboxAllowsDelivery(f.repo,f.env,1,time(5)),true,'odd-minute work has a stable fresh generation window');
  assert.equal((await f.step(4)).phase,'idle');assert.equal(f.calls.length,2);
});

test('an empty list closes without a detail request and never consumes a send quota',async t=>{
  const f=await fixture(t,{ids:[]});await f.step(0);const result=await f.step(1);assert.equal(result.phase,'list');assert.equal(result.status,'healthy');assert.equal(f.calls.length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM mail_claims').first()).count,0);
});

test('multiple candidates retain one generation start and an old tail cannot refresh its freshness',async t=>{
  const f=await fixture(t,{ids:['synthetic-a','synthetic-b']});
  await f.step(0);await f.step(1);const first=await f.meta();await f.step(2);assert.equal((await f.step(3)).backlog,true);
  await f.step(4);await f.step(5);const result=await f.step(7);assert.equal(result.closed,true);assert.equal(result.status,'degraded');
  const last=await f.meta();assert.equal(last.generation_id,first.generation_id);assert.equal(last.started_at,first.started_at);assert.equal(last.completed_at,null);assert.equal(await inboxAllowsDelivery(f.repo,f.env,1,time(7)),false);
  await f.step(8);const fresh=await f.step(9);assert.equal(fresh.status,'healthy');assert.notEqual((await f.meta()).generation_id,first.generation_id);
});

test('a new owner round discards the old candidate and always begins with an empty page cursor',async t=>{
  const f=await fixture(t);await f.step(0);await f.step(1);const old=(await f.meta()).generation_id;
  await f.repo.setCursor('gmail-inbox-page','old-tail');await f.repo.checkin(time(2));
  assert.equal((await f.step(3)).phase,'bootstrap');const current=await f.meta();assert.equal(current.round,2);assert.notEqual(current.generation_id,old);assert.equal(await f.repo.getCursor('gmail-inbox-page'),'');
  await f.step(4);assert.equal(f.calls.at(-1).pageToken,'');assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM inbound_mail_log').first()).count,0);
});

test('round changes while fetching a detail prevent the old checkpoint from persisting',async t=>{
  const f=await fixture(t);await f.step(0);await f.step(1);const old=await f.job();f.provider.fetchInboundDetail=async()=>{await f.repo.checkin(time(2));return f.messages.get('synthetic-a');};
  const result=await f.step(2);assert.equal(result.ok,false);assert.equal((await openJobValue(f.env,(await f.db.prepare('SELECT * FROM background_jobs WHERE id=?').bind(old.id).first()).checkpoint)).phase,'detail');
  assert.equal((await f.step(3)).phase,'bootstrap');assert.equal((await f.meta()).round,2);
});

test('losing an apply lease prevents votes and every subsequent progress write',async t=>{
  const f=await fixture(t);await contact(f);await f.step(0);await f.step(1);await f.step(2);
  const before=await f.meta();
  const result=await f.step(3,{processReplies:async options=>{
    await f.db.prepare("UPDATE background_jobs SET lease_token='other-worker' WHERE id=?").bind(options.repo.inboxFence.jobId).run();
    return processContactEmailReplies(options);
  }});
  assert.equal(result.ok,false);assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM confirmation_votes').first()).count,0);assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM inbound_mail_log').first()).count,0);assert.equal((await f.meta()).generation_id,before.generation_id);assert.equal((await f.meta()).status,'scanning');
});

test('authenticated confirmations retain the normal processor and queue their notice without dispatch',async t=>{
  const f=await fixture(t);const c=await contact(f);await f.step(0);await f.step(1);await f.step(2);const result=await f.step(3);
  assert.equal(result.processed,1);assert.equal(result.status,'healthy');assert.equal((await f.db.prepare('SELECT status FROM confirmation_votes WHERE contact_id=?').bind(c.id).first()).status,'confirmed_death');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE kind='notice'").first()).count,1);assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM mail_claims').first()).count,0);
});

test('a real false alarm advances the round once and finishes its fenced audit and notice',async t=>{
  const f=await fixture(t);await contact(f,{command:REPLY_COMMANDS.en[2]});await f.step(0);await f.step(1);await f.step(2);const result=await f.step(3);
  assert.equal(result.processed,1);assert.equal(result.reason,'round-changed');assert.equal((await f.repo.getOwner()).confirmation_round,2);assert.equal((await f.db.prepare('SELECT status FROM inbound_mail_log').first()).status,'processed');assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type='false_alarm'").first()).count,1);
  const notice=await f.db.prepare("SELECT confirmation_round FROM background_jobs WHERE kind='notice'").first();assert.equal(notice.confirmation_round,2);assert.equal(await inboxAllowsDelivery(f.repo,f.env,2,time(3)),false);
});

test('incomplete details remain failed and block an otherwise terminal mailbox',async t=>{
  const f=await fixture(t);f.messages.set('synthetic-a',{...f.messages.get('synthetic-a'),incomplete:true});await f.step(0);await f.step(1);await f.step(2);const result=await f.step(3);
  assert.equal(result.failed,1);assert.equal(result.closed,false);assert.equal((await f.db.prepare('SELECT status FROM inbound_mail_log').first()).status,'failed');assert.equal(await inboxAllowsDelivery(f.repo,f.env,1,time(3)),false);
});

test('legacy old-round failed IDs are not selected as new-round messages forever',async t=>{
  const f=await fixture(t);await f.db.prepare("INSERT INTO inbound_mail_log(gmail_message_id,status,processed_at,confirmation_round,source) VALUES('synthetic-a','failed',?,0,'gmail')").bind(anchor).run();await f.step(0);const result=await f.step(1);assert.equal(result.status,'healthy');assert.equal(f.calls.filter(call=>call.phase==='detail').length,0);
});

test('a provider page failure leaves a resumable failed job and cannot create healthy status',async t=>{
  const f=await fixture(t);f.provider.listInboundPage=async()=>{const error=Error('Synthetic page expired');error.statusCode=400;throw error;};await f.step(0);const result=await f.step(1);assert.equal(result.status,'failed');assert.equal((await f.job()).state,'failed');assert.equal(await inboxAllowsDelivery(f.repo,f.env,1,time(1)),false);
  f.provider.listInboundPage=async()=>({messages:[],nextPageToken:''});assert.equal((await f.step(2.1)).status,'healthy');assert.equal((await f.job()).state,'completed');
});

test('a processor summary cannot substitute for a durable terminal inbound record',async t=>{
  const f=await fixture(t);await f.step(0);await f.step(1);await f.step(2);
  const result=await f.step(3,{processReplies:async()=>({ok:true,ignored:1,failed:0,backlog:false})});
  assert.equal(result.closed,false);assert.equal(result.status,'scanning');assert.equal(await inboxAllowsDelivery(f.repo,f.env,1,time(3)),false);assert.equal((await f.job()).state,'pending');
});

test('manual review that ignores an in-flight message prevents a late vote and preserves the reviewed record',async t=>{
  const f=await fixture(t);await contact(f);await f.step(0);await f.step(1);await f.step(2);
  const result=await f.step(3,{processReplies:async options=>{
    const create=options.repo.createConfirmation;
    options.repo.createConfirmation=async args=>{
      await f.db.prepare("UPDATE inbound_mail_log SET status='ignored',reconciliation_note='Reviewed synthetic record' WHERE gmail_message_id=?").bind(options.repo.inboxFence.messageId).run();
      return create.call(options.repo,args);
    };
    return processContactEmailReplies(options);
  }});
  assert.equal(result.processed,0);assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM confirmation_votes').first()).count,0);
  const row=await f.db.prepare('SELECT status,reconciliation_note FROM inbound_mail_log').first();assert.equal(row.status,'ignored');assert.equal(row.reconciliation_note,'Reviewed synthetic record');
});

test('a superseding generation prevents a late apply from updating inbound records or the new cursor',async t=>{
  const f=await fixture(t);await f.step(0);await f.step(1);await f.step(2);
  let newMeta;
  await f.step(3,{processReplies:async options=>{
    newMeta={v:2,round:1,generation_id:'new-generation',job_id:'new-generation',started_at:time(3),status:'scanning',closed:false};
    await f.repo.setCursor('background-inbox',JSON.stringify(newMeta));await f.repo.setCursor('gmail-inbox-page','new-generation-page');
    return processContactEmailReplies(options);
  }});
  assert.deepEqual(await f.meta(),newMeta);assert.equal(await f.repo.getCursor('gmail-inbox-page'),'new-generation-page');assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM inbound_mail_log').first()).count,0);
});

test('actual confirmed and false-alarm apply paths fit the shared SQL budget including lane overhead',async t=>{
  const measurements=[];
  for(const command of [REPLY_COMMANDS.en[1],REPLY_COMMANDS.en[2]]){
    const f=await fixture(t);await contact(f,{command});
    for(let minute=0;minute<4;minute++){
      const budget=createInvocationBudget();budget.consumeD1();budget.consumeD1();
      f.repo.db=wrapBudgetDatabase(f.db,budget);f.repo.invocationBudget=budget;f.repo.invocationRules=new Map();f.repo.invocationSettings=null;f.env.INVOCATION_BUDGET=budget;
      const result=await f.step(minute);measurements.push({command:command===REPLY_COMMANDS.en[2]?'false_alarm':'confirmed_death',phase:result.phase,sql:budget.usedStatements,d1:budget.usedD1});
      assert.equal(result.ok,true);assert.ok(budget.usedStatements<=48);
      if(minute===3)assert.equal(result.processed,1);
    }
  }
  t.diagnostic(JSON.stringify({inbox_sql_budget:measurements}));
});

test('only successful provider reads refresh the operational timestamp while bootstrap and local apply preserve it',async t=>{
  const f=await fixture(t);await f.step(0);let meta=await f.meta();assert.equal(meta.provider_verified_at,null);assert.equal(meta.backlog,false);assert.equal(meta.incomplete,false);
  await f.step(1);meta=await f.meta();const listed=meta.provider_verified_at;assert.ok(Date.parse(listed)>=Date.parse(time(1)));assert.equal(meta.provider_failed,false);
  await f.step(2);const fetched=(await f.meta()).provider_verified_at;assert.ok(Date.parse(fetched)>=Date.parse(time(2)));assert.notEqual(fetched,listed);
  await f.step(3);assert.equal((await f.meta()).provider_verified_at,fetched);
  await f.step(7);meta=await f.meta();assert.equal(meta.provider_verified_at,fetched,'new same-round bootstrap cannot invent a provider observation');assert.equal(meta.backlog,false);
  await f.repo.checkin(time(8));await f.step(9);assert.equal((await f.meta()).provider_verified_at,null,'a new round cannot reuse the previous round provider proof');
});

test('operational metadata exposes backlog, incomplete input and provider failures until a real successful retry',async t=>{
  const f=await fixture(t,{ids:['synthetic-a','synthetic-b']});await f.step(0);await f.step(1);assert.equal((await f.meta()).backlog,true);
  f.messages.set('synthetic-a',{...f.messages.get('synthetic-a'),incomplete:true});await f.step(2);let meta=await f.meta();assert.equal(meta.incomplete,true);assert.equal(meta.backlog,true);const actual=meta.provider_verified_at;
  await f.step(3);meta=await f.meta();assert.equal(meta.incomplete,true);assert.equal(meta.backlog,true);assert.equal(meta.provider_verified_at,actual);
  await f.step(4);assert.equal((await f.meta()).provider_verified_at,actual,'choosing a retry ID locally cannot refresh provider freshness');
  f.provider.fetchInboundDetail=async()=>{throw Error('Synthetic provider outage');};await f.step(5);meta=await f.meta();assert.equal(meta.status,'failed');assert.equal(meta.provider_failed,true);assert.equal(meta.provider_verified_at,actual);
  f.provider.fetchInboundDetail=async()=>({...f.messages.get('synthetic-a'),incomplete:false});await f.step(6.1);meta=await f.meta();assert.equal(meta.provider_failed,false);assert.equal(meta.incomplete,false);assert.ok(Date.parse(meta.provider_verified_at)>Date.parse(actual));
});

test('a same-round bootstrap retains known degradation until it obtains a fresh successful observation',async t=>{
  const f=await fixture(t,{ids:[]});await f.step(0);await f.step(1);const before=await f.meta();
  await f.repo.setCursor('background-inbox',JSON.stringify({...before,status:'degraded',closed:true,backlog:true,incomplete:true,provider_failed:true}));
  await f.step(2);let meta=await f.meta();assert.equal(meta.backlog,true);assert.equal(meta.incomplete,true);assert.equal(meta.provider_failed,true);assert.equal(meta.provider_verified_at,before.provider_verified_at);
  await f.step(3);meta=await f.meta();assert.equal(meta.status,'healthy');assert.equal(meta.backlog,false);assert.equal(meta.incomplete,false);assert.equal(meta.provider_failed,false);assert.ok(Date.parse(meta.provider_verified_at)>Date.parse(before.provider_verified_at));
});
