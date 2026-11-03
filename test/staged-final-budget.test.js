// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {database} from './helpers/database.js';
import {testChineseFont} from './helpers/pdf-fonts.js';
import {Repository} from '../src/repository.js';
import {defaultRules} from '../src/settings.js';
import {buildStoredPayload} from '../src/content.js';
import {GmailMailProvider} from '../src/mail.js';
import {beginArtifact,uploadArtifactChunk,completeArtifact,runArtifactValidationStep,pdfDigest,PDF_CHUNK_BYTES} from '../src/pdf-artifacts.js';
import {runDiscoveryStage} from '../src/staged-runtime.js';
import {runScheduledCheck} from '../src/worker.js';
import {createInvocationBudget} from '../src/invocation-budget.js';
import {openJobValue} from '../src/background-jobs.js';
import {buildPrivateLetterPdfAsync} from '../src/pdf.js';
import {GMAIL_MAX_MIME_BYTES,MAIL_UPLOAD_CHUNK_BYTES} from '../src/mail-upload.js';

const anchor='2030-01-01T00:00:00.000Z',initial='2030-01-10T00:00:00.000Z';
const session='https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=synthetic-budget';
async function fixture(t,{kind,size,occupied=19,loseFinal=false,losePartAt=0,pdfBytes=null,captureMime=false,maxPdfBytes=null}){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),env={DB:db,CONTENT_ENCRYPTION_KEY:'synthetic-final-budget-key',BACKGROUND_EXECUTION_MODE:'staged',MAIL_PROVIDER:'gmail',INBOUND_PROVIDER:'gmail',PDF_GENERATION_MODE:'browser',GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',FROM_EMAIL:'sender@example.invalid',MAX_DAILY_EMAILS:'20',CONTACT_NOTIFICATIONS_ENABLED:'false'};
  if(maxPdfBytes)env.PDF_MAX_BYTES=String(maxPdfBytes);
  await repo.setupOwner({displayName:'Synthetic',email:'owner@example.invalid',now:anchor});
  const contact=await repo.createContact({name:'Synthetic contact',email:'contact@example.invalid',role:'friend',priority:1,tokenHash:'synthetic'}),recipient=await repo.createRecipient({name:'Synthetic reader',email:'reader@example.invalid',now:anchor});
  const settings=await repo.getSettings(env),rules=defaultRules([contact]);rules.private.quorum=1;rules.public.quorum=1;rules.private.grace_hours=0;rules.public.grace_hours=0;rules.public.audience=['contact:'+contact];
  await repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,selfcheck:false},rules,now:anchor});await repo.checkin(anchor);const owner=await repo.getOwner();
  await db.prepare("UPDATE owner SET state='PUBLIC_RELEASE' WHERE id=1").run();await repo.rotateContactToken({id:contact,tokenHash:'synthetic-current',expectedRound:owner.confirmation_round});assert.equal(await repo.createConfirmation({contactId:contact,status:'confirmed_death',round:owner.confirmation_round,now:anchor}),true);
  await repo.upsertPublicFarewell({title:'Synthetic public',body:'',status:'PUBLIC_RELEASE',now:anchor});await db.prepare('UPDATE release_progress SET ready_at=?,released_at=? WHERE round=?').bind(anchor,anchor,owner.confirmation_round).run();
  let item=0;if(kind==='private'){const payload=await buildStoredPayload({body:{plaintext:'Tiny synthetic body'},env});item=await repo.createEncryptedItem({kind:'letter',title:'Synthetic',recipientId:recipient,encryptedPayload:payload,payloadSize:payload.length,vaultToken:'synthetic',vaultTokenHash:'synthetic',updatedAt:anchor});await db.prepare('UPDATE encrypted_items SET released_at=? WHERE id=?').bind(anchor,item).run();}
  const bytes=pdfBytes||new Uint8Array(size);if(!pdfBytes){bytes.fill(120);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));bytes.set(new TextEncoder().encode('\n%%EOF\n'),size-7);}else assert.equal(bytes.length,size);
  const artifact=await beginArtifact(repo,env,{kind,id:item,locale:'zh'});for(let index=0;index*PDF_CHUNK_BYTES<size;index++)await uploadArtifactChunk(repo,env,artifact.id,index,Buffer.from(bytes.subarray(index*PDF_CHUNK_BYTES,(index+1)*PDF_CHUNK_BYTES)).toString('base64'));
  await completeArtifact(repo,env,artifact.id,{total_bytes:size,chunk_count:Math.ceil(size/PDF_CHUNK_BYTES),sha256:await pdfDigest(bytes)});
  for(let step=0;step<=Math.ceil(size/PDF_CHUNK_BYTES);step++)await runArtifactValidationStep(repo,env,{artifact_id:artifact.id},initial);
  assert.equal((await db.prepare('SELECT status FROM pdf_artifacts WHERE id=?').bind(artifact.id).first()).status,'ready');
  await repo.setCursor('background-discovery',kind==='private'?'1':'2');assert.equal((await runDiscoveryStage(repo,env,initial)).created,true);
  for(let index=0;index<occupied;index++)await db.prepare("INSERT INTO mail_claims(dedupe_key,status,claimed_at,attempt_id) VALUES(?,'sent',?,?)").bind('synthetic-used-'+index,initial,'synthetic-previous-'+index).run();
  let accepted=0,finalPuts=0,starts=0,parts=0,probes=0,partResponseLost=false;const received=[];
  const provider=new GmailMailProvider(env);provider.cachedToken='synthetic-access';provider.tokenExpiresAt=Date.now()+3600000;
  provider.transport=async(url,init)=>{
    const body=new Uint8Array(await new Response(init.body).arrayBuffer());assert.ok(body.length<=256*1024);
    if(init.method==='POST'){starts++;assert.equal(body.length,0);return new Response(null,{headers:{Location:session}});}
    const range=init.headers['Content-Range'];if(range.startsWith('bytes */')){probes++;assert.equal(body.length,0);const total=Number(range.slice(8));if(accepted<total)return new Response(null,{status:308,headers:{Range:'bytes=0-'+(accepted-1)}});assert.equal(finalPuts,1);return Response.json({id:'synthetic-final-receipt',threadId:'synthetic-final-thread'});}
    const match=range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);assert.ok(match,'Only actual ranged MIME upload is expected');const [offset,end,total]=match.slice(1).map(Number);assert.equal(offset,accepted);assert.equal(end-offset+1,body.length);
    if(!parts)assert.match(new TextDecoder().decode(body),/Content-Type: application\/pdf/);parts++;accepted+=body.length;if(captureMime)received.push(body);
    if(accepted<total){if(losePartAt&&!partResponseLost&&accepted>=losePartAt){partResponseLost=true;throw Error('Synthetic partial response lost after acceptance');}return new Response(null,{status:308,headers:{Range:'bytes=0-'+(accepted-1)}});}
    finalPuts++;if(loseFinal)throw Error('Synthetic final response lost');return Response.json({id:'synthetic-final-receipt',threadId:'synthetic-final-thread'});
  };
  return {db,repo,env,provider,owner,item,size,get counters(){return {accepted,finalPuts,starts,parts,probes,partResponseLost};},receivedMime(){return Buffer.concat(received);}};
}

