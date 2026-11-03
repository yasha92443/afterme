// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {ensurePeopleLinks} from '../src/people.js';
import {buildStoredPayload,openStoredPayload} from '../src/content.js';
import worker,{sendTransitionEmails,deliverPublicFarewell} from '../src/worker.js';

const now='2026-10-21T00:00:00.000Z',allow={async limit(){return {success:true};}};
async function fixture(t,{through=23}={}){
  const db=database({through});t.after(()=>db.close());const repo=new Repository(db),env={DB:db,ADMIN_TOKEN:'people-fixture',CONTENT_ENCRYPTION_KEY:'people-content',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',PDF_GENERATION_MODE:'browser',MAX_DAILY_EMAILS:'100',LOGIN_LIMITER:allow,API_LIMITER:allow,VERIFY_LIMITER:allow,EXPENSIVE_LIMITER:allow,READ_LIMITER:allow};
  await repo.setupOwner({displayName:'Owner',email:'owner@example.invalid',now});await repo.getSettings(env);return {db,repo,env};
}
async function legacy(t,{freeze=true}={}){
  const f=await fixture(t,{through:22});
  await f.db.prepare("INSERT INTO contacts(id,name,email,active,locale,token_hash) VALUES(17,'Original contact','Shared@Example.invalid',1,'zh','original-token'),(88,'Inactive contact','inactive@example.invalid',0,'en','inactive-token')").run();
  await f.db.prepare("INSERT INTO recipients(id,name,email,note,active,locale) VALUES(31,'Original recipient','shared@example.invalid','original note',0,'en'),(52,'Recipient only','reader@example.invalid','reader note',1,'ru')").run();
  const item=await f.repo.createEncryptedItem({kind:'letter',title:'Old letter',recipientId:31,encryptedPayload:'{"mode":"link","ciphertext":"fixture"}',payloadSize:40,vaultToken:'fixture-token',vaultTokenHash:'fixture-hash',updatedAt:now});
  if(freeze)await f.repo.getRoundRules(await f.repo.getOwner());
  return {...f,item};
}
async function request(f,path,{method='GET',body,authenticated=true}={}){
  const response=await worker.fetch(new Request('https://example.test'+path,{method,headers:{...(authenticated?{Authorization:'Bearer '+f.env.ADMIN_TOKEN}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),f.env);
  return {response,data:await response.json()};
}

test('migration links original IDs without changing dual-side metadata, letters or frozen rules',async t=>{
  const f=await legacy(t),contacts=(await f.db.prepare('SELECT * FROM contacts ORDER BY id').all()).results,recipients=(await f.db.prepare('SELECT * FROM recipients ORDER BY id').all()).results,item=await f.repo.getEncryptedItemForAdmin(f.item),rules=await f.repo.getRoundRules(await f.repo.getOwner()),settings=await f.repo.getSettings(f.env);
  f.db.applyMigration('0023_people_directory.sql');
  for(const original of contacts)assert.deepEqual(await f.db.prepare('SELECT * FROM contacts WHERE id=?').bind(original.id).first(),original);
  for(const original of recipients)assert.deepEqual(await f.db.prepare('SELECT * FROM recipients WHERE id=?').bind(original.id).first(),original);
  assert.deepEqual(await f.repo.getEncryptedItemForAdmin(f.item),item);assert.deepEqual(await f.repo.getRoundRules(await f.repo.getOwner()),rules);assert.deepEqual(await f.repo.getSettings(f.env),settings);
  const people=(await f.repo.listPeople()).results,shared=people.find(p=>p.id===17),reader=people.find(p=>p.recipient_id===52);
  assert.equal(people.length,3);assert.equal(shared.recipient_id,31);assert.equal(shared.active,null);assert.deepEqual(shared.profile_conflicts,['name','locale','active']);assert.equal(reader.contact_active,1);assert.equal(reader.recipient_locale,'ru');
  const links=(await f.db.prepare('SELECT * FROM people_links ORDER BY contact_id').all()).results;await ensurePeopleLinks(f.db);await ensurePeopleLinks(f.db);assert.deepEqual((await f.db.prepare('SELECT * FROM people_links ORDER BY contact_id').all()).results,links);
  assert.equal((await f.db.prepare('SELECT legacy_contact FROM people_links WHERE recipient_id=52').first()).legacy_contact,0);assert.equal((await f.db.prepare('SELECT legacy_contact FROM people_links WHERE contact_id=17').first()).legacy_contact,1);
});

test('rev-zero bootstrap and reminder guards exclude recipient mirrors and unselected new people',async t=>{
  const f=await legacy(t,{freeze:false});f.db.applyMigration('0023_people_directory.sql');
  const created=await f.repo.createPerson({name:'New person',email:'new@example.invalid',active:true,locale:'en'}),owner=await f.repo.getOwner(),rules=await f.repo.getRoundRules(owner);
  assert.deepEqual(rules.private.contact_ids,[17]);assert.deepEqual(rules.public.contact_ids,[17]);assert.deepEqual(rules.public.audience,['contact:17']);
  const mirror=(await f.repo.listPeople()).results.find(p=>p.recipient_id===52);assert.equal(mirror.active,1);
  const sent=[],provider={name:'capture',async send(message){sent.push(message);return {status:'sent'};}};
  for(const state of ['ALERT','VERIFY']){
    await f.db.prepare('UPDATE owner SET state=? WHERE id=1').bind(state).run();const current=await f.repo.getOwner();
    assert.deepEqual((await f.repo.listPendingTransitionContacts(current,state)).results.map(p=>p.id),[17]);
    assert.equal(await f.repo.transitionMailAllowed(current,await f.repo.getContact(mirror.id),state),false);assert.equal(await f.repo.transitionMailAllowed(current,await f.repo.getContact(created.id),state),false);
    await sendTransitionEmails({repo:f.repo,env:f.env,owner:current,toState:state,now,provider});
  }
  assert.equal(sent.length,2);assert.ok(sent.every(message=>message.to==='Shared@Example.invalid'));
});

test('people API authenticates, omits secrets and creates an unselected complete identity',async t=>{
  const f=await fixture(t);
  assert.equal((await request(f,'/api/people',{authenticated:false})).response.status,401);
  assert.equal((await request(f,'/api/people',{method:'POST',body:{name:'New',email:'new@example.invalid'},authenticated:false})).response.status,401);
  const created=await request(f,'/api/people',{method:'POST',body:{name:'New',email:' NEW@EXAMPLE.INVALID ',note:'note',locale:'ru',active:true}});assert.equal(created.response.status,201);assert.equal(created.data.person.email,'new@example.invalid');
  const person=created.data.person;assert.equal((await f.repo.getContact(person.id)).name,'New');assert.equal((await f.repo.getRecipient(person.recipient_id)).locale,'ru');assert.equal((await f.db.prepare('SELECT legacy_contact FROM people_links WHERE contact_id=?').bind(person.id).first()).legacy_contact,0);
  const before=(await f.db.prepare('SELECT * FROM user_settings').all()).results;const list=await request(f,'/api/people');assert.equal(list.data.results.length,1);assert.doesNotMatch(JSON.stringify(list.data),/token|verification|payload|write_token/i);assert.deepEqual((await f.db.prepare('SELECT * FROM user_settings').all()).results,before);
  const rules=await f.repo.getRoundRules(await f.repo.getOwner());assert.deepEqual(rules.private.contact_ids,[]);assert.deepEqual(rules.public.audience,[]);
  assert.equal((await request(f,'/api/people',{method:'POST',body:{name:'Duplicate',email:'NEW@example.invalid'}})).response.status,409);
});

test('dirty-only PATCH preserves mixed fields and revision fences prevent split updates',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');let person=await f.repo.getPerson(17),original=await f.repo.getEncryptedItemForAdmin(f.item);
  const note=await request(f,'/api/people/17',{method:'PATCH',body:{note:'changed note',expected_revision:person.revision}});assert.equal(note.response.status,200);person=note.data.person;
  assert.equal(person.contact_active,1);assert.equal(person.recipient_active,0);assert.equal(person.contact_locale,'zh');assert.equal(person.recipient_locale,'en');assert.equal(person.contact_name,'Original contact');assert.equal(person.recipient_name,'Original recipient');
  const stale=await request(f,'/api/people/17',{method:'PATCH',body:{name:'stale',expected_revision:0}});assert.equal(stale.response.status,409);assert.equal(stale.data.error,'edit_conflict');assert.doesNotMatch(JSON.stringify(stale.data),/token_hash|ciphertext|write_token/);
  const same=person.revision,results=await Promise.all([request(f,'/api/people/17',{method:'PATCH',body:{name:'Updated name',expected_revision:same}}),request(f,'/api/people/17',{method:'PATCH',body:{locale:'ru',expected_revision:same}})]);assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);
  person=await f.repo.getPerson(17);assert.equal((await f.db.prepare('SELECT write_token FROM people_links WHERE contact_id=17').first()).write_token,null);assert.equal(person.contact_active,1);assert.equal(person.recipient_active,0);
  const after=await f.repo.getEncryptedItemForAdmin(f.item);for(const field of ['recipient_id','encrypted_payload','revision','delivery_version'])assert.equal(after[field],original[field]);
  const before=person;const conflict=await request(f,'/api/people/17',{method:'PATCH',body:{email:'reader@example.invalid',expected_revision:person.revision}});assert.equal(conflict.response.status,409);assert.deepEqual(await f.repo.getPerson(17),before);
});

test('legacy create/update endpoints preserve IDs and synchronize only actual changes on their own side',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');
  const updated=await request(f,'/api/recipients/31',{method:'POST',body:{name:'Original recipient',email:'shared@example.invalid',locale:'en',active:false,note:'legacy edited note'}});assert.equal(updated.response.status,200);
  let person=await f.repo.getPerson(17);assert.equal(person.contact_name,'Original contact');assert.equal(person.contact_locale,'zh');assert.equal(person.contact_active,1);assert.equal(person.recipient_active,0);assert.equal(person.note,'legacy edited note');
  const contact=await request(f,'/api/contacts/17',{method:'POST',body:{name:'Renamed',email:'shared@example.invalid',active:true}});assert.equal(contact.response.status,200);person=await f.repo.getPerson(17);assert.equal(person.recipient_name,'Renamed');assert.equal(person.recipient_active,0);assert.equal(person.recipient_locale,'en');
  const oldLongNote='legacy '.repeat(800);await f.db.prepare('UPDATE recipients SET note=? WHERE id=31').bind(oldLongNote).run();
  const oldForm=await request(f,'/api/recipients/31',{method:'POST',body:{name:'New name',email:'shared@example.invalid',active:false,locale:'en',note:oldLongNote}});assert.equal(oldForm.response.status,200);assert.equal((await f.repo.getPerson(17)).note,oldLongNote);assert.equal((await f.repo.getPerson(17)).contact_active,1);
  for(const path of ['/api/contacts','/api/recipients']){
    const created=await request(f,path,{method:'POST',body:{name:'Legacy create',email:(path.includes('contacts')?'c':'r')+'@new.invalid'}});assert.equal(created.response.status,201);
    const c=await f.repo.getPerson(created.data.contact_id||created.data.id);assert.ok(c);assert.equal(c.recipient_id,created.data.recipient_id||created.data.id);
    assert.equal((await request(f,path==='/api/contacts'?'/api/recipients':'/api/contacts',{method:'POST',body:{name:'Duplicate opposite side',email:c.email}})).response.status,409);
  }
});

test('editing either legacy side email or disabling a person invalidates all verification material atomically',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');await f.db.prepare("UPDATE owner SET state='VERIFY' WHERE id=1").run();await f.repo.rotateContactToken({id:17,tokenHash:'live-token'});
  await f.db.prepare("INSERT INTO verification_challenges(id,contact_id,round,token_hash,code_hash,expires_at,created_at) VALUES('proof',17,1,'live-token','code',?,?)").bind(Date.parse(now)+600000,Date.parse(now)).run();
  const frozen=await f.repo.getRoundRules(await f.repo.getOwner()),old=await f.repo.getEncryptedItemForAdmin(f.item);
  const update=await request(f,'/api/recipients/31',{method:'POST',body:{email:'changed@example.invalid'}});assert.equal(update.response.status,200);const person=await f.repo.getPerson(17),contact=await f.repo.getContact(17);
  assert.equal(person.contact_email,'changed@example.invalid');assert.equal(person.recipient_email,'changed@example.invalid');assert.equal(contact.verification_round,null);assert.equal(contact.verification_expires_at,null);assert.notEqual(contact.token_hash,'live-token');assert.ok((await f.db.prepare("SELECT used_at FROM verification_challenges WHERE id='proof'").first()).used_at!==null);
  assert.equal((await f.repo.getEncryptedItemForAdmin(f.item)).recipient_id,old.recipient_id);assert.deepEqual(await f.repo.getRoundRules(await f.repo.getOwner()),frozen);
  const deactivate=await request(f,'/api/people/17',{method:'DELETE',body:{expected_revision:person.revision}});assert.equal(deactivate.response.status,200);assert.equal(deactivate.data.person.active,0);
});

