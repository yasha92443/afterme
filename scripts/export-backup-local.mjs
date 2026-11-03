// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Offline only. Dump SQL is parsed as data and is NEVER passed to SQLite.exec().
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,statSync,openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {requiredBackupTables,validateBackupShape} from './restore-backup.mjs';
import {backupCryptoFactory} from '../src/backup-crypto.js';

const cap=256*1024*1024;
const fail=()=>{throw Error('Unsupported or incomplete local backup input');};
const systemColumns={d1_migrations:['id','name','applied_at'],sqlite_sequence:['name','seq'],sqlite_stat1:['tbl','idx','stat'],sqlite_stat4:['tbl','idx','neq','nlt','ndlt','sample'],_cf_KV:['key','value'],_cf_METADATA:['key','value']};
let trusted;
function trustedSchemas(){
  if(trusted)return trusted;
  const db=new DatabaseSync(':memory:'),versions=new Map(),files=readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=24).sort();
  try{
    // Only trusted repository migrations are executed, in an empty memory DB.
    for(const file of files){
      db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
      const version=Number(file.slice(0,4));
      if(version>=16)versions.set(version,Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({name})=>[name,db.prepare('PRAGMA table_info("'+name+'")').all().map(row=>row.name)])));
    }
    trusted={versions,files:new Set(files)};return trusted;
  }finally{db.close();}
}
const sameColumns=(left,right)=>Boolean(left&&right&&left.length===right.length&&left.every((name,i)=>name===right[i]));
function schemaVersion(declarations){
  const candidates=[...trustedSchemas().versions].filter(([version,columns])=>requiredBackupTables(version).every(table=>sameColumns(declarations[table],columns[table]))&&Object.entries(declarations).every(([table,names])=>sameColumns(names,columns[table]||systemColumns[table])));
  if(candidates.length!==1)fail();return candidates[0][0];
}
function checkMigrationVersion(records,version){
  if(!records?.length)return;
  if(records.length>trustedSchemas().files.size)fail();
  const versions=records.map(row=>{if(typeof row.name!=='string'||!trustedSchemas().files.has(row.name))fail();return Number(row.name.slice(0,4));});
  if(Math.max(...versions)!==version||new Set(records.map(row=>row.name)).size!==records.length)fail();
}
// Split statements while retaining SQL literal/identifier quoting. Comments are
// removed only outside quotes. Trigger DDL is skipped later, never executed.
function* statements(text){
  let quote='',comment='',out='';
  for(let i=0;i<text.length;i++){
    const c=text[i],next=text[i+1];
    if(comment==='line'){if(c==='\n'){comment='';out+=' ';}continue;}
    if(comment==='block'){if(c==='*'&&next==='/'){comment='';out+=' ';i++;}continue;}
    if(quote){out+=c;if(c===quote){if(next===quote){out+=next;i++;}else quote='';}continue;}
    if(c==='-'&&next==='-'){comment='line';i++;continue;}
    if(c==='/'&&next==='*'){comment='block';i++;continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;out+=c;continue;}
    if(c===';'){if(out.trim())yield out.trim();out='';}else out+=c;
  }
  if(quote||comment==='block')fail();
  if(out.trim())yield out.trim();
}
function identifier(reader){
  reader.space();let value='';const quote=reader.text[reader.at];
  if(quote==='"'||quote==='`'){reader.at++;for(;;){const c=reader.text[reader.at++];if(c===undefined)fail();if(c===quote){if(reader.text[reader.at]===quote){value+=quote;reader.at++;}else break;}else value+=c;}}
  else{const m=reader.text.slice(reader.at).match(/^[A-Za-z_][A-Za-z0-9_]*/);if(!m)fail();value=m[0];reader.at+=value.length;}
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))fail();return value;
}
function reader(text){return {text,at:0,space(){while(/\s/.test(this.text[this.at]||'')&&this.at<this.text.length)this.at++;},take(char){this.space();if(this.text[this.at]!==char)fail();this.at++;},word(word){this.space();const m=this.text.slice(this.at).match(/^[A-Za-z_]+/);if(!m||m[0].toUpperCase()!==word)fail();this.at+=m[0].length;}};}
function stringLiteral(r){
  r.take("'");let out='';
  for(;;){const c=r.text[r.at++];if(c===undefined)fail();if(c==="'"){if(r.text[r.at]==="'"){out+="'";r.at++;}else return out;}else out+=c;}
}
function newlineLiteral(r,depth=1){
  if(depth>4)fail();r.word('REPLACE');r.take('(');r.space();
  // D1 wraps newline-containing strings in replace(..., marker, char(10/13)).
  // This finite grammar decodes the supported literal SQL data expressions.
  const source=r.text[r.at]==="'"?stringLiteral(r):newlineLiteral(r,depth+1);
  r.take(',');const marker=stringLiteral(r);r.take(',');r.word('CHAR');r.take('(');r.space();
  const code=r.text.slice(r.at).match(/^(?:10|13)(?!\d)/);if(!code)fail();r.at+=code[0].length;r.take(')');r.take(')');
  // SQLite replace(X,'',Y) leaves X unchanged; JS replaceAll differs here.
  return marker?source.split(marker).join(String.fromCharCode(Number(code[0]))):source;
}
function literal(r){
  r.space();if(r.text[r.at]==="'")return stringLiteral(r);
  if(/^REPLACE\b/i.test(r.text.slice(r.at)))return newlineLiteral(r);
  const tail=r.text.slice(r.at),nullValue=tail.match(/^NULL\b/i);if(nullValue){r.at+=nullValue[0].length;return null;}
  const number=tail.match(/^-?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/);if(!number)fail();r.at+=number[0].length;const value=Number(number[0]);if(!Number.isFinite(value)||(!number[0].match(/[.eE]/)&&!Number.isSafeInteger(value)))fail();return value;
}
function createTable(text){
  const r=reader(text);r.word('CREATE');r.word('TABLE');r.space();if(/^IF\b/i.test(r.text.slice(r.at))){r.word('IF');r.word('NOT');r.word('EXISTS');}
  const table=identifier(r);r.take('(');const fields=[];let start=r.at,depth=1,quote='';
  function field(end){
    const definition=text.slice(start,end).trim();if(!definition)fail();
    if(!/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(definition))fields.push(identifier(reader(definition)));
  }
  for(;r.at<text.length;r.at++){
    const char=text[r.at],next=text[r.at+1];
    if(quote){if(char===quote){if(next===quote)r.at++;else quote='';}continue;}
    if(char==="'"||char==='"'||char==='`'){quote=char;continue;}
    if(char==='(')depth++;
    if(char===')'){
      depth--;if(depth===0){field(r.at);r.at++;break;}
    }
    if(char===','&&depth===1){field(r.at);start=r.at+1;}
  }
  r.space();if(depth||quote||r.at!==text.length||!fields.length||new Set(fields).size!==fields.length)fail();
  return {table,columns:fields};
}
function insert(text,columns,result){
  const r=reader(text);r.word('INSERT');r.word('INTO');const table=identifier(r),all=columns[table]||(table==='sqlite_sequence'?systemColumns.sqlite_sequence:null);if(!all)fail();r.space();let fields=all;
  if(r.text[r.at]==='('){r.at++;fields=[];do{fields.push(identifier(r));r.space();if(r.text[r.at]!==',')break;r.at++;}while(true);r.take(')');if(fields.length!==all.length||new Set(fields).size!==fields.length||fields.some(f=>!all.includes(f)))fail();}
  r.word('VALUES');
  do{r.take('(');const values=[];do{values.push(literal(r));r.space();if(r.text[r.at]!==',')break;r.at++;}while(true);r.take(')');if(values.length!==fields.length)fail();if(result[table])result[table].push(Object.fromEntries(fields.map((f,i)=>[f,values[i]])));r.space();if(r.text[r.at]!==',')break;r.at++;}while(true);
  r.space();if(r.at!==r.text.length)fail();
}
function* dumpStatements(text){
  let trigger=false;
  for(const statement of statements(text)){
    if(trigger){if(/^END\s*$/i.test(statement))trigger=false;continue;}
    if(/^CREATE\s+TRIGGER\b/i.test(statement)){trigger=!/\bEND\s*$/i.test(statement);continue;}
    if(/^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|PRAGMA)\b/i.test(statement)||/^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|END\s+TRANSACTION)\s*$/i.test(statement)||/^DELETE\s+FROM\s+["`]?sqlite_sequence["`]?\s*$/i.test(statement))continue;
    if(/^(?:INSERT\b|CREATE\s+TABLE\b)/i.test(statement)){yield statement;continue;}
    fail();
  }
  if(trigger)fail();
}
export function parseD1Dump(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>cap)fail();
  const declarations=Object.create(null);
  // First identify an exact supported layout. Dump DDL contributes names only;
  // defaults, types, constraints and triggers never reach a SQL execution API.
  for(const statement of dumpStatements(text))if(/^CREATE\s+TABLE\b/i.test(statement)){
    const {table,columns}=createTable(statement);if(Object.hasOwn(declarations,table))fail();declarations[table]=columns;
  }
  const version=schemaVersion(declarations),rows=Object.fromEntries([...requiredBackupTables(version),...(declarations.d1_migrations?['d1_migrations']:[])].map(table=>[table,[]]));
  for(const statement of dumpStatements(text))if(/^INSERT\b/i.test(statement))insert(statement,declarations,rows);
  checkMigrationVersion(rows.d1_migrations,version);delete rows.d1_migrations;
  const snapshot={schema_version:version,recovery_tables:rows};validateBackupShape({...snapshot,includes_payloads:true});return snapshot;
}
function sqliteSnapshot(path){
  const db=new DatabaseSync(path,{readOnly:true});let transaction=false;
  try{
    db.exec('BEGIN');transaction=true;
    const declarations=Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({name})=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))fail();return [name,db.prepare('PRAGMA table_info("'+name+'")').all().map(r=>r.name)];}));
    const version=schemaVersion(declarations),required=requiredBackupTables(version);if(declarations.d1_migrations)checkMigrationVersion(db.prepare('SELECT name FROM d1_migrations').all(),version);
    let estimate=0;const rows={};for(const table of required){const names=declarations[table],expression=names.map(n=>'COALESCE(length(CAST("'+n+'" AS BLOB)),0)').join('+');estimate+=Number(db.prepare('SELECT COALESCE(SUM('+expression+'),0) AS bytes FROM '+table).get().bytes);if(estimate>cap)fail();rows[table]=db.prepare('SELECT * FROM '+table).all();}
    return {schema_version:version,recovery_tables:rows};
  }finally{try{if(transaction)db.exec('ROLLBACK');}finally{db.close();}}
}
export async function exportLocalBackup(input,output,{encrypt=false,env=process.env}={}){
  if(!input||!output||resolve(input)===resolve(output))fail();
  const sql=/\.(?:sql|txt)$/i.test(input);if(sql&&statSync(input).size>cap)fail();
  const source=sql?parseD1Dump(readFileSync(input,'utf8')):sqliteSnapshot(resolve(input));
  const recovery_tables=Object.fromEntries(Object.entries(source.recovery_tables).map(([name,rows])=>[name,rows.map(({token_hash,verification_thread_id,vault_token,vault_token_hash,...safe})=>safe)]));
  const backup={format:'afterme-recovery-backup',format_version:2,...source,recovery_tables,exported_at:new Date().toISOString(),includes_payloads:true};validateBackupShape(backup);
  let value=backup,raw=JSON.stringify(backup);if(Buffer.byteLength(raw)>cap)fail();if(encrypt){value=await backupCryptoFactory().encrypt(backup,env.AFTERME_BACKUP_PASSPHRASE);raw=JSON.stringify(value);}
  const fd=openSync(resolve(output),'wx',0o600);try{writeFileSync(fd,raw);closeSync(fd);}catch(error){closeSync(fd);unlinkSync(resolve(output));throw error;}
  return {ok:true,schema_version:backup.schema_version,format_version:2,encrypted:encrypt,bytes:Buffer.byteLength(raw),network_used:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const args=process.argv.slice(2),encrypt=args.includes('--encrypt'),paths=args.filter(a=>a!=='--encrypt');if(paths.length!==2)fail();console.log(JSON.stringify(await exportLocalBackup(paths[0],paths[1],{encrypt})));}catch{console.error('Local backup export failed: unsupported, incomplete or oversized input, incorrect key, or existing output. Dump SQL is never executed.');process.exitCode=1;}}
