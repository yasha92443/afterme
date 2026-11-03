// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {defaultRules} from '../src/settings.js';
import {buildStoredPayload} from '../src/content.js';
import {beginArtifact,uploadArtifactChunk,completeArtifact,pdfDigest} from '../src/pdf-artifacts.js';
import {bytesToBase64,createInvocationBudget,wrapBudgetDatabase} from '../src/invocation-budget.js';
import {runScheduledCheck,deliverReleasedItems,deliverPublicFarewell,sendTransitionEmails} from '../src/worker.js';

const anchor='2030-01-01T00:00:00.000Z',now='2030-01-10T00:00:00.000Z';
async function fixture(t,{released=false,publicEnabled=true}={}){
  const db=database();t.after(()=>db.close());const repo=new Repository(db);
  const env={DB:db,CONTENT_ENCRYPTION_KEY:'cron-cpu-synthetic',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',PDF_GENERATION_MODE:'browser',MAIL_HEALTHCHECK_ENABLED:'false',CONTACT_NOTIFICATIONS_ENABLED:'false'};
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now:anchor});
  await repo.createContact({name:'Synthetic contact',email:'contact@example.invalid',role:'friend',priority:1,tokenHash:'synthetic'});
  await repo.createRecipient({name:'Synthetic reader',email:'reader@example.invalid',now:anchor});
  const settings=await repo.getSettings(env),rules=defaultRules([1]);rules.private.quorum=1;rules.private.grace_hours=0;rules.public.quorum=1;rules.public.enabled=publicEnabled;rules.public.audience.push('recipient:1');
  await repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,selfcheck:false},rules,now:anchor});await repo.checkin(anchor);
  await repo.upsertPublicFarewell({title:'Synthetic public document',body:'',status:'DRAFT',now:anchor});
  if(released){
    await db.prepare("UPDATE owner SET state='PUBLIC_RELEASE' WHERE id=1").run();
    const owner=await repo.getOwner();await repo.rotateContactToken({id:1,tokenHash:'current'});assert.equal(await repo.createConfirmation({contactId:1,status:'confirmed_death',round:owner.confirmation_round,now}),true);
    await db.prepare('UPDATE release_progress SET ready_at=?,released_at=?').bind(anchor,anchor).run();
    await db.prepare("UPDATE public_farewell SET status='PUBLIC_RELEASE',auto_released_at=?").bind(anchor).run();
    const {formal_revision}=await repo.farewell.getVersions();
    for(const [audience,email] of [['contact:1','contact@example.invalid'],['recipient:1','reader@example.invalid']]){
      await db.prepare("INSERT INTO mail_claims(dedupe_key,status,claimed_at) VALUES(?,'dry_run',?)").bind(`public_farewell_release:v2:${formal_revision}:${anchor}:${audience}:${email}`,anchor).run();
    }
  }
  const sent=[],provider={name:'capture',async send(message){sent.push(message);return {status:'sent'};}};
  return {db,repo,env,sent,provider};
}
function countMethods(repo,names){
  const calls={};for(const name of names){const original=repo[name].bind(repo);repo[name]=async(...args)=>{calls[name]=(calls[name]||0)+1;return original(...args);};}return calls;
}
async function preparedLetter(f){
  const encryptedPayload=await buildStoredPayload({body:{plaintext:'Synthetic private source'},env:f.env});
  const id=await f.repo.createEncryptedItem({kind:'letter',title:'Synthetic letter',recipientId:1,encryptedPayload,payloadSize:encryptedPayload.length,vaultToken:'synthetic-token',vaultTokenHash:'synthetic-hash',updatedAt:anchor});
  const bytes=new TextEncoder().encode('%PDF-1.4\n% Synthetic query fixture\n%%EOF\n');
  const artifact=await beginArtifact(f.repo,f.env,{kind:'private',id});
  await uploadArtifactChunk(f.repo,f.env,artifact.id,0,bytesToBase64(bytes));
  await completeArtifact(f.repo,f.env,artifact.id,{total_bytes:bytes.length,chunk_count:1,sha256:await pdfDigest(bytes)});
  return {id,bytes,encryptedPayload};
}

