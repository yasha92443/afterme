// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/database.js';
import { testFontAssets } from './helpers/pdf-fonts.js';
import { Repository } from '../src/repository.js';
import { buildStoredPayload } from '../src/content.js';
import { defaultRules } from '../src/settings.js';
import { cachedPrivatePdf } from '../src/pdf-cache.js';
import { deliverReleasedItems, runScheduledCheck, sendTransitionEmails } from '../src/worker.js';
import { GmailMailProvider, sendGuardedMail } from '../src/mail.js';
import { createInvocationBudget } from '../src/invocation-budget.js';

const anchor='2030-01-01T00:00:00.000Z',now='2030-01-10T00:00:00.000Z';
async function fixture(t,{through=22,contacts=3}={}) {
  const db=database({through});t.after(()=>db.close());const repo=new Repository(db);
  const env={DB:db,PDF_FONTS:testFontAssets,CONTENT_ENCRYPTION_KEY:'synthetic-content',MAIL_PROVIDER:'dry-run',BASE_URL:'https://test.invalid',INBOUND_PROVIDER:'web',MAIL_INBOUND_ENABLED:'false',CONTACT_NOTIFICATIONS_ENABLED:'false'};
  await repo.setupOwner({displayName:'Fixture',email:'owner@example.invalid',now:anchor});
  for(let id=1;id<=contacts;id++)await repo.createContact({name:'C'+id,email:`c${id}@example.invalid`,role:'friend',priority:id,tokenHash:'initial'+id});
  await repo.createRecipient({name:'Reader',email:'reader@example.invalid',now:anchor});
  const rules=defaultRules(Array.from({length:contacts},(_,i)=>i+1));rules.private.quorum=1;rules.private.grace_hours=0;rules.public.enabled=false;
  const settings=await repo.getSettings(env);await repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules,now:anchor});await repo.checkin(anchor);
  const sent=[],provider={name:'capture',async send(message){sent.push(message);return {status:'sent'};}};
  async function item(text='Synthetic private body',payload=null) {payload ||= await buildStoredPayload({body:{plaintext:text},env});return repo.createEncryptedItem({kind:'letter',title:'Fixture',recipientId:1,encryptedPayload:payload,payloadSize:payload.length,vaultToken:crypto.randomUUID(),vaultTokenHash:crypto.randomUUID(),updatedAt:anchor});}
  async function qualify(at=now,{release=true}={}){const o=await repo.getOwner();await repo.updateOwnerState('VERIFY',at,o.confirmation_round);await repo.rotateContactToken({id:1,tokenHash:'current'+o.confirmation_round});assert.equal(await repo.createConfirmation({contactId:1,status:'confirmed_death',round:o.confirmation_round,now:at}),true);if(release)await repo.advanceChannel(o.confirmation_round,'private',at);return repo.getOwner();}
  const deliver=async(at=now)=>deliverReleasedItems(repo,env,new URL(env.BASE_URL),at,await repo.getOwner(),provider);
  return {db,repo,env,sent,provider,item,qualify,deliver,rules};
}