async function tick(f,index){
  const now=new Date(Date.parse(initial)+index*60000).toISOString();await f.db.prepare('UPDATE background_scheduler SET control_at=?,inbox_at=?,maintenance_at=?,lease_token=NULL,lease_until=NULL,next_kind=0 WHERE id=1').bind(now,now,now).run();await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,generation_id:'synthetic-generation',started_at:now,status:'healthy',completed_at:now}));
  const budget=createInvocationBudget({d1:48,statements:48,external:45}),result=await runScheduledCheck(f.repo,{...f.env,INVOCATION_BUDGET:budget},new Date(now),f.provider);
  assert.equal(result.stage,'mail');assert.ok(budget.usedStatements<=48);return {result:result.result,sql:budget.usedStatements,external:budget.usedExternal};
}

for(const kind of ['public','private'])for(const size of [32,8*1024*1024])test('complete '+kind+' '+size+' byte PDF mail ticks fit 48 SQL with nineteen occupied daily slots',async t=>{
  const f=await fixture(t,{kind,size}),steps=[];
  for(let index=0;index<60;index++){
    const now=new Date(Date.parse(initial)+index*60000).toISOString();await f.db.prepare('UPDATE background_scheduler SET control_at=?,inbox_at=?,maintenance_at=?,lease_token=NULL,lease_until=NULL,next_kind=0 WHERE id=1').bind(now,now,now).run();await f.repo.setCursor('background-inbox',JSON.stringify({round:f.owner.confirmation_round,generation_id:'synthetic-generation',started_at:now,status:'healthy',completed_at:now}));
    const budget=createInvocationBudget({d1:48,statements:48,external:45});let result;
    try{result=await runScheduledCheck(f.repo,{...f.env,INVOCATION_BUDGET:budget},new Date(now),f.provider);}catch(error){t.diagnostic(JSON.stringify({kind,size,index,steps,budget:{d1:budget.usedD1,sql:budget.usedStatements},error:error.name}));throw error;}
    assert.equal(result.stage,'mail');steps.push({status:result.result.status,sql:budget.usedStatements,external:budget.usedExternal});
    assert.ok(budget.usedStatements<=48);assert.ok(budget.usedD1<=48);if(result.result.status==='sent')break;
    assert.ok(['prepared','started','pending'].includes(result.result.status),JSON.stringify(steps));
  }
  const job=await f.db.prepare("SELECT * FROM background_jobs WHERE kind='mail'").first(),checkpoint=await openJobValue(f.env,job.checkpoint),claim=await f.db.prepare('SELECT * FROM mail_claims WHERE dedupe_key=?').bind(job.dedupe_key).first();
  assert.equal(job.state,'completed',JSON.stringify(steps));assert.equal(claim.status,'sent');assert.equal(claim.provider_message_id,'synthetic-final-receipt');assert.equal(f.counters.finalPuts,1);assert.equal(f.counters.starts,1);assert.equal(f.counters.accepted,checkpoint.descriptor.totalBytes);assert.ok(f.counters.accepted>size);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM mail_claims WHERE status='sent'").first()).count,20);
  if(kind==='private')assert.equal((await f.db.prepare('SELECT status FROM private_delivery_state WHERE item_id=?').bind(f.item).first()).status,'sent');
  t.diagnostic(JSON.stringify({kind,pdfBytes:size,mimeBytes:f.counters.accepted,ticks:steps.length,maxSql:Math.max(...steps.map(s=>s.sql)),finalSql:steps.at(-1).sql,parts:f.counters.parts}));
});

