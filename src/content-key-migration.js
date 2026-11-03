// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {buildStoredPayload,openStoredPayload,storedPayloadMode,keyFingerprint} from './content.js';
import {verifiedValidationManifest,authenticateValidationManifest} from './pdf-validation.js';

// A bounded page can safely be retried. CAS prevents a migration from replacing
// a newer letter or an enrollment started while decryption was in progress.
export async function migrateContentKeys(repo,env,{cursor=0,artifact_cursor=0,job_cursor=0,manifest_cursor=0,limit=25}={}) {
  if(!env.CONTENT_ENCRYPTION_KEY)throw Object.assign(Error('独立内容密钥尚未配置'),{status:409});
  if([cursor,artifact_cursor,job_cursor,manifest_cursor].some(value=>!Number.isSafeInteger(value)||value<0)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(Error('Invalid migration pagination'),{status:400});
  const fingerprint=await keyFingerprint(env.CONTENT_ENCRYPTION_KEY),result={ok:true,fingerprint,migrated:0,verified:0,conflicts:0,cursor,artifact_cursor,job_cursor,manifest_cursor,has_more:false};
  let remaining=limit;
  const finish=hasMore=>{result.has_more=hasMore;result.ok=result.conflicts===0;return result;};
  async function replacement(payload) {
    if(!payload||storedPayloadMode(payload)!=='link')return payload;
    const opened=await openStoredPayload(payload,env);
    result.verified++;
    if(JSON.parse(payload).key_id===fingerprint)return payload;
    const sealed=await buildStoredPayload({body:{plaintext:opened.plaintext},env});
    const check=await openStoredPayload(sealed,{CONTENT_ENCRYPTION_KEY:env.CONTENT_ENCRYPTION_KEY});
    if(check.plaintext!==opened.plaintext)throw Error('密钥迁移校验失败');
    return sealed;
  }
  const state=await repo.db.prepare('SELECT * FROM admin_security WHERE id=1').first();
  if(state) {
    const secret=await replacement(state.secret_payload),pending=await replacement(state.pending_payload);
    if(secret!==state.secret_payload||pending!==state.pending_payload) {
      const saved=await repo.db.prepare('UPDATE admin_security SET secret_payload=?,pending_payload=? WHERE id=1 AND revision=? AND secret_payload IS ? AND pending_payload IS ?').bind(secret,pending,state.revision,state.secret_payload,state.pending_payload).run();
      if(saved.meta?.changes)result.migrated++;else result.conflicts++;
    }
  }
  const itemLimit=remaining,items=(await repo.db.prepare('SELECT id,encrypted_payload,pdf_payload FROM encrypted_items WHERE id>? ORDER BY id LIMIT ?').bind(cursor,itemLimit+1).all()).results;
  for(const item of items.slice(0,itemLimit)) {
    const payload=await replacement(item.encrypted_payload),pdf=await replacement(item.pdf_payload);
    if(payload!==item.encrypted_payload||pdf!==item.pdf_payload) {
      const saved=await repo.db.prepare('UPDATE encrypted_items SET encrypted_payload=?,pdf_payload=? WHERE id=? AND encrypted_payload=? AND pdf_payload IS ?').bind(payload,pdf,item.id,item.encrypted_payload,item.pdf_payload).run();
      if(saved.meta?.changes)result.migrated++;else result.conflicts++;
    }
    result.cursor=item.id;
    remaining--;
  }
  if(items.length>itemLimit||remaining===0)return finish(true);
  const chunkLimit=remaining,chunks=(await repo.db.prepare("SELECT c.rowid AS migration_cursor,c.artifact_id,c.chunk_index,c.payload FROM pdf_artifact_chunks c JOIN pdf_artifacts a ON a.id=c.artifact_id WHERE a.kind='private' AND c.rowid>? ORDER BY c.rowid LIMIT ?").bind(artifact_cursor,chunkLimit+1).all()).results;
  for(const chunk of chunks.slice(0,chunkLimit)) {
    const payload=await replacement(chunk.payload);
    if(payload!==chunk.payload){const saved=await repo.db.prepare('UPDATE pdf_artifact_chunks SET payload=? WHERE artifact_id=? AND chunk_index=? AND payload=?').bind(payload,chunk.artifact_id,chunk.chunk_index,chunk.payload).run();if(saved.meta?.changes)result.migrated++;else result.conflicts++;}
    result.artifact_cursor=chunk.migration_cursor;
    remaining--;
  }
  if(chunks.length>chunkLimit)return finish(true);
  const supportsJobs=await repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_jobs'").first();
  let jobs=[],manifests=[];
  if(supportsJobs){
    if(remaining===0)return finish(true);
    const jobLimit=remaining;
    jobs=(await repo.db.prepare('SELECT rowid AS migration_cursor,id,payload,checkpoint FROM background_jobs WHERE rowid>? ORDER BY rowid LIMIT ?').bind(job_cursor,jobLimit+1).all()).results;
    for(const job of jobs.slice(0,jobLimit)){
      if(storedPayloadMode(job.payload)!=='link'||(job.checkpoint&&storedPayloadMode(job.checkpoint)!=='link'))throw Error('后台任务密文格式不正确');
      const payload=await replacement(job.payload),checkpoint=await replacement(job.checkpoint);
      if(payload!==job.payload||checkpoint!==job.checkpoint){const saved=await repo.db.prepare('UPDATE background_jobs SET payload=?,checkpoint=? WHERE id=? AND payload=? AND checkpoint IS ?').bind(payload,checkpoint,job.id,job.payload,job.checkpoint).run();if(saved.meta?.changes)result.migrated++;else result.conflicts++;}
      result.job_cursor=job.migration_cursor;
      remaining--;
    }
    if(jobs.length>jobLimit||remaining===0)return finish(true);
    const manifestLimit=remaining;
    manifests=(await repo.db.prepare('SELECT rowid AS migration_cursor,* FROM pdf_artifacts WHERE rowid>? AND validation_state IS NOT NULL ORDER BY rowid LIMIT ?').bind(manifest_cursor,manifestLimit+1).all()).results;
    const currentEnv={...env,LEGACY_CONTENT_ENCRYPTION_KEY:undefined};
    for(const row of manifests.slice(0,manifestLimit)){
      const manifest=await verifiedValidationManifest(env,row,{complete:row.status==='ready'});result.verified++;
      const replacementManifest={...manifest};
      if(row.kind==='private'&&manifest.ending)replacementManifest.ending=await replacement(manifest.ending);
      const authenticated=await authenticateValidationManifest(currentEnv,replacementManifest),candidate={...row,validation_manifest:authenticated.text,validation_mac:authenticated.mac,manifest_sha256:authenticated.sha256};
      await verifiedValidationManifest(currentEnv,candidate,{complete:row.status==='ready'});
      if(authenticated.text!==row.validation_manifest||authenticated.mac!==row.validation_mac||authenticated.sha256!==row.manifest_sha256){
        const saved=await repo.db.prepare('UPDATE pdf_artifacts SET validation_manifest=?,validation_mac=?,manifest_sha256=? WHERE id=? AND validation_manifest IS ? AND validation_mac IS ? AND manifest_sha256 IS ? AND upload_revision=? AND validation_upload_revision IS ? AND validation_cursor=? AND status=? AND source_revision=? AND layout_key=?').bind(authenticated.text,authenticated.mac,authenticated.sha256,row.id,row.validation_manifest,row.validation_mac,row.manifest_sha256,row.upload_revision,row.validation_upload_revision,row.validation_cursor,row.status,row.source_revision,row.layout_key).run();if(saved.meta?.changes)result.migrated++;else result.conflicts++;
      }
      result.manifest_cursor=row.migration_cursor;
      remaining--;
    }
    if(manifests.length>manifestLimit)return finish(true);
  }
  return finish(false);
}