test('fifty manual letters cannot starve a later automatic delivery',async t=>{
  const f=await fixture(t);for(let i=0;i<50;i++)await f.item('',JSON.stringify({v:2,mode:'passphrase',payload:'opaque'}));const id=await f.item();await f.qualify();
  const results=await f.deliver();assert.equal(results.find(r=>r.item_id===id)?.status,'sent');assert.equal(f.sent.length,1);
});
test('failed originals back off while later healthy letters continue fairly',async t=>{
  const f=await fixture(t),bad=await buildStoredPayload({body:{plaintext:'Bad key fixture'},env:{CONTENT_ENCRYPTION_KEY:'different-key'}});
  for(let i=0;i<12;i++)await f.item('',bad);const id=await f.item();await f.qualify();for(let i=0;i<4;i++)await f.deliver();
  assert.equal(f.sent.length,1);assert.ok((await f.repo.getEncryptedItemForAdmin(id)).released_at);assert.equal((await f.db.prepare('SELECT next_attempt_at FROM private_delivery_state WHERE item_id=1').first()).next_attempt_at,'2030-01-10T00:05:00.000Z');
});
test('edited content after a retracted release is sent once; style or unchanged saves do not resend',async t=>{
  const f=await fixture(t),id=await f.item();await f.qualify();await f.deliver();assert.equal(f.sent.length,1);
  await f.repo.checkin('2030-01-14T00:00:00.000Z');const payload=await buildStoredPayload({body:{plaintext:'Changed actual letter'},env:f.env});
  assert.equal(await f.repo.updateEncryptedItem({id,recipientId:1,encryptedPayload:payload,payloadSize:payload.length,updatedAt:'2030-01-14T00:00:00.000Z',expectedRevision:0}),true);
  await f.qualify('2030-01-24T00:00:00.000Z');await f.deliver('2030-01-24T00:00:00.000Z');assert.equal(f.sent.length,2);await f.deliver('2030-01-24T00:01:00.000Z');assert.equal(f.sent.length,2);
  await f.repo.checkin('2030-01-25T00:00:00.000Z');await f.repo.updateEncryptedItem({id,recipientId:1,encryptedPayload:payload,payloadSize:payload.length,updatedAt:'2030-01-25T00:00:00.000Z',expectedRevision:1,deliveryChanged:false});
  await f.qualify('2030-02-04T00:00:00.000Z');await f.deliver('2030-02-04T00:00:00.000Z');assert.equal(f.sent.length,2);
});
test('legacy private receipts migrate conservatively including uncertain claims',async t=>{
  const f=await fixture(t,{through:19}),id=await f.item(),key=`private_letter_release:${id}:reader@example.invalid`;
  await f.repo.claimMail(key,now,20);await f.repo.finishMailClaim(key,'uncertain','Synthetic timeout');f.db.applyMigration('0020_reliability_audit.sql');
  const item=await f.repo.getEncryptedItemForAdmin(id),migrated=await f.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(f.repo.getMailDeliveryKey(item)).first();assert.equal(migrated.status,'uncertain');
});
test('migration never labels changed legacy content as already delivered',async t=>{
  const f=await fixture(t,{through:19}),unchanged=await f.item(),changed=await f.item();
  for(const id of [unchanged,changed]){const key=`private_letter_release:${id}:reader@example.invalid`;await f.repo.claimMail(key,now,20);await f.repo.finishMailClaim(key,'sent');}
  await f.db.prepare('UPDATE encrypted_items SET updated_at=? WHERE id=?').bind('2030-01-11T00:00:00.000Z',changed).run();f.db.applyMigration('0020_reliability_audit.sql');
  const same=await f.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(f.repo.getMailDeliveryKey(await f.repo.getEncryptedItemForAdmin(unchanged))).first();const newer=await f.db.prepare('SELECT status,last_error FROM mail_claims WHERE dedupe_key=?').bind(f.repo.getMailDeliveryKey(await f.repo.getEncryptedItemForAdmin(changed))).first();assert.equal(same.status,'sent');assert.equal(newer.status,'uncertain');assert.equal(newer.last_error,'legacy-content-unverified');
});

test('explicit retry of an uncertain migrated receipt overrides the older sent alias',async t=>{
  const f=await fixture(t,{through:19}),id=await f.item(),legacy=`private_letter_release:${id}:reader@example.invalid`;
  await f.repo.claimMail(legacy,now,20);await f.repo.finishMailClaim(legacy,'sent');
  const payload=await buildStoredPayload({body:{plaintext:'Actual edited content after the legacy send'},env:f.env});
  await f.db.prepare('UPDATE encrypted_items SET encrypted_payload=?,updated_at=? WHERE id=?').bind(payload,'2030-01-11T00:00:00.000Z',id).run();
  for(const migration of ['0020_reliability_audit.sql','0021_draft_versions.sql','0022_pdf_artifacts.sql'])f.db.applyMigration(migration);
  const item=await f.repo.getEncryptedItemForAdmin(id),key=f.repo.getMailDeliveryKey(item),at='2030-01-20T00:00:00.000Z';
  assert.equal(item.delivery_version,0);assert.equal((await f.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(key).first()).status,'uncertain');
  await f.qualify(at);await f.deliver(at);assert.equal(f.sent.length,0);
  // This is the canonical claim update made by /api/mail/reconcile retry.
  await f.repo.finishMailClaim(key,'failed');
  assert.deepEqual((await f.repo.listReleasedPrivateItemsForDelivery({pending:true,now:at})).results.map(row=>row.id),[id]);
  await f.deliver(at);await f.deliver(at);assert.equal(f.sent.length,1);
  assert.equal((await f.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(legacy).first()).status,'sent');
  assert.equal((await f.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(key).first()).status,'sent');
});