test('settings locale changes invalidate stale people edits without silently synchronizing dual locale',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');const before=await f.repo.getPerson(17),settings=await f.repo.getSettings(f.env);
  await f.repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules:settings.active,languages:[{table:'recipients',id:31,locale:'ru'}],now});
  const after=await f.repo.getPerson(17);assert.ok(after.revision>before.revision);assert.equal(after.contact_locale,'zh');assert.equal(after.recipient_locale,'ru');
  assert.equal((await request(f,'/api/people/17',{method:'PATCH',body:{note:'stale',expected_revision:before.revision}})).response.status,409);
});

test('bridging a recipient-only public audience keeps its alias and successful receipt without another send',async t=>{
  const f=await legacy(t);await f.db.prepare("UPDATE round_rules SET rules_json=json_set(rules_json,'$.public.audience',json('[\"recipient:52\"]')) WHERE round=1").run();
  await f.repo.upsertPublicFarewell({title:'Public',body:'',status:'DRAFT',now});const version=(await f.repo.farewell.getVersions()).formal_revision,key=`public_farewell_release:v2:${version}:${now}:recipient:52:reader@example.invalid`;
  await f.db.prepare("INSERT INTO mail_claims(dedupe_key,status,claimed_at) VALUES(?,'sent',?)").bind(key,now).run();
  f.db.applyMigration('0023_people_directory.sql');await f.db.prepare("UPDATE owner SET state='PUBLIC_RELEASE' WHERE id=1").run();await f.db.prepare("UPDATE public_farewell SET status='PUBLIC_RELEASE' WHERE id=1").run();
  const before=await f.repo.getRoundRules(await f.repo.getOwner());await request(f,'/api/people');let sends=0;
  const results=await deliverPublicFarewell(f.repo,f.env,now,await f.repo.getOwner(),{name:'capture',async send(){sends++;return {status:'sent'};}});assert.equal(sends,0);assert.equal(results.length,1);assert.equal(results[0].reason,'dedupe');assert.deepEqual(await f.repo.getRoundRules(await f.repo.getOwner()),before);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM mail_claims').first()).count,1);assert.deepEqual(before.public.audience,['recipient:52']);
});