test('normal idle Cron avoids pause writes and redundant progress snapshots',async t=>{
  const {repo,env,provider}=await fixture(t),calls=countMethods(repo,['getOwner','getProgress','resumeExpiredPause','listMailTemplates']);
  const budget=createInvocationBudget();const result=await runScheduledCheck(repo,{...env,INVOCATION_BUDGET:budget},new Date('2030-01-01T01:00:00.000Z'),provider);
  assert.equal(result.to,'NORMAL');assert.equal(calls.resumeExpiredPause||0,0);assert.equal(calls.getOwner,2);assert.equal(calls.getProgress||0,0);assert.equal(calls.listMailTemplates||0,0);
  assert.ok(budget.usedD1<=8,`idle D1 calls: ${budget.usedD1}`);assert.ok(budget.usedStatements<=9,`idle SQL statements: ${budget.usedStatements}`);
  t.diagnostic(`idle: ${budget.usedD1} D1 round trips / ${budget.usedStatements} SQL statements`);
});

test('completed Cron does not load templates or PDF bytes and stays within its query budget',async t=>{
  const {db,repo,env,provider,sent}=await fixture(t,{released:true}),calls=countMethods(repo,['getOwner','getProgress','resumeExpiredPause','listMailTemplates']);
  const original=db.prepare.bind(db);db.prepare=sql=>{assert.doesNotMatch(sql,/SELECT \* FROM pdf_artifact/,'completed deliveries must not read the PDF');return original(sql);};
  const budget=createInvocationBudget();const result=await runScheduledCheck(repo,{...env,INVOCATION_BUDGET:budget},new Date(now),provider);
  assert.equal(result.to,'PUBLIC_RELEASE');assert.equal(calls.getOwner,2);assert.equal(calls.getProgress,2);assert.equal(calls.listMailTemplates||0,0);assert.equal(sent.length,0);
  assert.ok(budget.usedD1<=14,`completed D1 calls: ${budget.usedD1}`);assert.ok(budget.usedStatements<=17,`completed SQL statements: ${budget.usedStatements}`);
  t.diagnostic(`completed: ${budget.usedD1} D1 round trips / ${budget.usedStatements} SQL statements`);
});

test('only expired automatic pauses resume; a concurrent check-in keeps the new round',async t=>{
  for(const [mode,until,expected,checkin] of [['manual',anchor,0,false],['automatic','2030-01-11T00:00:00.000Z',0,false],['automatic','2030-01-09T12:00:00.000Z',1,false],['automatic',anchor,1,true]]){
    const {repo,env,provider,sent}=await fixture(t);await repo.pause({mode,until,now:anchor});const before=await repo.getOwner();
    const calls=countMethods(repo,['resumeExpiredPause']);
    if(checkin){const original=repo.resumeExpiredPause.bind(repo);repo.resumeExpiredPause=async value=>{await repo.checkin(now);return original(value);};}
    const result=await runScheduledCheck(repo,env,new Date(now),provider),owner=await repo.getOwner();
    assert.equal(calls.resumeExpiredPause||0,expected);assert.equal(sent.length,0);
    if(expected){assert.equal(owner.confirmation_round,before.confirmation_round+(checkin?1:0));assert.equal(owner.timer_anchor_at,checkin?now:until);assert.equal(owner.pause_mode,null);assert.equal(owner.last_checkin_at,checkin?now:before.last_checkin_at);assert.equal(owner.state,'NORMAL');assert.equal(result.to,'NORMAL');}
    else assert.equal(owner.pause_mode,mode);
  }
});