for(const audience of ['contact','recipient'])test(`public ${audience} migration requires proof of successful delivery to the current address`,async t=>{
  const cases=[
    {status:'sent',log:'sent',expected:'sent'},
    {status:'dry_run',log:'dry_run',expected:'dry_run'},
    {status:'sent',log:'sent',oldAddress:true,expected:'uncertain'},
    {status:'sent',expected:'uncertain'},
    {status:'failed',log:'sent',expected:'failed'},
    {status:'cancelled',expected:'cancelled'},
    {status:'uncertain',log:'sent',expected:'uncertain'},
    {status:'sending',expected:'sending'},
  ];
  const f=await fixture(t,{through:19,contacts:audience==='contact'?cases.length:1});
  if(audience==='recipient')for(let id=2;id<=cases.length;id++)await f.repo.createRecipient({name:'Reader '+id,email:`reader${id}@example.invalid`,now:anchor});
  await f.db.prepare("INSERT INTO public_farewell(id,title,body,status,updated_at) VALUES(1,'Synthetic','','DRAFT',?)").bind(anchor).run();
  const targets=(await f.db.prepare(`SELECT id,email FROM ${audience==='contact'?'contacts':'recipients'} ORDER BY id`).all()).results;
  for(const [index,spec] of cases.entries()){
    const target=targets[index],key=`public_farewell_release:content:${anchor}:${audience}:${target.id}`;
    await f.repo.claimMail(key,now,20);await f.repo.finishMailClaim(key,spec.status,'synthetic-legacy-error');
    if(spec.log)await f.repo.logDelivery({eventType:'public_farewell_release',recipientEmail:spec.oldAddress?'old-address@example.invalid':` ${target.email.toUpperCase()} `,subject:'Synthetic',provider:'dry-run',status:spec.log,dedupeKey:key,now});
  }
  for(const migration of ['0020_reliability_audit.sql','0021_draft_versions.sql','0022_pdf_artifacts.sql'])f.db.applyMigration(migration);
  for(const [index,spec] of cases.entries()){
    const target=targets[index],key=`public_farewell_release:v2:1:${anchor}:${audience}:${target.id}:${target.email.toLowerCase()}`;
    const alias=await f.db.prepare('SELECT status,last_error FROM mail_claims WHERE dedupe_key=?').bind(key).first();
    assert.equal(alias.status,spec.expected,`${audience} case ${index}`);
    assert.equal(alias.last_error,spec.status==='sent'&&spec.expected==='uncertain'?'legacy-recipient-unverified':'synthetic-legacy-error',`${audience} case ${index}`);
  }
});
test('old inbox failures do not poison a new round and current failures require explicit reconciliation',async t=>{
  const f=await fixture(t);await f.repo.claimInboundMessage({gmailMessageId:'old',processedAt:anchor,round:1});await f.repo.finishInboundMessage({gmailMessageId:'old',status:'failed',processedAt:anchor});assert.equal(await f.repo.hasBlockingInbound(2),false);
  await f.repo.claimInboundMessage({gmailMessageId:'current',processedAt:now,round:2});await f.repo.finishInboundMessage({gmailMessageId:'current',status:'failed',processedAt:now});assert.equal(await f.repo.hasBlockingInbound(2),true);
  assert.equal(await f.repo.reconcileInboundMessage({gmailMessageId:'current',resolution:'ignore',note:'',expectedRound:2,now}),false);
  assert.equal(await f.repo.reconcileInboundMessage({gmailMessageId:'current',resolution:'ignore',note:'Checked the original email',expectedRound:1,now}),false);
  assert.equal(await f.repo.reconcileInboundMessage({gmailMessageId:'current',resolution:'ignore',note:'Checked the original email',expectedRound:2,now}),true);assert.equal(await f.repo.hasBlockingInbound(2),false);
  await f.qualify(now,{release:false});for(let i=0;i<4;i++)await runScheduledCheck(f.repo,{...f.env},new Date(now),f.provider);assert.equal((await f.repo.getOwner()).state,'PRIVATE_RELEASE');
});
test('old current-round failed Gmail messages retry by ID outside the inbox search window',async t=>{
  const f=await fixture(t);await f.repo.claimInboundMessage({gmailMessageId:'old-current',processedAt:anchor,round:2});await f.repo.finishInboundMessage({gmailMessageId:'old-current',status:'failed',processedAt:anchor});
  const provider=new GmailMailProvider({GMAIL_CLIENT_ID:'fake',GMAIL_CLIENT_SECRET:'fake',GMAIL_REFRESH_TOKEN:'fake',FROM_EMAIL:'afterme.fixture@gmail.com'});provider.getAccessToken=async()=>({ok:true,accessToken:'fake'});
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);const urls=[];globalThis.fetch=async value=>{urls.push(String(value));return Response.json({id:'old-current',payload:{headers:[]}});};
  const result=await provider.listInboundMessages({repo:f.repo,maxResults:5});assert.deepEqual(result.map(m=>m.id),['old-current']);assert.equal(result.backlog,true);assert.ok(urls[0].includes('/messages/old-current?'));
});
test('READY rounds retry unsent verification notices and corrected addresses receive a new token',async t=>{
  const f=await fixture(t);f.env.CONTACT_NOTIFICATIONS_ENABLED='true';f.env.MAX_DAILY_EMAILS='1';let settings=await f.repo.getSettings(f.env);const rules=structuredClone(f.rules);rules.private.grace_hours=72;rules.public.enabled=true;rules.public.quorum=3;
  await f.repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,daily_email_limit:1},rules,now:anchor});await f.repo.checkin(anchor);await f.qualify(now,{release:false});const owner=await f.repo.getOwner();await sendTransitionEmails({repo:f.repo,env:f.env,owner,toState:'VERIFY',now,provider:f.provider});await f.repo.advanceChannel(owner.confirmation_round,'private',now);assert.equal((await f.repo.getOwner()).state,'READY_TO_RELEASE');
  for(let i=0;i<3;i++)await runScheduledCheck(f.repo,{...f.env},new Date('2030-01-11T00:00:00.000Z'),f.provider);assert.ok(f.sent.some(m=>m.to==='c2@example.invalid'));
  await f.repo.updateContact({id:1,name:'C1',email:'corrected@example.invalid',role:'friend',priority:1,active:true});await sendTransitionEmails({repo:f.repo,env:f.env,owner:await f.repo.getOwner(),toState:'VERIFY',now:'2030-01-12T00:00:00.000Z',provider:f.provider});assert.ok(f.sent.some(m=>m.to==='corrected@example.invalid'));assert.equal((await f.repo.getContact(1)).verification_round,owner.confirmation_round);
});
test('one PDF failure does not stop a later healthy cached letter',async t=>{
  const f=await fixture(t);for(let i=0;i<3;i++)await f.item();await f.qualify();for(const id of [1,3])await cachedPrivatePdf(f.repo,f.env,await f.repo.getEncryptedItemForAdmin(id),await f.repo.getOwner());delete f.env.PDF_FONTS;
  const results=await f.deliver();assert.equal(results.find(r=>r.item_id===2)?.reason,'pdf-generation-failed');assert.equal(f.sent.length,2);assert.ok(f.sent.every(m=>new TextDecoder().decode(m.attachments[0].data.subarray(0,5))==='%PDF-'));
});
test('invalid PDF derivative is regenerated instead of sending an empty attachment',async t=>{
  const f=await fixture(t),id=await f.item();await f.qualify();await cachedPrivatePdf(f.repo,f.env,await f.repo.getEncryptedItemForAdmin(id),await f.repo.getOwner());await f.db.prepare("UPDATE encrypted_items SET pdf_payload='truncated' WHERE id=?").bind(id).run();await f.deliver();assert.equal(f.sent.length,1);assert.ok(f.sent[0].attachments[0].data.length>100);
});
test('budget deferral occurs before a claim or dispatch and genuine uncertainty remains blocked',async t=>{
  const f=await fixture(t);const args={repo:f.repo,provider:f.provider,env:{...f.env,INVOCATION_BUDGET:createInvocationBudget({d1:14,external:0})},eventType:'test',to:'r@example.invalid',subject:'Fixture',text:'Fixture',dedupeKey:'budget-never-dispatched',now};
  assert.equal((await sendGuardedMail(args)).reason,'invocation-budget');assert.equal(await f.db.prepare('SELECT 1 FROM mail_claims WHERE dedupe_key=?').bind(args.dedupeKey).first(),null);assert.equal(f.sent.length,0);
  const uncertain={...args,env:f.env,dedupeKey:'actually-uncertain',provider:{name:'capture',async send(){throw new DOMException('Synthetic timeout','TimeoutError');}}};assert.equal((await sendGuardedMail(uncertain)).status,'uncertain');assert.equal((await sendGuardedMail(uncertain)).status,'skipped');
});
test('monthly outbound self-check gets quota before a long release queue',async t=>{
  const f=await fixture(t),settings=await f.repo.getSettings(f.env);
  await f.repo.saveSettings({revision:settings.revision,preferences:{...settings.preferences,selfcheck:true},rules:settings.active,now:anchor});await f.repo.checkin(anchor);
  for(let i=0;i<21;i++){const id=await f.item();await cachedPrivatePdf(f.repo,f.env,await f.repo.getEncryptedItemForAdmin(id),await f.repo.getOwner());}await f.qualify();
  await runScheduledCheck(f.repo,{...f.env},new Date(now),f.provider);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM delivery_log WHERE event_type='mail_healthcheck' AND status='sent'").first()).count,1);assert.equal(f.sent[0].to,'owner@example.invalid');
});
test('browser PDF preparation stays pending and is visible as a delivery health problem',async t=>{
  const f=await fixture(t);f.env.PDF_GENERATION_MODE='browser';await f.item();await f.qualify();await f.deliver();assert.equal(f.sent.length,0);
  const state=await f.db.prepare('SELECT status,reason,next_attempt_at FROM private_delivery_state WHERE item_id=1').first();assert.equal(state.status,'pending');assert.equal(state.reason,'pdf-not-ready');assert.equal(state.next_attempt_at,null);assert.equal((await f.repo.getOperationalHealth()).privateDeliveryProblemCount,1);
});
