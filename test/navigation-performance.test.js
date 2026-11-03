// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {FarewellV2Repository} from '../src/farewell-v2.js';
import worker from '../src/worker.js';

const now='2030-01-01T00:00:00.000Z';
async function fixture(t){
  const db=database();t.after(()=>db.close());
  const repo=new Repository(db),allow={async limit(){return {success:true};}};
  const env={DB:db,ADMIN_TOKEN:'navigation-fixture',MAIL_PROVIDER:'dry-run',READ_LIMITER:allow,API_LIMITER:allow};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});
  await repo.getRoundRules(await repo.getOwner());
  return {db,repo,env};
}
const read=(env,path,authenticated=true)=>worker.fetch(new Request('https://example.test'+path,{headers:authenticated?{Authorization:'Bearer '+env.ADMIN_TOKEN}:{}}),env);

test('editor includes a bounded chapter directory without fetching unopened chapter bodies',async t=>{
  const {repo,env}=await fixture(t);
  for(let i=1;i<=55;i++){
    const id=await repo.farewell.createGroup({title:'Chapter '+i,now});
    await repo.farewell.createEntry({groupId:id,body:'BODY_MARKER_'+i+'_END',isPublic:true,now});
  }
  const route='/api/public-farewell-v2/editor?group=55';
  assert.equal((await read(env,route,false)).status,401);
  const response=await read(env,route),page=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(page.directory.results.length,50);assert.equal(page.directory.selected.id,55);
  assert.equal(page.directory.selected.entry_count,1);assert.equal(page.directory.results[0].id,1);
  for(const summary of [...page.directory.results,page.directory.selected])assert.deepEqual(Object.keys(summary).sort(),['draft_sort_order','draft_title','entry_count','id','revision']);
  assert.match(page.html,/BODY_MARKER_55_END/);
  assert.doesNotMatch(page.html,/BODY_MARKER_(?:1|54)_END/);
  const next=await (await read(env,'/api/chapters?cursor='+page.directory.next_cursor)).json();
  assert.deepEqual(next.results.map(g=>g.id),[51,52,53,54,55]);assert.equal(next.next_cursor,null);
});

test('batched editor preserves formal and draft separation, empty state, trash and pagination',async t=>{
  const {repo}=await fixture(t);
  assert.equal((await repo.farewell.getEditorPage()).editor_group,null);
  const group=await repo.farewell.createGroup({title:'First',now});
  const entry=await repo.farewell.createEntry({groupId:group,body:'Formal content',isPublic:true,now});
  await repo.farewell.applyDraft({now});
  await repo.farewell.saveEntryDraft({id:entry,body:'Draft content',groupId:group,isPublic:true,now});
  for(let i=0;i<51;i++)await repo.farewell.createEntry({groupId:group,body:'More '+i,isPublic:true,now});
  const removed=await repo.farewell.createGroup({title:'Removed',now});
  await repo.db.prepare('UPDATE public_farewell_groups_v2 SET draft_is_deleted=1 WHERE id=?').bind(removed).run();
  const page=await repo.farewell.getEditorPage({groupId:removed});
  assert.equal(page.editor_group.id,group);assert.equal(page.editor_group.entries.length,50);
  assert.equal(page.editor_group.entries[0].excerpt,'Draft content');
  assert.equal(page.formal_groups[0].entries.length,0);
  assert.equal((await repo.farewell.getFormalPage({groupId:group})).results[0].body,'Formal content');
  assert.equal((await repo.farewell.getEntryEditor(entry)).draft_body,'Draft content');assert.ok(page.next_entry_cursor);
  assert.equal(page.trashed_groups[0].id,removed);
  assert.equal(page.pending_count,(await repo.farewell.getEditorState()).pending_count);
});

test('editor panels use one database round trip rather than serial remote reads',async t=>{
  const {db,repo}=await fixture(t);
  const group=await repo.farewell.createGroup({title:'Example',now});
  await repo.farewell.createEntry({groupId:group,body:'Example body',isPublic:true,now});
  let batches=0;
  const batched=new FarewellV2Repository({
    prepare(sql){
      const raw=db.prepare(sql);
      return {bind(...args){raw.bind(...args);return this;},run:()=>raw.run(),
        first(){assert.fail('Unbatched remote read');},all(){assert.fail('Unbatched remote read');}};
    },
    batch(statements){batches++;return db.batch(statements);},
  });
  assert.equal((await batched.getEditorPage({groupId:group})).editor_group.entries[0].excerpt,'Example body');
  assert.equal(batches,1);
});
