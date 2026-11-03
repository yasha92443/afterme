// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {GmailMailProvider,buildGmailMimeMessage} from '../src/mail.js';
import {enqueueJob,openJobValue,sealJobValue} from '../src/background-jobs.js';
import {runStagedMail} from '../src/staged-mail.js';

const initial='2030-01-01T00:00:00.000Z';
const uri='https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=synthetic';
async function fixture(t,{attachment=false,loseFinal=false,partial=false,textLoss=false}={}){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),env={DB:db,CONTENT_ENCRYPTION_KEY:'staged-mail-synthetic-content',MAIL_PROVIDER:'gmail',FROM_EMAIL:'sender@example.invalid',GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',BACKGROUND_EXECUTION_MODE:'staged',MAX_DAILY_EMAILS:'20'};
  await repo.setupOwner({displayName:'Synthetic',email:'owner@example.invalid',now:initial});await repo.getSettings(env);const owner=await repo.getOwner();await repo.getRoundRules(owner);
  const payload={dedupeKey:'synthetic-canonical-mail',eventType:'private_letter_release'},bytes=Uint8Array.from({length:600000},(_,i)=>i%251);
  const message={from:env.FROM_EMAIL,to:'reader@example.invalid',subject:'Synthetic 文🙂',text:'Synthetic body 文🙂',...(attachment?{attachment:{filename:'synthetic.pdf',contentType:'application/pdf',byteLength:bytes.length}}:{})};
  await enqueueJob(repo,env,{key:'synthetic-job',kind:'mail',round:owner.confirmation_round,payload,now:initial});
  const provider=new GmailMailProvider(env);provider.cachedToken='synthetic-access';provider.tokenExpiresAt=Date.now()+3600000;
  let now=initial,starts=0,finalPuts=0,probes=0,textPuts=0,accepted=Buffer.alloc(0),lost=loseFinal,first=partial,receiptHooks=0;
  const transport=async(url,init)=>{
    const data=Buffer.from(await new Response(init.body).arrayBuffer());
    if(String(url).includes('uploadType=media')){textPuts++;assert.ok(data.toString().includes('Synthetic body'));if(textLoss)throw Error('Synthetic text receipt lost');return Response.json({id:'synthetic-text',threadId:'synthetic-thread'});}
    if(init.method==='POST'){starts++;assert.equal(data.length,0);return new Response(null,{headers:{Location:uri}});}
    const range=init.headers['Content-Range'];
    if(range.startsWith('bytes */')){probes++;assert.equal(data.length,0);if(finalPuts)return Response.json({id:'synthetic-sent',threadId:'synthetic-thread'});return new Response(null,{status:308,headers:accepted.length?{Range:'bytes=0-'+(accepted.length-1)}:{}});}
    const match=range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);assert.ok(match);const offset=Number(match[1]),end=Number(match[2]),total=Number(match[3]);assert.equal(data.length,end-offset+1);assert.equal(offset,accepted.length);
    if(first){first=false;accepted=Buffer.concat([accepted,data.subarray(0,131072)]);return new Response(null,{status:308,headers:{Range:'bytes=0-'+(accepted.length-1)}});}
    accepted=Buffer.concat([accepted,data]);if(end+1<total)return new Response(null,{status:308,headers:{Range:'bytes=0-'+(accepted.length-1)}});
    finalPuts++;if(lost){lost=false;throw Error('Synthetic final receipt lost');}return Response.json({id:'synthetic-sent',threadId:'synthetic-thread'});
  };
  const options={provider,transport,prepare:async()=>({message}),canSend:async()=>true,readAttachmentRange:async(_j,_p,_c,start,length)=>bytes.subarray(start,start+length),onResult:async()=>{receiptHooks++;}};
  return {db,repo,env,options,bytes,message,payload,get accepted(){return accepted;},get counters(){return {starts,finalPuts,probes,textPuts,receiptHooks};},
    async tick(){const result=await runStagedMail(repo,env,now,options);now=new Date(Date.parse(now)+300000).toISOString();return result;},
    async job(){return db.prepare('SELECT * FROM background_jobs').first();},
    async checkpoint(){return openJobValue(env,(await this.job()).checkpoint);},
  };
}

