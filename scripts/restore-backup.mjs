// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Offline recovery: no Cloudflare connection, mail provider, or imported sessions.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,openSync,closeSync,unlinkSync,statSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openStoredPayload,storedPayloadMode} from '../src/content.js';
import {backupCryptoFactory} from '../src/backup-crypto.js';
import {validatePreferences,validateRules,DEFAULT_PREFERENCES} from '../src/settings.js';
import {Repository} from '../src/repository.js';
import {readArtifactBytes,pdfDigest} from '../src/pdf-artifacts.js';
import {base64ToBytes} from '../src/pdf.js';
import {ensurePeopleLinks} from '../src/people.js';
import {verifiedValidationManifest,PDF_MANIFEST_ALGORITHM} from '../src/pdf-validation.js';

const baseTables=['owner','contacts','recipients','encrypted_items','public_farewell','public_farewell_items','public_farewell_groups_v2','public_farewell_entries_v2','legal_will','mail_templates','document_artifacts','delivery_log','mail_claims'];
export function requiredBackupTables(version){
  const tables=[...baseTables];
  if(version>=17)tables.push('private_delivery_state');
  if(version>=18)tables.push('user_settings','round_rules','release_progress','confirmation_votes');
  if(version>=19)tables.push('admin_security','admin_recovery_codes');
  if(version>=21)tables.push('farewell_document_versions');
  if(version>=22)tables.push('pdf_artifacts','pdf_artifact_chunks');
  if(version>=23)tables.push('people_links');
  if(version>=24)tables.push('background_jobs');
  return tables;
}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function validDate(value){return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function positive(value){return Number.isSafeInteger(value)&&value>0;}
function nonnegative(value){return Number.isSafeInteger(value)&&value>=0;}
export function validateBackupShape(backup){
  if(!object(backup)||!Number.isInteger(backup.schema_version)||backup.schema_version<16||backup.schema_version>24||backup.includes_payloads!==true||!object(backup.recovery_tables))throw Error('需要 schema 16–24 且包含 recovery_tables 的完整备份；资料导出不能恢复。');
  if(backup.format_version!==undefined&&backup.format_version!==2)throw Error('不支持的恢复备份格式。');
  const tables=requiredBackupTables(backup.schema_version),rows=backup.recovery_tables;
  for(const table of tables)if(!Object.hasOwn(rows,table)||!Array.isArray(rows[table])||rows[table].some(row=>!object(row)||Object.values(row).some(value=>value!==null&&!['string','number'].includes(typeof value))))throw Error('备份缺少有效数据表：'+table);
  for(const table of ['owner',...(backup.schema_version>=18?['user_settings']:[]),...(backup.schema_version>=19?['admin_security']:[]),...(backup.schema_version>=21?['farewell_document_versions']:[])])if(rows[table].length!==1||rows[table][0].id!==1)throw Error('备份缺少唯一配置记录：'+table);
  for(const table of ['public_farewell','legal_will'])if(rows[table].length>1||rows[table].some(row=>row.id!==1))throw Error('备份配置记录无效：'+table);
  const owner=rows.owner[0];
  if(!validDate(owner.last_checkin_at)||!positive(owner.confirmation_round)||typeof owner.display_name!=='string'||typeof owner.email!=='string'||!owner.display_name.trim()||!owner.email.trim())throw Error('备份本人记录无效。');
  const contactIds=new Set(rows.contacts.map(row=>row.id)),recipientIds=new Set(rows.recipients.map(row=>row.id));
  const rules=value=>{const r=validateRules(JSON.parse(value));if(['private','public'].some(k=>r[k].contact_ids.some(id=>!contactIds.has(id)))||r.public.audience.some(key=>{const [type,id]=key.split(':');return !(type==='contact'?contactIds:recipientIds).has(Number(id));}))throw Error();return r;};
  if(backup.schema_version>=18){
    const settings=rows.user_settings[0];
    try{
      validatePreferences({...DEFAULT_PREFERENCES,...JSON.parse(settings.preferences_json)},Number.MAX_SAFE_INTEGER);
      if(!nonnegative(settings.revision)||![0,1].includes(settings.configured))throw Error();
      rules(settings.active_rules_json);
      if(settings.pending_rules_json!==null&&settings.pending_rules_json!==undefined)rules(settings.pending_rules_json);
      for(const round of rows.round_rules){if(!positive(round.round)||!validDate(round.anchor_at))throw Error();rules(round.rules_json);}
    }catch{throw Error('备份设置或轮次规则无效。');}
    const current=rows.round_rules.filter(row=>row.round===owner.confirmation_round);
    if(current.length!==1||!['private','public'].every(channel=>rows.release_progress.filter(row=>row.round===owner.confirmation_round&&row.channel===channel).length===1))throw Error('备份缺少当前轮次规则或通道状态。');
  }
  if(backup.schema_version>=19){const state=rows.admin_security[0];if(![0,1].includes(state.enabled)||!Number.isSafeInteger(state.revision)||state.revision<0)throw Error('备份 MFA 状态无效。');}
  if(backup.schema_version>=21){
    const state=rows.farewell_document_versions[0];
    if(!nonnegative(state.draft_revision)||!nonnegative(state.formal_revision)||!nonnegative(state.pending_count))throw Error('备份文档版本无效。');
    let pending=0;
    for(const [table,fields] of [['public_farewell_groups_v2',['title','epigraph','sort_order','is_deleted']],['public_farewell_entries_v2',['body','group_id','is_public','sort_order','is_deleted']]]){
      for(const row of rows[table]){
        if(!Object.hasOwn(row,'is_committed')||fields.some(key=>!Object.hasOwn(row,key)||!Object.hasOwn(row,'draft_'+key)))throw Error('备份文档状态不完整。');
        if(Number(row.is_committed)===0||fields.some(key=>String(row[key])!==String(row['draft_'+key])))pending++;
      }
    }
    if(state.pending_count!==pending)throw Error('备份待处理计数与文档不一致。');
  }
  if(backup.schema_version>=23){
    const contacts=new Map(rows.contacts.map(row=>[row.id,row])),recipients=new Map(rows.recipients.map(row=>[row.id,row])),linkedContacts=new Set(),linkedRecipients=new Set();
    for(const link of rows.people_links){
      if(!positive(link.contact_id)||!positive(link.recipient_id)||!nonnegative(link.revision)||![0,1].includes(link.legacy_contact)||!Object.hasOwn(link,'write_token')||(link.write_token!==null&&typeof link.write_token!=='string')||!contacts.has(link.contact_id)||!recipients.has(link.recipient_id)||linkedContacts.has(link.contact_id)||linkedRecipients.has(link.recipient_id))throw Error('备份人员映射无效。');
      const contact=contacts.get(link.contact_id),recipient=recipients.get(link.recipient_id);
      if(typeof contact.email!=='string'||typeof recipient.email!=='string'||contact.email.trim().toLowerCase()!==recipient.email.trim().toLowerCase())throw Error('备份人员映射邮箱不一致。');
      linkedContacts.add(link.contact_id);linkedRecipients.add(link.recipient_id);
    }
    if(linkedContacts.size!==contacts.size||linkedRecipients.size!==recipients.size)throw Error('备份人员目录不完整。');
  }
  if(backup.schema_version>=24){
    const ids=new Set(),keys=new Set();
    for(const job of rows.background_jobs){
      if(typeof job.id!=='string'||!job.id||typeof job.job_key!=='string'||!job.job_key||(job.dedupe_key!==null&&typeof job.dedupe_key!=='string')||typeof job.kind!=='string'||!job.kind||ids.has(job.id)||keys.has(job.job_key)||!['pending','running','completed','cancelled','failed','uncertain'].includes(job.state)||(job.confirmation_round!==null&&!positive(job.confirmation_round))||storedPayloadMode(job.payload)!=='link'||(job.checkpoint!==null&&storedPayloadMode(job.checkpoint)!=='link')||![job.next_attempt_at,job.created_at,job.updated_at].every(validDate))throw Error('备份后台任务无效。');
      ids.add(job.id);keys.add(job.job_key);
    }
    for(const artifact of rows.pdf_artifacts){
      if(!Object.hasOwn(artifact,'validation_state')||![null,'validating','verified'].includes(artifact.validation_state)||!nonnegative(artifact.validation_cursor)||!nonnegative(artifact.validation_bytes))throw Error('备份 PDF 验证状态无效。');
      if(artifact.validation_state!==null&&(artifact.validation_algorithm!==PDF_MANIFEST_ALGORITHM||typeof artifact.validation_manifest!=='string'||typeof artifact.validation_mac!=='string'||typeof artifact.manifest_sha256!=='string'))throw Error('备份缺少 PDF 认证清单。');
    }
  }
  return tables;
}
function adapter(sqlite){return {
  prepare(query){const statement=sqlite.prepare(query);let values=[];return {bind(...args){values=args;return this;},async first(){return statement.get(...values)||null;},async all(){return {results:statement.all(...values)};},run(){if(/^\s*SELECT/i.test(query))return {results:statement.all(...values)};const result=statement.run(...values);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};},
  async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>s.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}
};}
export async function restoreBackup(input,output,env=process.env){
  if(!input||!output)throw Error('Usage: node scripts/restore-backup.mjs backup.json NEW-recovery.sqlite');
  const inputSize=statSync(resolve(input)).size;if(inputSize>360*1024*1024)throw Error('备份文件过大。');
  let backup=JSON.parse(readFileSync(resolve(input),'utf8'));
  if(backup.format==='afterme-encrypted-backup')backup=await backupCryptoFactory().decrypt(backup,env.AFTERME_BACKUP_PASSPHRASE);
  else if(inputSize>256*1024*1024)throw Error('备份文件过大。');
  const tables=validateBackupShape(backup);let decrypted=0;
  for(const state of backup.recovery_tables.admin_security||[]){
    if(!state.enabled)continue;
    if(storedPayloadMode(state.secret_payload)!=='link')throw Error('MFA 密钥格式不正确。');
    const opened=await openStoredPayload(state.secret_payload,env);if(!/^[A-Z2-7]{32}$/.test(opened.plaintext||''))throw Error('MFA 密钥格式不正确。');decrypted++;
  }
  for(const row of backup.recovery_tables.encrypted_items){
    for(const payload of [row.encrypted_payload,row.pdf_payload].filter(Boolean)){if(storedPayloadMode(payload)!=='link')continue;await openStoredPayload(payload,env);decrypted++;}
  }
  for(const artifact of backup.recovery_tables.pdf_artifacts||[]){
    if(artifact.validation_state)await verifiedValidationManifest(env,artifact,{complete:artifact.status==='ready'});
  }
  const target=resolve(output);closeSync(openSync(target,'wx',0o600));const sqlite=new DatabaseSync(target);
  try{
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    sqlite.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for(const table of tables)sqlite.exec('DELETE FROM '+table);
    const now=new Date().toISOString();
    for(const table of tables){
      // Every job is derived from a prior round. Never restore its lease, remote
      // upload capability or uncertain provider checkpoint into a new instance.
      // Canonical mail_claims/delivery_log remain available for reconciliation.
      if(table==='background_jobs')continue;
      const columns=new Set(sqlite.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));
      for(const original of backup.recovery_tables[table]){
        const row={...original};
        if(table==='owner')Object.assign(row,{state:'NORMAL',release_suspended:1,release_ready_at:null,timer_anchor_at:now,pause_mode:null,pause_until:null,confirmation_round:row.confirmation_round+1});
        if(table==='contacts')Object.assign(row,{token_hash:crypto.randomUUID(),verification_round:null,verification_thread_id:null});
        if(table==='admin_security')Object.assign(row,{pending_payload:null,pending_expires:null,revision:row.revision+1});
        if(table==='encrypted_items')Object.assign(row,{vault_token:crypto.randomUUID(),vault_token_hash:crypto.randomUUID(),released_at:null});
        if(table==='public_farewell')Object.assign(row,{status:'DRAFT',auto_released_at:null});
        if(table==='people_links')row.write_token=null;
        if(table==='pdf_artifacts'&&row.validation_state==='validating')Object.assign(row,{status:'pending',validation_state:null,validation_cursor:0,validation_upload_revision:null,validation_manifest:null,validation_algorithm:null,validation_bytes:0,validation_mac:null,manifest_sha256:null});
        const fields=Object.keys(row);if(fields.some(field=>!columns.has(field)))throw Error('Unknown column in '+table);
        sqlite.prepare('INSERT INTO '+table+' ('+fields.map(f=>'"'+f+'"').join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')').run(...fields.map(f=>row[f]));
      }
    }
    if(sqlite.prepare('PRAGMA foreign_key_check').all().length)throw Error('恢复文件的引用关系不完整。');
    sqlite.exec('COMMIT; PRAGMA foreign_keys=ON');
    const restoredCap=Math.max(20,Number(JSON.parse(backup.recovery_tables.user_settings?.[0]?.preferences_json||'{}').daily_email_limit||20));
    const db=adapter(sqlite);
    if(backup.schema_version<23)await ensurePeopleLinks(db);
    const invalidPeople=sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM contacts c LEFT JOIN people_links p ON p.contact_id=c.id WHERE p.contact_id IS NULL)
      +(SELECT COUNT(*) FROM recipients r LEFT JOIN people_links p ON p.recipient_id=r.id WHERE p.recipient_id IS NULL)
      +(SELECT COUNT(*) FROM people_links p LEFT JOIN contacts c ON c.id=p.contact_id LEFT JOIN recipients r ON r.id=p.recipient_id WHERE c.id IS NULL OR r.id IS NULL OR lower(trim(c.email))<>lower(trim(r.email))) AS count`).get().count;
    if(invalidPeople)throw Error('恢复后的人员目录不完整。');
    const repo=new Repository(db),settings=await repo.getSettings({MAX_DAILY_EMAILS:String(restoredCap)}),owner=await repo.getOwner();
    validatePreferences(settings.preferences,Number.MAX_SAFE_INTEGER);validateRules(await repo.getRoundRules(owner));
    if((await repo.getProgress(owner.confirmation_round)).length!==2||owner.state!=='NORMAL'||owner.release_suspended!==1)throw Error('恢复后的应用状态检查失败。');
    await repo.directory({limit:1});await repo.farewell.listFormalGroups();
    if(backup.schema_version>=22){
      const artifacts=new Map(backup.recovery_tables.pdf_artifacts.map(row=>[row.id,row]));
      for(const chunk of backup.recovery_tables.pdf_artifact_chunks){
        const artifact=artifacts.get(chunk.artifact_id);if(!artifact)throw Error('PDF chunk has no artifact');
        let encoded=chunk.payload;
        if(artifact.kind==='private'){const opened=await openStoredPayload(encoded,env);if(opened.mode!=='link')throw Error('PDF chunk is not encrypted');encoded=opened.plaintext;decrypted++;}
        const bytes=base64ToBytes(encoded);if(bytes.length!==chunk.byte_length||await pdfDigest(bytes)!==chunk.sha256)throw Error('PDF chunk integrity failed');
      }
      for(const artifact of backup.recovery_tables.pdf_artifacts){
        if(artifact.kind==='private'&&!backup.recovery_tables.encrypted_items.some(item=>item.id===artifact.item_id))throw Error('PDF artifact item is missing');
        if(artifact.status==='ready')await readArtifactBytes(repo,env,artifact);
      }
    }
    if(sqlite.prepare('PRAGMA foreign_key_check').all().length||sqlite.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('恢复后的数据库完整性检查失败。');
    const result={ok:true,output:target,schema_restored:true,schema_version:backup.schema_version,application_smoke_verified:true,verified_encrypted_payloads:decrypted,release_suspended:true,network_used:false};sqlite.close();return result;
  }catch(error){sqlite.close();for(const file of [target,target+'-wal',target+'-shm'])if(existsSync(file))unlinkSync(file);throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await restoreBackup(...process.argv.slice(2))));}catch{console.error('Backup recovery failed: invalid, incomplete, modified backup or incorrect recovery key. No recovery file was retained.');process.exitCode=1;}}
