// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {FarewellV2Repository} from '../src/farewell-v2.js';
import {farewellEditorMarkup} from '../src/farewell-editor-ui.js';
import worker from '../src/worker.js';
const now='2030-01-01T00:00:00.000Z';
async function fixture(t){
  const db=database();t.after(()=>db.close());const repo=new Repository(db),allow={async limit(){return {success:true};}};
  const env={DB:db,ADMIN_TOKEN:'editor-fixture',MAIL_PROVIDER:'dry-run',API_LIMITER:allow,EXPENSIVE_LIMITER:allow,READ_LIMITER:allow};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const group=await repo.farewell.createGroup({title:'Chapter',now}),entry=await repo.farewell.createEntry({groupId:group,body:'Original',isPublic:true,now});
  await repo.farewell.applyDraft({now});return {db,repo,env,group,entry};
}
const post=(env,path,body)=>worker.fetch(new Request('https://example.invalid'+path,{method:'POST',headers:{Authorization:'Bearer '+env.ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);

test('apply and discard require the reviewed document revision and reject unseen drafts',async t=>{
  const {repo,env,group,entry}=await fixture(t),review=await repo.farewell.getChanges();
  assert.equal((await post(env,'/api/public-farewell-v2/apply',{})).status,428);
  assert.equal((await post(env,'/api/public-farewell-v2/discard',{})).status,428);
  await repo.farewell.saveEntryDraft({id:entry,body:'Other tab',groupId:group,isPublic:true,now});
  for(const action of ['apply','discard'])assert.equal((await post(env,'/api/public-farewell-v2/'+action,{expected_draft_revision:review.draft_revision})).status,409);
  assert.equal((await repo.farewell.getEntry(entry)).draft_body,'Other tab');
  assert.equal((await repo.farewell.getEntry(entry)).body,'Original');
});

test('the transaction rejects an edit that arrives after the apply snapshot',async t=>{
  const {db,repo,group,entry}=await fixture(t);await repo.farewell.saveEntryDraft({id:entry,body:'Reviewed',groupId:group,isPublic:true,now});
  const reviewed=await repo.farewell.getVersions();let injected=false;
  const concurrent=new FarewellV2Repository({prepare:sql=>db.prepare(sql),async batch(statements){const result=await db.batch(statements);if(!injected){injected=true;await repo.farewell.saveEntryDraft({id:entry,body:'Arrived after snapshot',groupId:group,isPublic:true,now});}return result;}});
  const result=await concurrent.applyDraft({now,expectedDraftRevision:reviewed.draft_revision});
  assert.equal(result.conflict,true);assert.equal((await repo.farewell.getEntry(entry)).body,'Original');
  assert.equal((await repo.farewell.getEntry(entry)).draft_body,'Arrived after snapshot');
  assert.equal((await repo.farewell.getVersions()).formal_revision,reviewed.formal_revision);
});

test('formal revisions increase for different commits with the same timestamp',async t=>{
  const {repo,group,entry}=await fixture(t),before=await repo.farewell.getVersions();
  for(const body of ['Second','Third']){await repo.farewell.saveEntryDraft({id:entry,body,groupId:group,isPublic:true,now});assert.equal((await repo.farewell.applyDraft({now})).changed,true);}
  assert.equal((await repo.farewell.getVersions()).formal_revision,before.formal_revision+2);
  const noChange=await repo.farewell.applyDraft({now});assert.equal(noChange.changed,false);assert.equal(noChange.formal_revision,before.formal_revision+2);
});

test('discard rejects a concurrent edit between its read and transaction',async t=>{
  const {db,repo,group,entry}=await fixture(t);let injected=false;
  const concurrent=new FarewellV2Repository({prepare(sql){const raw=db.prepare(sql);return {bind(...values){raw.bind(...values);return this;},async first(){const row=await raw.first();if(sql.includes('FROM farewell_document_versions')&&!injected){injected=true;await repo.farewell.saveEntryDraft({id:entry,body:'Keep concurrent draft',groupId:group,isPublic:true,now});}return row;},all:()=>raw.all(),run:()=>raw.run()};},batch:statements=>db.batch(statements)});
  const result=await concurrent.discardDraft({now});assert.equal(result.conflict,true);assert.equal((await repo.farewell.getEntry(entry)).draft_body,'Keep concurrent draft');
});

test('cached pending count follows edits, trash, apply, discard and permanent deletion',async t=>{
  const {repo,group,entry}=await fixture(t);
  const check=async()=>assert.equal((await repo.farewell.getVersions()).pending_count,(await repo.farewell.getEditorState()).pending_count);
  await check();await repo.farewell.saveEntryDraft({id:entry,body:'Changed',groupId:group,isPublic:true,now});await check();
  await repo.farewell.setTrashed({kind:'group',id:group,trashed:true,now});await check();await repo.farewell.applyDraft({now});await check();
  await repo.farewell.setTrashed({kind:'entry',id:entry,trashed:true,now});await check();await repo.farewell.discardDraft({now});await check();
  const draft=await repo.farewell.createGroup({title:'Discardable',now});await check();await repo.farewell.permanentlyDelete({kind:'group',id:draft});await check();
});

test('legacy management links to the lazy editor without querying public bodies',async t=>{
  const {db,env}=await fixture(t);let bodyReads=0;
  const measured={...db,prepare(sql){if(/SELECT \* FROM public_farewell_(groups|entries)_v2/.test(sql)){bodyReads++;throw Error('Legacy must not load the editor archive');}return db.prepare(sql);}};
  const response=await worker.fetch(new Request('https://example.invalid/admin/legacy',{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),{...env,DB:measured});
  const html=await response.text();assert.match(html,/href="\/admin#farewell"/);assert.doesNotMatch(html,/D1 schema 尚未初始化/);assert.equal(bodyReads,0);
});

test('a huge chapter loads only bounded summaries and one requested draft body',async t=>{
  const {repo,group,entry}=await fixture(t),body='a'.repeat(100000)+'UNOPENED_BODY_END';
  await repo.farewell.saveEntryDraft({id:entry,body,groupId:group,isPublic:true,now});
  for(let i=0;i<55;i++)await repo.farewell.createEntry({groupId:group,body,isPublic:true,now});
  const page=await repo.farewell.getEditorPage({groupId:group}),html=farewellEditorMarkup({state:page,embedded:true});
  assert.equal(page.editor_group.entries.length,50);assert.ok(page.next_entry_cursor);assert.ok(Buffer.byteLength(html)<100000);
  assert.doesNotMatch(html,/UNOPENED_BODY_END/);assert.ok(page.editor_group.entries.every(e=>!('draft_body' in e)&&!('body' in e)));
  const opened=await repo.farewell.getEntryEditor(entry);assert.equal(opened.draft_body,body);assert.equal('body' in opened,false);
  const changes=await repo.farewell.getChanges();assert.doesNotMatch(JSON.stringify(changes),/UNOPENED_BODY_END/);
});

test('formal preview pagination includes all entries and every Unicode body fragment',async t=>{
  const {repo,group,entry}=await fixture(t),long='😀'.repeat(40000)+'THE_END';
  await repo.farewell.saveEntryDraft({id:entry,body:long,groupId:group,isPublic:true,now});
  for(let i=0;i<55;i++)await repo.farewell.createEntry({groupId:group,body:'Entry '+i,isPublic:true,now});
  await repo.farewell.applyDraft({now});let cursor='0',pages=0;const bodies=new Map();
  do{const page=await repo.farewell.getFormalPage({groupId:group,cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<100000);for(const row of page.results)bodies.set(row.id,(bodies.get(row.id)||'')+row.body);cursor=page.next_cursor;assert.ok(++pages<20);}while(cursor);
  assert.equal(bodies.size,56);assert.equal(bodies.get(entry),long);
});

test('trash cursors expose every old group and entry without full bodies',async t=>{
  const {repo,group}=await fixture(t);for(let i=0;i<55;i++){const g=await repo.farewell.createGroup({title:'Deleted '+i,now}),e=await repo.farewell.createEntry({groupId:group,body:'x'.repeat(100000),isPublic:true,now});await repo.farewell.setTrashed({kind:'group',id:g,trashed:true,now});await repo.farewell.setTrashed({kind:'entry',id:e,trashed:true,now});}
  for(const kind of ['groups','entries']){let cursor='0';const ids=new Set();do{const page=await repo.farewell.getTrashPage({kind,cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<20000);for(const row of page.results)ids.add(row.id);cursor=page.next_cursor;}while(cursor);assert.equal(ids.size,55);}
});