// Keep the real generated document and its saved text, then add bounded PDF
// comments before %%EOF to exercise large binary storage and transport. The
// padding is synthetic capacity data, not a claim about a 24 MiB text layout.
async function largeSyntheticPdf(size){
  const source=await buildPrivateLetterPdfAsync({body:'Tiny synthetic body',ownerName:'Synthetic',recipientName:'Synthetic reader',locale:'zh',chineseFont:testChineseFont});
  assert.equal(Buffer.from(source.subarray(-5)).toString('ascii'),'%%EOF');
  assert.ok(source.length<size);
  const bytes=new Uint8Array(size),prefixLength=source.length-5,gap=size-source.length;
  bytes.set(source.subarray(0,prefixLength));bytes.fill(65,prefixLength,prefixLength+gap);
  for(let i=0;i<gap;i+=80){bytes[prefixLength+i]=37;if(i+79<gap)bytes[prefixLength+i+79]=10;}
  bytes[prefixLength+gap-1]=10;bytes.set(source.subarray(-5),size-5);
  return bytes;
}

for(const mib of [9,16,24])test(`generated ${mib} MiB private PDF survives staged storage, MIME upload and receiver reconstruction`,async t=>{
  const size=mib*1024*1024,pdfBytes=await largeSyntheticPdf(size),f=await fixture(t,{kind:'private',size,pdfBytes,captureMime:true,maxPdfBytes:24*1024*1024}),steps=[];
  for(let index=0;index<160;index++){
    const step=await tick(f,index);steps.push({status:step.result.status,sql:step.sql});
    if(step.result.status==='sent')break;
    assert.ok(['prepared','started','pending'].includes(step.result.status),JSON.stringify(steps.at(-1)));
  }
  const job=await f.db.prepare("SELECT * FROM background_jobs WHERE kind='mail'").first(),checkpoint=await openJobValue(f.env,job.checkpoint),claim=await f.db.prepare('SELECT * FROM mail_claims WHERE dedupe_key=?').bind(job.dedupe_key).first();
  assert.equal(job.state,'completed',JSON.stringify(steps.at(-1)));assert.equal(claim.status,'sent');assert.equal(claim.provider_message_id,'synthetic-final-receipt');
  assert.equal((await f.db.prepare('SELECT status FROM private_delivery_state WHERE item_id=?').bind(f.item).first()).status,'sent');
  assert.equal(f.counters.finalPuts,1);assert.equal(f.counters.starts,1);assert.equal(f.counters.parts,Math.ceil(checkpoint.descriptor.totalBytes/MAIL_UPLOAD_CHUNK_BYTES));
  assert.ok(checkpoint.descriptor.totalBytes<=GMAIL_MAX_MIME_BYTES);assert.equal(f.counters.accepted,checkpoint.descriptor.totalBytes);
  const mime=f.receivedMime(),prefix=Buffer.from(checkpoint.descriptor.prefix,'utf8'),suffix=Buffer.from(checkpoint.descriptor.suffix,'utf8');
  assert.equal(mime.length,checkpoint.descriptor.totalBytes);assert.deepEqual(mime.subarray(0,prefix.length),prefix);assert.deepEqual(mime.subarray(mime.length-suffix.length),suffix);
  assert.match(prefix.toString('utf8'),/reader@example\.invalid/);assert.match(prefix.toString('utf8'),/Content-Type: application\/pdf/);
  const encoded=mime.subarray(prefix.length,mime.length-suffix.length).toString('ascii');
  assert.equal(Buffer.byteLength(encoded),checkpoint.descriptor.attachmentEncodedBytes);
  const decoded=Buffer.from(encoded.replace(/\r\n/g,''),'base64');
  const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(decoded.length,size);assert.equal(sha256(decoded),sha256(pdfBytes));
  assert.ok(steps.every(step=>step.sql<=48));
  t.diagnostic(JSON.stringify({pdfMiB:mib,pdfBytes:size,mimeBytes:mime.length,ticks:steps.length,parts:f.counters.parts,sha256:sha256(decoded),maxSql:Math.max(...steps.map(step=>step.sql)),syntheticPadding:true}));
});

