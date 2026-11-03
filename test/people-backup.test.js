// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,sep,join} from 'node:path';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {requiredBackupTables,validateBackupShape,restoreBackup} from '../scripts/restore-backup.mjs';
import {parseD1Dump,exportLocalBackup} from '../scripts/export-backup-local.mjs';

const stamp='2030-01-01T00:00:00.000Z';
function directory(t){
  const parent=resolve('output');mkdirSync(parent,{recursive:true});const path=mkdtempSync(join(parent,'people-backup-'));
  t.after(()=>{if(!resolve(path).startsWith(parent+sep+'people-backup-'))throw Error('Unsafe fixture cleanup');rmSync(path,{recursive:true,force:true});});return path;
}
async function insertKnown(db,table,row){
  const columns=new Set((await db.prepare('PRAGMA table_info('+table+')').all()).results.map(c=>c.name));
  const fields=Object.keys(row).filter(key=>columns.has(key));
  await db.prepare('INSERT INTO '+table+' ('+fields.join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')').bind(...fields.map(key=>row[key])).run();
}
async function fixture(t,version){
  const db=database({through:Math.min(version,22)});t.after(()=>db.close());const repo=new Repository(db);
  await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now:stamp});
  await insertKnown(db,'contacts',{id:10,name:'Original confirmer name',email:' SHARED@example.invalid ',role:'friend',priority:10,active:0,token_hash:'synthetic-token-10',locale:'ru',created_at:stamp});
  await insertKnown(db,'contacts',{id:30,name:'Contact only',email:'contact@example.invalid',role:'friend',priority:30,active:1,token_hash:'synthetic-token-30',locale:'en',created_at:stamp});
  await insertKnown(db,'recipients',{id:20,name:'Original recipient name',email:'shared@example.invalid',note:'Preserve recipient note',active:1,locale:'en',created_at:stamp,updated_at:stamp});
  await insertKnown(db,'recipients',{id:40,name:'Recipient only',email:'reader@example.invalid',note:'Synthetic',active:1,locale:'ru',created_at:stamp,updated_at:stamp});
  if(version>=18){await repo.getSettings({MAX_DAILY_EMAILS:'20'});await repo.getRoundRules(await repo.getOwner());await db.prepare('UPDATE user_settings SET revision=1,configured=1').run();}
  if(version===23)db.applyMigration('0023_people_directory.sql');
  const recovery_tables={};for(const name of requiredBackupTables(version))recovery_tables[name]=(await db.prepare('SELECT * FROM '+name).all()).results;
  return {db,backup:{format:'afterme-recovery-backup',format_version:2,schema_version:version,includes_payloads:true,recovery_tables}};
}
function assertOriginalPeople(sqlite,version){
  const contact=sqlite.prepare('SELECT name,email,locale,active FROM contacts WHERE id=10').get(),recipient=sqlite.prepare('SELECT name,email,locale,active,note FROM recipients WHERE id=20').get();
  assert.equal(contact.name,'Original confirmer name');assert.equal(contact.email,' SHARED@example.invalid ');assert.equal(contact.active,0);assert.equal(contact.locale,version>=18?'ru':'zh');
  assert.equal(recipient.name,'Original recipient name');assert.equal(recipient.email,'shared@example.invalid');assert.equal(recipient.active,1);assert.equal(recipient.locale,version>=18?'en':'zh');assert.equal(recipient.note,'Preserve recipient note');
  const links=sqlite.prepare('SELECT * FROM people_links ORDER BY contact_id').all();assert.equal(links.length,3);
  assert.equal(links.find(row=>row.contact_id===10).recipient_id,20);
  assert.equal(links.find(row=>row.contact_id===10).legacy_contact,1);assert.equal(links.find(row=>row.contact_id===30).legacy_contact,1);
  const mirror=links.find(row=>row.recipient_id===40);assert.ok(mirror);assert.equal(mirror.legacy_contact,0);
  assert.ok(links.every(row=>row.write_token===null));assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  return links;
}