test('advancing a channel refreshes state after a concurrent check-in',async t=>{
  const {repo,env,provider,sent}=await fixture(t,{publicEnabled:false}),owner=await repo.getOwner();
  await repo.updateOwnerState('VERIFY',now,owner.confirmation_round);await repo.rotateContactToken({id:1,tokenHash:'current'});
  await repo.createConfirmation({contactId:1,status:'confirmed_death',round:owner.confirmation_round,now});
  const original=repo.advanceChannel.bind(repo);let advanced=false;repo.advanceChannel=async(...args)=>{const result=await original(...args);if(!advanced){advanced=true;await repo.checkin(now);}return result;};
  const result=await runScheduledCheck(repo,env,new Date(now),provider);
  assert.equal(advanced,true);assert.equal(result.to,'NORMAL');assert.equal(sent.length,0);assert.equal((await repo.getOwner()).confirmation_round,owner.confirmation_round+1);
});

test('reusing an unchanged release snapshot retains the send-time round guard',async t=>{
  const f=await fixture(t,{released:true,publicEnabled:false});await preparedLetter(f);
  await f.db.prepare('UPDATE encrypted_items SET released_at=?').bind(anchor).run();
  const original=f.repo.listReleasedPrivateItemsForDelivery.bind(f.repo);let cancelled=false;
  f.repo.listReleasedPrivateItemsForDelivery=async(...args)=>{const rows=await original(...args);if(!cancelled){cancelled=true;await f.repo.checkin(now);}return rows;};
  await runScheduledCheck(f.repo,f.env,new Date(now),f.provider);
  assert.equal(cancelled,true);assert.equal(f.sent.length,0);assert.equal((await f.repo.getOwner()).state,'NORMAL');
});

test('disabled or empty notification queues and empty private queues do not read templates',async()=>{
  const forbidden=()=>{throw Error('Unexpected template or settings query');};
  await sendTransitionEmails({repo:{getRoundRules:forbidden,getSettings:forbidden,listMailTemplates:forbidden},env:{CONTACT_NOTIFICATIONS_ENABLED:'false'},owner:{},toState:'VERIFY',now});
  await sendTransitionEmails({repo:{listPendingTransitionContacts:async()=>({results:[]}),listMailTemplates:forbidden},env:{},owner:{},toState:'ALERT',now});
  assert.deepEqual(await deliverReleasedItems({listReleasedPrivateItemsForDelivery:async()=>({results:[]}),listMailTemplates:forbidden},{},new URL('https://example.invalid'),now,{}),[]);
});

test('browser-prepared private delivery reads the encrypted PDF without decrypting the original text',async t=>{
  const f=await fixture(t,{released:true,publicEnabled:false}),{bytes,encryptedPayload}=await preparedLetter(f);
  await f.db.prepare('UPDATE encrypted_items SET released_at=?').bind(anchor).run();
  const originalCipher=Buffer.from(JSON.parse(encryptedPayload).ciphertext,'base64');
  const decrypt=crypto.subtle.decrypt;let originalDecrypts=0;
  crypto.subtle.decrypt=function(algorithm,key,data){if(Buffer.from(data).equals(originalCipher)){originalDecrypts++;throw Error('Original plaintext should not be loaded for a prepared PDF');}return decrypt.call(this,algorithm,key,data);};
  t.after(()=>{crypto.subtle.decrypt=decrypt;});
  await deliverReleasedItems(f.repo,f.env,new URL('https://example.invalid'),now,await f.repo.getOwner(),f.provider);
  assert.equal(originalDecrypts,0);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].attachments[0].data,bytes);
});

test('public delivery snapshot preserves metadata and its version-specific cursor in one round trip',async t=>{
  const {repo}=await fixture(t,{released:true}),owner=await repo.getOwner(),document=await repo.getPublicFarewell(),versions=await repo.farewell.getVersions();
  const contacts=(await repo.listActiveContacts()).results,recipients=(await repo.listActiveRecipients()).results;
  const key=`public-delivery:${owner.confirmation_round}:${versions.formal_revision}:${document.updated_at}`;
  await repo.setCursor(key,'contact:1');await repo.setCursor(`public-delivery:${owner.confirmation_round+1}:${versions.formal_revision}:${document.updated_at}`,'recipient:1');
  const budget=createInvocationBudget();repo.db=wrapBudgetDatabase(repo.db,budget);
  const snapshot=await repo.getPublicDeliverySnapshot(owner.confirmation_round);
  assert.deepEqual(snapshot,{contacts,recipients,document:{...document},formalRevision:versions.formal_revision,cursorKey:key,cursor:'contact:1'});
  assert.equal(budget.usedD1,1);assert.equal(budget.usedStatements,3);
  const next=await repo.getPublicDeliverySnapshot(owner.confirmation_round+1);assert.equal(next.cursor,'recipient:1');
  await repo.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1 WHERE id=1').run();
  const changed=await repo.getPublicDeliverySnapshot(owner.confirmation_round);assert.equal(changed.formalRevision,versions.formal_revision+1);assert.equal(changed.cursor,'');assert.notEqual(changed.cursorKey,key);
});