test('24 MiB MIME resumes after an accepted part loses its response and probes an accepted final dispatch',async t=>{
  const size=24*1024*1024,pdfBytes=await largeSyntheticPdf(size),f=await fixture(t,{kind:'private',size,pdfBytes,captureMime:true,maxPdfBytes:size,losePartAt:8*1024*1024,loseFinal:true});
  const statuses=[];let minute=0;
  for(let turn=0;turn<160;turn++){
    const step=await tick(f,minute);statuses.push(step.result.status);
    if(step.result.status==='sent')break;
    assert.ok(['prepared','started','pending','probe_required'].includes(step.result.status),step.result.status);
    minute+=step.result.status==='probe_required'?5:1;
  }
  assert.equal(statuses.at(-1),'sent');assert.equal(statuses.filter(status=>status==='probe_required').length,2);
  assert.equal(f.counters.partResponseLost,true);assert.equal(f.counters.probes,2);assert.equal(f.counters.finalPuts,1);assert.equal(f.counters.starts,1);
  const job=await f.db.prepare("SELECT * FROM background_jobs WHERE kind='mail'").first(),checkpoint=await openJobValue(f.env,job.checkpoint),mime=f.receivedMime();
  assert.equal(job.state,'completed');assert.equal(mime.length,checkpoint.descriptor.totalBytes);assert.equal(f.counters.accepted,mime.length);
  const prefix=Buffer.byteLength(checkpoint.descriptor.prefix,'utf8'),suffix=Buffer.byteLength(checkpoint.descriptor.suffix,'utf8');
  const decoded=Buffer.from(mime.subarray(prefix,mime.length-suffix).toString('ascii').replace(/\r\n/g,''),'base64');
  assert.equal(decoded.length,size);assert.equal(createHash('sha256').update(decoded).digest('hex'),createHash('sha256').update(pdfBytes).digest('hex'));
  t.diagnostic(JSON.stringify({pdfMiB:24,mimeBytes:mime.length,ticks:statuses.length,probes:f.counters.probes,finalPuts:f.counters.finalPuts,syntheticPadding:true}));
});

for(const kind of ['public','private'])test(kind+' final dispatch waits when all twenty daily slots are occupied',async t=>{
  const f=await fixture(t,{kind,size:32,occupied:20});await tick(f,0);await tick(f,1);const final=await tick(f,2);
  assert.equal(final.result.status,'deferred');assert.equal(f.counters.finalPuts,0);assert.equal(f.counters.accepted,0);
  const job=await f.db.prepare("SELECT * FROM background_jobs WHERE kind='mail'").first();assert.equal(job.state,'pending');assert.equal((await openJobValue(f.env,job.checkpoint)).finalAttemptId,undefined);assert.equal(await f.db.prepare('SELECT 1 FROM mail_claims WHERE dedupe_key=?').bind(job.dedupe_key).first(),null);
  t.diagnostic(JSON.stringify({kind,quotaDeferredSql:final.sql}));
});

for(const kind of ['public','private'])test(kind+' full scheduler recovers a lost final receipt by probing without another final upload',async t=>{
  const f=await fixture(t,{kind,size:32,loseFinal:true});await tick(f,0);await tick(f,1);const lost=await tick(f,2);assert.equal(lost.result.status,'probe_required');
  const recovered=await tick(f,7);assert.equal(recovered.result.status,'sent');assert.equal(f.counters.finalPuts,1);assert.equal(f.counters.probes,1);assert.equal(f.counters.starts,1);
  const job=await f.db.prepare("SELECT * FROM background_jobs WHERE kind='mail'").first();assert.equal(job.state,'completed');assert.equal((await f.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(job.dedupe_key).first()).status,'sent');
  t.diagnostic(JSON.stringify({kind,lostFinalSql:lost.sql,probeReceiptSql:recovered.sql}));
});