for(const version of [16,17,18,19,20,21,22])test('schema '+version+' recovery backfills the unified directory without rewriting original identities',async t=>{
  const {backup}=await fixture(t,version),path=directory(t),input=join(path,'legacy.json'),output=join(path,'recovered.sqlite');writeFileSync(input,JSON.stringify(backup));
  const result=await restoreBackup(input,output);assert.equal(result.application_smoke_verified,true);assert.equal(result.network_used,false);
  const sqlite=new DatabaseSync(output,{readOnly:true});try{
    assertOriginalPeople(sqlite,version);const owner=sqlite.prepare('SELECT * FROM owner WHERE id=1').get();assert.equal(owner.last_checkin_at,stamp);assert.equal(owner.confirmation_round,backup.recovery_tables.owner[0].confirmation_round+1);assert.equal(owner.release_suspended,1);
    const current=JSON.parse(sqlite.prepare('SELECT rules_json FROM round_rules WHERE round=?').get(owner.confirmation_round).rules_json);
    assert.deepEqual(current.private.contact_ids,[30]);assert.deepEqual(current.public.contact_ids,[30]);assert.deepEqual(current.public.audience,['contact:30']);
    if(version>=18)assert.equal(sqlite.prepare('SELECT rules_json FROM round_rules WHERE round=?').get(backup.recovery_tables.owner[0].confirmation_round).rules_json,backup.recovery_tables.round_rules[0].rules_json);
  }finally{sqlite.close();}
});

test('schema 23 recovery preserves mappings and legacy roles while clearing interrupted writes',async t=>{
  const {backup}=await fixture(t,23),link=backup.recovery_tables.people_links.find(row=>row.contact_id===10);link.revision=7;link.write_token='synthetic-interrupted-write';
  const path=directory(t),input=join(path,'current.json'),output=join(path,'recovered.sqlite');writeFileSync(input,JSON.stringify(backup));await restoreBackup(input,output);
  const sqlite=new DatabaseSync(output,{readOnly:true});try{const links=assertOriginalPeople(sqlite,23);assert.equal(links.find(row=>row.contact_id===10).revision,7);}finally{sqlite.close();}
});

test('schema 23 backups reject missing, duplicate, dangling or mismatched mappings',async t=>{
  const {backup}=await fixture(t,23),cases=[
    b=>delete b.recovery_tables.people_links,b=>b.recovery_tables.people_links=[],b=>b.recovery_tables.people_links.pop(),
    b=>b.recovery_tables.people_links.push({...b.recovery_tables.people_links[0]}),
    b=>b.recovery_tables.people_links[0].contact_id=999,b=>b.recovery_tables.people_links[0].recipient_id=999,
    b=>b.recovery_tables.people_links[0].revision=-1,b=>b.recovery_tables.people_links[0].legacy_contact=2,
    b=>delete b.recovery_tables.people_links[0].write_token,b=>b.recovery_tables.people_links[0].write_token=1,
    b=>{const [a,c]=b.recovery_tables.people_links;[a.recipient_id,c.recipient_id]=[c.recipient_id,a.recipient_id];},
  ];
  for(const mutate of cases){const altered=structuredClone(backup);mutate(altered);assert.throws(()=>validateBackupShape(altered));}
  const path=directory(t),input=join(path,'incomplete.json'),output=join(path,'must-not-exist.sqlite'),bad=structuredClone(backup);bad.recovery_tables.people_links=[];writeFileSync(input,JSON.stringify(bad));await assert.rejects(restoreBackup(input,output));assert.equal(existsSync(output),false);
});

test('schema 23 D1 literals and read-only SQLite export retain unified directory recovery data',async t=>{
  const {db,backup}=await fixture(t,23),quote=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
  let sql='PRAGMA defer_foreign_keys=TRUE;\n';
  for(const name of requiredBackupTables(23)){
    sql+=(await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(name).first()).sql+';\n';
    const columns=(await db.prepare('PRAGMA table_info('+name+')').all()).results.map(row=>row.name);
    for(const row of backup.recovery_tables[name])sql+='INSERT INTO "'+name+'" VALUES ('+columns.map(key=>quote(row[key])).join(',')+');\n';
  }
  const parsed=parseD1Dump(sql);assert.equal(parsed.schema_version,23);assert.deepEqual(parsed.recovery_tables.people_links,backup.recovery_tables.people_links.map(row=>({...row})));
  const path=directory(t),input=join(path,'synthetic.sql'),canonical=join(path,'canonical.json'),sqlitePath=join(path,'recovered.sqlite'),second=join(path,'from-sqlite.json');writeFileSync(input,sql);
  assert.equal((await exportLocalBackup(input,canonical)).schema_version,23);await restoreBackup(canonical,sqlitePath);assert.equal((await exportLocalBackup(sqlitePath,second)).schema_version,24);
  const exported=JSON.parse(readFileSync(second,'utf8'));assert.equal(exported.recovery_tables.people_links.length,3);validateBackupShape(exported);
});