test('public snapshot and compatibility path select the same audience and rotate pending work beyond five',async t=>{
  const {repo,env,provider,sent}=await fixture(t,{released:true}),owner=await repo.getOwner();
  for(let id=2;id<=8;id++)await repo.createContact({name:'Synthetic '+id,email:`c${id}@example.invalid`,role:'friend',priority:id,tokenHash:'synthetic'+id});
  await repo.db.prepare('UPDATE contacts SET active=0 WHERE id=7').run();
  const rules=await repo.getRoundRules(owner);rules.public.audience=[...Array.from({length:7},(_,i)=>'contact:'+(i+1)),'recipient:1'];
  await repo.db.prepare('UPDATE round_rules SET rules_json=? WHERE round=?').bind(JSON.stringify(rules),owner.confirmation_round).run();await repo.db.prepare('DELETE FROM mail_claims').run();
  const snapshot=await repo.getPublicDeliverySnapshot(owner.confirmation_round);await repo.setCursor(snapshot.cursorKey,'contact:2');
  const batched=await deliverPublicFarewell(repo,env,now,owner,provider);assert.deepEqual(batched.map(row=>row.contact_id),[3,4,5,6,1]);assert.ok(batched.every(row=>row.reason==='pdf-not-ready'));assert.equal(await repo.getCursor(snapshot.cursorKey),'recipient:1');
  const readSnapshot=repo.getPublicDeliverySnapshot.bind(repo);repo.getPublicDeliverySnapshot=undefined;await repo.setCursor(snapshot.cursorKey,'contact:2');
  const compatibility=await deliverPublicFarewell(repo,env,now,owner,provider);assert.deepEqual(compatibility,batched);assert.equal(await repo.getCursor(snapshot.cursorKey),'recipient:1');
  repo.getPublicDeliverySnapshot=readSnapshot;
  const following=await deliverPublicFarewell(repo,env,now,owner,provider);assert.deepEqual(following.map(row=>row.contact_id),[1,2,3,4,5]);assert.equal(sent.length,0);
});

test('public snapshot still checks round, formal revision and document timestamp immediately before sending',async t=>{
  for(const change of ['round','formal','document']){
    const f=await fixture(t,{released:true}),owner=await f.repo.getOwner();await f.db.prepare('DELETE FROM mail_claims').run();
    const bytes=new TextEncoder().encode('%PDF-1.4\n% Synthetic public fixture\n%%EOF\n'),artifact=await beginArtifact(f.repo,f.env,{kind:'public',locale:'zh'});
    await uploadArtifactChunk(f.repo,f.env,artifact.id,0,bytesToBase64(bytes));await completeArtifact(f.repo,f.env,artifact.id,{total_bytes:bytes.length,chunk_count:1,sha256:await pdfDigest(bytes)});
    const canSend=f.repo.publicDeliveryAllowed.bind(f.repo);let guards=0;
    f.repo.publicDeliveryAllowed=async(...args)=>{if(guards++===0){
      if(change==='round')await f.repo.checkin(now);
      else if(change==='formal')await f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1 WHERE id=1').run();
      else await f.repo.upsertPublicFarewellTitle({title:'Concurrent title',now});
    }return canSend(...args);};
    await deliverPublicFarewell(f.repo,f.env,now,owner,f.provider);assert.ok(guards>0,change+' guard was not called');assert.equal(f.sent.length,0,change+' changed after the delivery snapshot');
  }
});