test('staged PDF advances bounded ticks and resumes a partial acknowledged range without changing MIME',async t=>{
  const f=await fixture(t,{attachment:true,partial:true});assert.equal((await f.tick()).status,'prepared');assert.equal((await f.tick()).status,'started');
  for(let i=0;i<12&&(await f.job()).state!=='completed';i++)await f.tick();
  assert.equal((await f.job()).state,'completed');const checkpoint=await f.checkpoint();
  assert.deepEqual(f.accepted,Buffer.from(buildGmailMimeMessage({...f.message,boundary:checkpoint.descriptor.boundary,messageId:checkpoint.descriptor.messageId,attachments:[{...f.message.attachment,data:f.bytes}]})));
  assert.equal(f.counters.starts,1);assert.equal(f.counters.finalPuts,1);assert.equal(f.counters.receiptHooks,1);
  const claim=await f.db.prepare('SELECT * FROM mail_claims').first();assert.equal(claim.status,'sent');assert.equal(claim.provider_message_id,'synthetic-sent');assert.ok(claim.attempt_id);
  assert.equal((await f.tick()).status,'idle');assert.equal((await f.repo.listDeliveryLog()).results.length,1);
});

test('temporary inbox unavailability retains nonfinal upload progress and resumes the same session',async t=>{
  const f=await fixture(t,{attachment:true});f.options.deliveryReady=async()=>false;
  await f.tick();await f.tick();for(let i=0;i<3;i++)await f.tick();
  const before=await f.checkpoint();assert.ok(before.offset>0);assert.equal(f.counters.starts,1);
  const deferred=await f.tick();assert.equal(deferred.status,'deferred');assert.equal(deferred.reason,'inbox-not-fresh');
  const after=await f.checkpoint();assert.equal(after.offset,before.offset);assert.deepEqual(after.session,before.session);assert.equal((await f.job()).state,'pending');assert.equal(f.counters.finalPuts,0);assert.equal(await f.db.prepare('SELECT * FROM mail_claims').first(),null);
  f.options.deliveryReady=async()=>true;for(let i=0;i<3&&(await f.job()).state!=='completed';i++)await f.tick();
  assert.equal((await f.job()).state,'completed');assert.equal(f.counters.starts,1);assert.equal(f.counters.finalPuts,1);
});

test('inbox becoming unavailable after final claim releases only that attempt and preserves the upload',async t=>{
  const f=await fixture(t,{attachment:true});await f.tick();await f.tick();for(let i=0;i<3;i++)await f.tick();
  const before=await f.checkpoint();let reads=0;f.options.deliveryReady=async()=>++reads===1;
  const deferred=await f.tick();assert.equal(deferred.status,'deferred');assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'cancelled');assert.equal(f.counters.finalPuts,0);
  const after=await f.checkpoint();assert.equal(after.finalAttemptId,null);assert.equal(after.offset,before.offset);assert.deepEqual(after.session,before.session);
  f.options.deliveryReady=async()=>true;for(let i=0;i<3&&(await f.job()).state!=='completed';i++)await f.tick();assert.equal(f.counters.starts,1);assert.equal(f.counters.finalPuts,1);assert.equal((await f.job()).state,'completed');
});

test('a lost final response causes one status probe and no repeated final PUT or new session',async t=>{
  const f=await fixture(t,{attachment:true,loseFinal:true});let result;
  for(let i=0;i<12;i++){result=await f.tick();if(result.status==='probe_required')break;}
  assert.equal(result.status,'probe_required');const checkpoint=await f.checkpoint();assert.equal(checkpoint.phase,'probe');assert.ok(checkpoint.finalAttemptId);assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'sending');
  const recovered=await f.tick();assert.equal(recovered.status,'sent');assert.deepEqual(f.counters,{starts:1,finalPuts:1,probes:1,textPuts:0,receiptHooks:1});assert.equal((await f.job()).state,'completed');
});

