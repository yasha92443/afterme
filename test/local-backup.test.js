// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {requiredBackupTables,restoreBackup} from '../scripts/restore-backup.mjs';
import {parseD1Dump,exportLocalBackup} from '../scripts/export-backup-local.mjs';

function temp(t){const dir=mkdtempSync(join(tmpdir(),'afterme-local-export-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function sqlValue(value){return value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";}
async function fixture(t,{through=23,withMigrations=false}={}){
 const db=database({through});t.after(()=>db.close());const repo=new Repository(db);await repo.setupOwner({displayName:"Owner's text; still a literal",email:'owner@example.invalid',now:new Date().toISOString()});if(through>=18){await repo.getSettings({MAX_DAILY_EMAILS:'20'});await repo.getRoundRules(await repo.getOwner());}let sql='PRAGMA defer_foreign_keys=TRUE;\nBEGIN TRANSACTION;\n';
 if(withMigrations){await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE,applied_at TEXT)').run();const name=readdirSync(new URL('../migrations/',import.meta.url)).find(file=>Number(file.slice(0,4))===through);await db.prepare('INSERT INTO d1_migrations VALUES(1,?,?)').bind(name,new Date().toISOString()).run();}
 for(const name of [...requiredBackupTables(through),...(withMigrations?['d1_migrations']:[])]){const row=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(name).first();sql+=row.sql+';\n';const columns=(await db.prepare('PRAGMA table_info('+name+')').all()).results.map(row=>row.name);for(const record of (await db.prepare('SELECT * FROM '+name).all()).results)sql+='INSERT INTO "'+name+'" VALUES ('+columns.map(c=>sqlValue(record[c])).join(',')+');\n';}
 for(const trigger of (await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all()).results)sql+=trigger.sql+';\n';return {db,repo,sql:sql+'COMMIT;\n'};
}
for(const version of [16,17,18,19,20,21,22,23,24])test('schema '+version+' literal D1 dump converts offline and passes backup verify',async t=>{
 const f=await fixture(t,{through:version,withMigrations:version===19||version>=22}),dir=temp(t),input=join(dir,'d1.sql'),output=join(dir,'canonical.json');writeFileSync(input,f.sql);const result=await exportLocalBackup(input,output);assert.equal(result.network_used,false);assert.equal(result.schema_version,version);const backup=JSON.parse(readFileSync(output,'utf8'));assert.equal(backup.schema_version,version);assert.equal(backup.format_version,2);assert.equal(backup.recovery_tables.owner[0].display_name,"Owner's text; still a literal");assert.equal(backup.owner,undefined);assert.equal(backup.recovery_tables.d1_migrations,undefined);
 const verify=spawnSync(process.execPath,['scripts/verify-backup.mjs',output],{encoding:'utf8',windowsHide:true});assert.equal(verify.status,0,verify.stderr);assert.equal(JSON.parse(verify.stdout).application_smoke_verified,true);await assert.rejects(exportLocalBackup(input,output));
});

test('D1 newline replace literals decode LF, CRLF and bounded nesting as data',async t=>{
 const f=await fixture(t,{through:19,withMigrations:true}),dir=temp(t),input=join(dir,'newlines.sql'),output=join(dir,'canonical.json'),old=sqlValue("Owner's text; still a literal");
 const original="Owner's first line\n第二行🙂\r\nThird\rFinal\n",encoded="replace(replace("+sqlValue(original.replaceAll('\r','\\r').replaceAll('\n','\\n'))+",'\\n',char(10)),'\\r',char(13))";
 writeFileSync(input,f.sql.replace(old,()=>encoded));await exportLocalBackup(input,output);const backup=JSON.parse(readFileSync(output,'utf8'));assert.equal(backup.recovery_tables.owner[0].display_name,original);assert.equal(backup.schema_version,19);
 const verify=spawnSync(process.execPath,['scripts/verify-backup.mjs',output],{encoding:'utf8',windowsHide:true});assert.equal(verify.status,0,verify.stderr);assert.equal(JSON.parse(verify.stdout).application_smoke_verified,true);
 for(const [expression,expected] of [["replace('A^B','^',char(10))",'A\nB'],["REPLACE ( 'A^B', '^', CHAR ( 13 ) )",'A\rB'],["replace('A'';B',';',char(10))","A'\nB"],["replace('unchanged','',char(10))",'unchanged'],["replace(replace('A@#B@C#D','@',char(13)),'#',char(10))",'A\r\nB\rC\nD'],["replace(replace(replace(replace('A@B#C$D%E','@',char(10)),'#',char(13)),'$',char(10)),'%',char(13))",'A\nB\rC\nD\rE']])assert.equal(parseD1Dump(f.sql.replace(old,()=>expression)).recovery_tables.owner[0].display_name,expected);
});

test('newline decoding rejects arbitrary expressions, char injection and excessive nesting',async t=>{
 const f=await fixture(t,{through:19}),old=sqlValue("Owner's text; still a literal");
 const expressions=["char(10)","replace('a','a',char(0))","replace('a','a',char(010))","replace('a','a',char(10+1))","replace('a','a',char(10,13))","replace('a','a',char((SELECT 10)))","replace('a','a',char(10)||load_extension('x'))","replace('a','a',char(10))||'tail'","replace('a','a',upper('x'))","replace(load_extension('x'),'a',char(10))","replace('a',replace('a','a',char(10)),char(13))","replace('a','a',char(10),char(13))","replace(NULL,'a',char(10))","replace('a','a',char(13.0))","replace(replace(replace(replace(replace('a','a',char(10)),'a',char(10)),'a',char(10)),'a',char(10)),'a',char(10))"];
 for(const expression of expressions)assert.throws(()=>parseD1Dump(f.sql.replace(old,()=>expression)),undefined,expression);
 const dir=temp(t),input=join(dir,'rejected.sql'),output=join(dir,'must-not-exist.json'),marker=crypto.randomUUID();writeFileSync(input,f.sql.replace(old,"replace('a','a',char(10)||load_extension('"+marker+"'))"));const cli=spawnSync(process.execPath,['scripts/export-backup-local.mjs',input,output],{encoding:'utf8',windowsHide:true});assert.notEqual(cli.status,0);assert.equal((cli.stdout+cli.stderr).includes(marker),false);assert.equal(existsSync(output),false);
});

test('implicit sqlite_sequence insertions use only the trusted two-column system layout',async t=>{
 for(const through of [19,22,23]){
  const f=await fixture(t,{through}),sql=f.sql+'DELETE FROM sqlite_sequence;\nINSERT INTO "sqlite_sequence" VALUES (\'encrypted_items\',7),(\'contacts\',3);\n';
  const backup=parseD1Dump(sql);assert.equal(backup.schema_version,through);assert.equal(backup.recovery_tables.sqlite_sequence,undefined);
  for(const suffix of ["INSERT INTO sqlite_sequence VALUES ('owner',1,2);","INSERT INTO sqlite_sequence(name,unknown) VALUES ('owner',1);","INSERT INTO d1_migrations VALUES (1,'0019_security.sql','2026-10-21');","INSERT INTO audit_log VALUES (1,'x','x','x');"] )assert.throws(()=>parseD1Dump(f.sql+suffix));
 }
});

test('dump layouts and migration records must identify one consistent supported version',async t=>{
 const old=await fixture(t,{through:19,withMigrations:true}),latest=await fixture(t,{through:22,withMigrations:true});
 const addedTable=latest.sql.match(/CREATE TABLE pdf_artifacts[\s\S]*?;\n/)[0];
 const cases=[old.sql+addedTable,old.sql.replaceAll('verification_expires_at','unknown_expiry_column'),old.sql.replace("'0019_security.sql'","'0022_pdf_artifacts.sql'"),latest.sql.replace("'0022_pdf_artifacts.sql'","'0019_security.sql'"),old.sql.replace("'0019_security.sql'","'0023_future.sql'"),old.sql+'INSERT INTO owner(id,unknown_column) VALUES (1,\'x\');',old.sql+'INSERT INTO owner(id) VALUES (1);',old.sql.replace(/CREATE TABLE admin_security[\s\S]*?;\n/,'')];
 for(const sql of cases)assert.throws(()=>parseD1Dump(sql));
 // Removing both v22 tables can otherwise resemble a complete v21 layout;
 // migration metadata must prevent accepting that damaged export as v21.
 const missingArtifacts=latest.sql.replace(/CREATE TABLE pdf_artifacts[\s\S]*?;\n/,'').replace(/CREATE TABLE pdf_artifact_chunks[\s\S]*?;\n/,'');assert.throws(()=>parseD1Dump(missingArtifacts));
 const dir=temp(t),input=join(dir,'mixed.sql'),output=join(dir,'must-not-exist.json');writeFileSync(input,cases[0]);await assert.rejects(exportLocalBackup(input,output));assert.equal(existsSync(output),false);
});
test('dump parser rejects ATTACH, SELECT expressions, unknown identifiers and incomplete schema without executing SQL',async t=>{
 const f=await fixture(t),dir=temp(t),attached=join(dir,'should-never-exist.sqlite');
 for(const suffix of ["ATTACH DATABASE '"+attached.replaceAll("'","''")+"' AS external;","INSERT INTO owner(id) VALUES (abs(1));","SELECT load_extension('fixture');","INSERT INTO unknown_table VALUES ('x');","ALTER TABLE encrypted_items ADD COLUMN untrusted TEXT;","DROP TABLE contacts;"]){assert.throws(()=>parseD1Dump(f.sql+suffix));assert.equal(existsSync(attached),false);}
 assert.throws(()=>parseD1Dump(f.sql.replace(/CREATE TABLE pdf_artifact_chunks[\s\S]*?;\n/,'') ));
 const input=join(dir,'bad.sql'),out=join(dir,'bad.json'),marker=crypto.randomUUID();writeFileSync(input,f.sql+"ATTACH DATABASE '"+marker+"' AS external;");const cli=spawnSync(process.execPath,['scripts/export-backup-local.mjs',input,out],{encoding:'utf8',windowsHide:true});assert.notEqual(cli.status,0);assert.equal((cli.stdout+cli.stderr).includes(marker),false);assert.equal(existsSync(out),false);
});
test('read-only SQLite export preserves the input and can encrypt directly without a plaintext output',async t=>{
 const f=await fixture(t),dir=temp(t),input=join(dir,'input.sql'),canonical=join(dir,'canonical.json'),dbPath=join(dir,'source.sqlite'),out=join(dir,'encrypted.json');writeFileSync(input,f.sql);await exportLocalBackup(input,canonical);await restoreBackup(canonical,dbPath);const before=readFileSync(dbPath);const password='local fixture passphrase';const result=await exportLocalBackup(dbPath,out,{encrypt:true,env:{AFTERME_BACKUP_PASSPHRASE:password}});assert.equal(result.encrypted,true);assert.deepEqual(readFileSync(dbPath),before);assert.equal(JSON.parse(readFileSync(out,'utf8')).format,'afterme-encrypted-backup');const verify=spawnSync(process.execPath,['scripts/verify-backup.mjs',out],{encoding:'utf8',env:{...process.env,AFTERME_BACKUP_PASSPHRASE:password},windowsHide:true});assert.equal(verify.status,0,verify.stderr);
});
