// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/database.js';
import { Repository } from '../src/repository.js';
import { createInvocationBudget,wrapBudgetDatabase,budgetFetch,isInvocationBudgetError,bytesToBase64,base64ToBytes } from '../src/invocation-budget.js';
import { defaultRules } from '../src/settings.js';
import { buildStoredPayload } from '../src/content.js';
import { cachedPrivatePdf } from '../src/pdf-cache.js';
import { testFontAssets } from './helpers/pdf-fonts.js';
import { runScheduledCheck } from '../src/worker.js';
import { sendSecurityAlerts } from '../src/security-alerts.js';

test('batch statements consume the conservative SQL limit before dispatch',async t=>{
  const db=database();t.after(()=>db.close());const budget=createInvocationBudget({d1:2,statements:2}),wrapped=wrapBudgetDatabase(db,budget);
  await wrapped.batch([wrapped.prepare('SELECT 1'),wrapped.prepare('SELECT 2')]);assert.equal(budget.usedD1,1);assert.equal(budget.usedStatements,2);
  await assert.rejects(wrapped.prepare('SELECT 3').first(),isInvocationBudgetError);assert.equal(budget.usedStatements,2);
  const fresh=createInvocationBudget();await wrapBudgetDatabase(wrapped,fresh).prepare('SELECT 4').first();assert.equal(fresh.usedD1,1);assert.equal(budget.usedD1,1);
});
test('external exhaustion is identified as unattempted and native codecs preserve bytes',async t=>{
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;globalThis.fetch=async()=>{calls++;return new Response('ok');};
  const env={INVOCATION_BUDGET:createInvocationBudget({external:1})};await budgetFetch(env,'https://example.invalid');await assert.rejects(budgetFetch(env,'https://example.invalid'),isInvocationBudgetError);assert.equal(calls,1);
  const bytes=Uint8Array.from({length:100000},(_,i)=>i%256);assert.deepEqual(base64ToBytes(bytesToBase64(bytes)),bytes);
});
test('forty inbox messages and twenty due letters resume within free limits without false uncertainty',async t=>{
  const db=database();t.after(()=>db.close());const repo=new Repository(db),anchor='2030-01-01T00:00:00.000Z',now='2030-01-10T00:00:00.000Z';
  const env={DB:db,PDF_FONTS:testFontAssets,CONTENT_ENCRYPTION_KEY:'budget-fixture',MAIL_PROVIDER:'gmail',BASE_URL:'https://test.invalid',FROM_EMAIL:'afterme.fixture@gmail.com',INBOUND_PROVIDER:'gmail',MAIL_INBOUND_ENABLED:'true',MAIL_HEALTHCHECK_ENABLED:'false',CONTACT_NOTIFICATIONS_ENABLED:'false',GMAIL_CLIENT_ID:'fake',GMAIL_CLIENT_SECRET:'fake',GMAIL_REFRESH_TOKEN:'fake'};
  await repo.setupOwner({displayName:'Fixture',email:'owner@example.invalid',now:anchor});await repo.createContact({name:'C',email:'c@example.invalid',role:'friend',priority:1,tokenHash:'initial'});await repo.createRecipient({name:'R',email:'r@example.invalid',now:anchor});const settings=await repo.getSettings(env),rules=defaultRules([1]);rules.private.quorum=1;rules.private.grace_hours=0;rules.public.enabled=false;await repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules,now:anchor});await repo.checkin(anchor);
  const payload=await buildStoredPayload({body:{plaintext:'Synthetic budget fixture'},env});for(let id=1;id<=20;id++){await repo.createEncryptedItem({kind:'letter',title:'Fixture',recipientId:1,encryptedPayload:payload,payloadSize:payload.length,vaultToken:'t'+id,vaultTokenHash:'h'+id,updatedAt:anchor});await cachedPrivatePdf(repo,env,await repo.getEncryptedItemForAdmin(id),await repo.getOwner());}
  const round=(await repo.getOwner()).confirmation_round;await repo.updateOwnerState('VERIFY',now,round);await repo.rotateContactToken({id:1,tokenHash:'current'});await repo.createConfirmation({contactId:1,status:'confirmed_death',round,now});
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let invocationFetches=0,accepted=0;
  globalThis.fetch=async input=>{invocationFetches++;assert.ok(invocationFetches<=45,'external budget must defer before dispatch');const url=String(input);if(url.includes('oauth2'))return Response.json({access_token:'fake',expires_in:3600});if(url.includes('/messages?'))return Response.json({messages:Array.from({length:40},(_,i)=>({id:'noise'+i}))});if(url.includes('/messages/noise'))return Response.json({id:url.match(/messages\/(noise\d+)/)[1],threadId:'noise',internalDate:String(Date.parse(now)),payload:{headers:[{name:'From',value:'noise@example.invalid'},{name:'Subject',value:'Ordinary inbox message'}]}});if(url.includes('/messages/send')){accepted++;return Response.json({id:'sent'+accepted,threadId:'sent-thread'});}throw Error('Unexpected mock URL');};
  for(let tick=0;tick<40&&accepted<20;tick++){invocationFetches=0;const budget=createInvocationBudget();await runScheduledCheck(repo,{...env,INVOCATION_BUDGET:budget},new Date(Date.parse(now)+tick*300000));assert.ok(budget.usedD1<=48);assert.ok(budget.usedStatements<=48);assert.ok(budget.usedExternal<=45);}
  assert.equal(accepted,20);assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM mail_claims WHERE status IN ('uncertain','sending')").first()).count,0);assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM inbound_mail_log WHERE status='ignored'").first()).count,40);
});
test('security alerts use the cheap snapshot and progress with twenty SQL statements of headroom',async t=>{
  const db=database();t.after(()=>db.close());const raw=new Repository(db),now='2030-01-10T00:00:00.000Z';await raw.setupOwner({displayName:'Fixture',email:'owner@example.invalid',now});await raw.getSettings({});
  await raw.setCursor('public-health',JSON.stringify({checks:{deliveries_healthy:true,gmail_inbound_healthy:true,inbound_processing_healthy:true}}));await db.prepare("INSERT INTO security_events(hour,kind,count) VALUES(?,'service_failure',1),(?,'rate_limit',5)").bind(now.slice(0,13),now.slice(0,13)).run();
  let sends=0;const provider={name:'capture',async send(){sends++;return {status:'sent'};}};
  for(let tick=0;tick<3;tick++){const budget=createInvocationBudget({d1:20}),repo=new Repository(wrapBudgetDatabase(db,budget));await sendSecurityAlerts(repo,{INVOCATION_BUDGET:budget},now,provider);assert.ok(budget.usedStatements<=20);}
  assert.equal(sends,2);assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM mail_claims WHERE dedupe_key LIKE 'security-alert:%' AND status='sent'").first()).count,2);
});