test('an expired final upload session becomes uncertain and is never replaced',async t=>{
  const f=await fixture(t,{attachment:true,loseFinal:true});for(let i=0;i<12;i++)if((await f.tick()).status==='probe_required')break;
  f.options.transport=async(_url,init)=>{assert.match(init.headers['Content-Range'],/^bytes \*\//);assert.equal((await new Response(init.body).arrayBuffer()).byteLength,0);return new Response(null,{status:404});};
  assert.equal((await f.tick()).status,'uncertain');assert.equal((await f.job()).state,'uncertain');assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'uncertain');assert.equal((await f.tick()).status,'idle');assert.equal(f.counters.starts,1);assert.equal(f.counters.finalPuts,1);
});

test('text media persists its intent before dispatch and keeps an unknown result terminal',async t=>{
  const f=await fixture(t,{textLoss:true});assert.equal((await f.tick()).status,'prepared');assert.equal((await f.tick()).status,'uncertain');
  assert.equal((await f.job()).state,'uncertain');assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'uncertain');assert.equal(f.counters.textPuts,1);assert.equal((await f.tick()).status,'idle');
});

test('restarting after a durable text intent never calls the provider again',async t=>{
  const f=await fixture(t);await f.tick();let calls=0;
  f.options.provider.sendMedia=async message=>{calls++;assert.equal(await message.beforeFinal(),true);throw Error('Synthetic process interrupted before receipt');};
  assert.equal((await f.tick()).status,'probe_required');assert.equal((await f.checkpoint()).phase,'text-probe');assert.equal((await f.tick()).status,'uncertain');assert.equal(calls,1);
});

test('a known provider receipt survives a later logging failure without any extra provider request',async t=>{
  const f=await fixture(t);await f.tick();const original=f.repo.logDelivery.bind(f.repo);let fail=true;
  f.repo.logDelivery=async args=>{if(fail){fail=false;throw Error('Synthetic receipt log failure');}return original(args);};
  assert.equal((await f.tick()).status,'probe_required');assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'sent');
  assert.equal((await f.tick()).status,'sent');assert.equal(f.counters.textPuts,1);assert.equal(f.counters.receiptHooks,1);assert.equal((await f.job()).state,'completed');
});

test('losing the job lease after claiming cancels that attempt and prevents final dispatch',async t=>{
  const f=await fixture(t),claim=f.repo.claimMail.bind(f.repo);await f.tick();
  f.repo.claimMail=async(...args)=>{const result=await claim(...args);await f.db.prepare("UPDATE background_jobs SET lease_token='different-owner',attempt_id='different-attempt'").run();return result;};
  await f.tick();assert.equal(f.counters.textPuts,0);assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'cancelled');assert.equal((await f.job()).lease_token,'different-owner');
});

test('a changed round before final intent prevents dispatch and clears the unsubmitted canonical claim',async t=>{
  const f=await fixture(t),claim=f.repo.claimMail.bind(f.repo);await f.tick();
  f.repo.claimMail=async(...args)=>{const result=await claim(...args);await f.db.prepare('UPDATE owner SET confirmation_round=confirmation_round+1').run();return result;};
  await f.tick();assert.equal(f.counters.textPuts,0);assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'cancelled');
});

test('dry-run PDF validation consumes every bounded MIME range without an external transport',async t=>{
  const f=await fixture(t,{attachment:true});let sends=0,reads=0;f.options.provider={name:'dry-run',async send(){sends++;return {status:'dry_run'};}};f.options.transport=()=>{throw Error('Unexpected network transport');};
  const read=f.options.readAttachmentRange;f.options.readAttachmentRange=async(...args)=>{reads++;return read(...args);};
  for(let i=0;i<12&&(await f.job()).state!=='completed';i++)await f.tick();
  assert.equal((await f.job()).state,'completed');assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'dry_run');assert.equal(sends,1);assert.ok(reads>=3);
});

test('a recovered incomplete probe releases its old final claim before a new attempt',async t=>{
  const f=await fixture(t,{attachment:true});await f.tick();await f.tick();
  const row=await f.job(),checkpoint=await f.checkpoint();const attempt='synthetic-old-final';await f.repo.claimMail(f.payload.dedupeKey,initial,20,attempt);
  checkpoint.phase='probe';checkpoint.finalAttemptId=attempt;await f.db.prepare('UPDATE background_jobs SET checkpoint=?').bind(await sealJobValue(f.env,checkpoint)).run();
  assert.equal((await f.tick()).status,'pending');assert.equal((await f.db.prepare('SELECT status FROM mail_claims').first()).status,'cancelled');assert.equal((await f.checkpoint()).finalAttemptId,null);assert.equal((await f.checkpoint()).phase,'upload');assert.equal(row.id,(await f.job()).id);
});
