// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {RECOVERY_COLUMNS} from '../src/backup-format.js';
import {validateBackupShape} from '../scripts/restore-backup.mjs';

test('HTTP backup capacity schema covers every exported column',async t=>{
  const db=database({through:24});t.after(()=>db.close());
  for(const [table,columns] of Object.entries(RECOVERY_COLUMNS))assert.deepEqual((await db.prepare('PRAGMA table_info('+table+')').all()).results.map(c=>c.name),columns,table);
});
test('HTTP export rejects oversized snapshots before fetching any payload rows',async t=>{
  const db=database({through:23});t.after(()=>db.close());const repo=new Repository(db);
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:new Date().toISOString()});
  await repo.getSettings({});
  const group=await repo.farewell.createGroup({title:'Example',now:new Date().toISOString()});
  const body='x'.repeat(512*1024);
  const now=new Date().toISOString();
  for(let i=0;i<17;i++)await db.prepare('INSERT INTO public_farewell_entries_v2(group_id,draft_group_id,body,draft_body,sort_order,draft_sort_order,created_at,draft_updated_at,body_updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(group,group,body,body,i,i,now,now,now).run();
  let payloadRead=false;repo.recoverySnapshot=async()=>{payloadRead=true;throw Error('Unexpected payload read');};
  await assert.rejects(repo.exportBackup({includePayloads:true}),e=>e.status===413&&/offline D1 export/.test(e.message));
  assert.equal(payloadRead,false);
});

test('HTTP recovery export reports its actual v23/v24 schema and never references newer columns on v23',async t=>{
  for(const version of [23,24]){
    const db=database({through:version});t.after(()=>db.close());const repo=new Repository(db);
    await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now:'2026-10-23T00:00:00Z'});await repo.getSettings({});
    const backup=await repo.exportBackup({includePayloads:true});assert.equal(backup.schema_version,version);validateBackupShape(backup);assert.equal(Object.hasOwn(backup.recovery_tables,'background_jobs'),version===24);
    assert.deepEqual(Object.keys(backup.recovery_tables.mail_claims[0]||{}),[]);
    if(version===24)assert.deepEqual(backup.recovery_tables.background_jobs,[]);
  }
});