async function legacyLetter(f,{recipientId=null}={}){
  const payload=await buildStoredPayload({body:{plaintext:'Original legacy letter'},env:f.env});
  await f.db.prepare('UPDATE encrypted_items SET recipient_id=?,recipient_contact_id=17,encrypted_payload=?,delivery_version=7 WHERE id=?').bind(recipientId,payload,f.item).run();
  return f.repo.getEncryptedItemForAdmin(f.item);
}

test('body-only legacy letter saves retain the exact contact tuple, locale and delivery-version semantics',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');const original=await legacyLetter(f);
  // Its linked recipient 31 is inactive and uses a different name/language.
  let saved=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:31,preserve_recipient:true,plaintext:'Updated legacy body',expected_revision:original.revision}});assert.equal(saved.response.status,200);
  let item=await f.repo.getEncryptedItemForAdmin(f.item);assert.equal(item.recipient_id,null);assert.equal(item.recipient_contact_id,17);assert.equal(item.recipient_name,'Original contact');assert.equal(item.recipient_locale,'zh');assert.equal(item.delivery_version,8);
  assert.equal((await openStoredPayload(item.encrypted_payload,f.env)).plaintext,'Updated legacy body');
  const stale=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:52,preserve_recipient:true,plaintext:'Stale body',expected_revision:original.revision}});assert.equal(stale.response.status,409);assert.equal((await f.repo.getEncryptedItemForAdmin(f.item)).delivery_version,8);
  // The preserve flag ignores forged dropdown/contact IDs and unchanged text
  // does not create a new delivery version.
  saved=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:52,recipient_contact_id:88,preserve_recipient:true,plaintext:'Updated legacy body',expected_revision:item.revision}});assert.equal(saved.response.status,200);
  item=await f.repo.getEncryptedItemForAdmin(f.item);assert.equal(item.recipient_id,null);assert.equal(item.recipient_contact_id,17);assert.equal(item.delivery_version,8);
  saved=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:52,preserve_recipient:false,plaintext:'Updated legacy body',expected_revision:item.revision}});assert.equal(saved.response.status,200);
  item=await f.repo.getEncryptedItemForAdmin(f.item);assert.equal(item.recipient_id,52);assert.equal(item.recipient_locale,'ru');assert.equal(item.delivery_version,9);
});

test('preserving a letter validates its actual recipient side, never a more permissive linked side',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');let item=await legacyLetter(f,{recipientId:31});
  let saved=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:52,preserve_recipient:true,plaintext:'Must fail',expected_revision:item.revision}});assert.equal(saved.response.status,400);assert.equal((await f.repo.getEncryptedItemForAdmin(f.item)).delivery_version,7);
  await f.db.prepare('UPDATE recipients SET active=1 WHERE id=31').run();await f.db.prepare('UPDATE contacts SET active=0 WHERE id=17').run();
  saved=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:52,preserve_recipient:true,plaintext:'Recipient-side body',expected_revision:item.revision}});assert.equal(saved.response.status,200);
  item=await f.repo.getEncryptedItemForAdmin(f.item);assert.equal(item.recipient_id,31);assert.equal(item.recipient_name,'Original recipient');assert.equal(item.recipient_locale,'en');assert.equal(item.delivery_version,8);
  await f.db.prepare('UPDATE encrypted_items SET recipient_id=NULL WHERE id=?').bind(f.item).run();item=await f.repo.getEncryptedItemForAdmin(f.item);
  saved=await request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:52,preserve_recipient:true,plaintext:'Inactive contact must fail',expected_revision:item.revision}});assert.equal(saved.response.status,400);assert.equal((await f.repo.getEncryptedItemForAdmin(f.item)).recipient_id,null);
});

test('concurrent preserved-recipient letter saves accept one CAS and one delivery revision',async t=>{
  const f=await legacy(t);f.db.applyMigration('0023_people_directory.sql');const original=await legacyLetter(f);
  const results=await Promise.all(['First edit','Second edit'].map(plaintext=>request(f,'/api/items/'+f.item,{method:'POST',body:{recipient_id:31,preserve_recipient:true,plaintext,expected_revision:original.revision}})));
  assert.deepEqual(results.map(result=>result.response.status).sort(),[200,409]);
  const item=await f.repo.getEncryptedItemForAdmin(f.item);assert.equal(item.recipient_id,null);assert.equal(item.recipient_contact_id,17);assert.equal(item.revision,original.revision+1);assert.equal(item.delivery_version,8);assert.ok(['First edit','Second edit'].includes((await openStoredPayload(item.encrypted_payload,f.env)).plaintext));
});
