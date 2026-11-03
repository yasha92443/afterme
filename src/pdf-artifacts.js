// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {buildStoredPayload,openStoredPayload,storedPayloadMode} from './content.js';
import {base64ToBytes,isInvocationBudgetError} from './invocation-budget.js';
import {pdfLayoutKey} from './pdf-layout.js';
import {Buffer} from 'node:buffer';
import {PDF_CHUNK_BYTES,artifactChunkBytes,DEFAULT_MAX_PDF_BYTES,HARD_MAX_PDF_BYTES,PDF_MANIFEST_ALGORITHM,pdfByteLimit,initialValidationManifest,authenticateValidationManifest,verifiedValidationManifest,validatedPdfChunk,appendValidationPart} from './pdf-validation.js';

export {PDF_CHUNK_BYTES,pdfByteLimit,artifactChunkBytes};
export const MAX_PDF_BYTES=DEFAULT_MAX_PDF_BYTES;
export const MAX_PDF_SOURCE_BYTES=4*1024*1024;
export const PDF_SOURCE_PAGE_BYTES=64*1024;
const error=(status,message)=>Object.assign(new Error(message),{status});
export async function pdfDigest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function validPdf(bytes){return bytes instanceof Uint8Array&&bytes.length>=16&&new TextDecoder().decode(bytes.subarray(0,8)).startsWith('%PDF-1.')&&new TextDecoder().decode(bytes.subarray(-1024)).includes('%%EOF');}

export async function artifactContext(repo,env,{kind,id=0,locale,metadataOnly=false}={}) {
  if(!['private','public'].includes(kind))throw error(400,'Invalid PDF kind');
  id=Number(id);if(!Number.isSafeInteger(id)||id<0||(kind==='private'&&id===0))throw error(400,'Invalid PDF item');
  const [owner,settings]=await Promise.all([repo.getOwner(),repo.getSettings(env)]);
  const options={locale:locale||settings.preferences.locale,timezone:settings.preferences.timezone,style:settings.preferences.pdf_style};
  if(!['zh','en','ru'].includes(options.locale))throw error(400,'Invalid PDF language');
  let item,document,sourceRevision;
  if(kind==='private'){
    item=metadataOnly?await repo.db.prepare(`SELECT i.id,i.kind,i.revision,i.delivery_version,i.updated_at,i.created_at,
      COALESCE(r.name,c.name) AS recipient_name,COALESCE(r.email,c.email) AS recipient_email,COALESCE(r.locale,c.locale,'zh') AS recipient_locale,
      CASE WHEN json_valid(i.encrypted_payload) AND json_extract(i.encrypted_payload,'$.v')=2 THEN json_extract(i.encrypted_payload,'$.mode') ELSE 'passphrase' END AS access_mode
      FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id WHERE i.id=?`).bind(id).first():await repo.getEncryptedItemForAdmin(id);
    if(!item)throw error(404,'Private letter not found');
    if((metadataOnly?item.access_mode:storedPayloadMode(item.encrypted_payload))!=='link')throw error(409,'Passphrase letters require manual delivery');
    options.locale=item.recipient_locale||'zh';
    sourceRevision=JSON.stringify([item.revision,item.updated_at,item.recipient_name,item.recipient_email]);
  }else{
    id=0;document=metadataOnly?await repo.db.prepare('SELECT id,updated_at,title FROM public_farewell WHERE id=1').first():await repo.getPublicFarewell();
    const versions=repo.farewell.getVersions?await repo.farewell.getVersions():null;
    sourceRevision=JSON.stringify([versions?.formal_revision||0,document?.updated_at||null]);
  }
  return {kind,item_id:id,source_revision:sourceRevision,layout_key:pdfLayoutKey(options,owner?.display_name),locale:options.locale,options,owner,item,document,settings_revision:settings.revision};
}

export async function findReadyArtifact(repo,context) {
  if(!repo.db)return null;
  return repo.db.prepare("SELECT * FROM pdf_artifacts WHERE kind=? AND item_id=? AND source_revision=? AND layout_key=? AND locale=? AND status='ready' ORDER BY updated_at DESC,id DESC LIMIT 1")
    .bind(context.kind,context.item_id,context.source_revision,context.layout_key,context.locale).first();
}
function currentSourceGuard(context){
  const source=context.kind==='private'?`EXISTS(SELECT 1 FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id WHERE i.id=? AND json_array(i.revision,i.updated_at,COALESCE(r.name,c.name),COALESCE(r.email,c.email))=? AND COALESCE(r.locale,c.locale,'zh')=?)`:`EXISTS(SELECT 1 FROM farewell_document_versions v LEFT JOIN public_farewell d ON d.id=1 WHERE v.id=1 AND json_array(v.formal_revision,d.updated_at)=?)`;
  const args=context.kind==='private'?[context.item_id,context.source_revision,context.locale]:[context.source_revision];
  return {sql:`${source} AND EXISTS(SELECT 1 FROM user_settings WHERE id=1 AND revision=?) AND EXISTS(SELECT 1 FROM owner WHERE id=1 AND display_name IS ?)`,args:[...args,context.settings_revision,context.owner?.display_name]};
}
export {currentSourceGuard as artifactCurrentGuard};
export async function artifactIsCurrent(repo,context){
  const guard=currentSourceGuard(context);return Boolean(await repo.db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.args).first());
}

export async function beginArtifact(repo,env,input) {
  const context=await artifactContext(repo,env,{...input,metadataOnly:env.BACKGROUND_EXECUTION_MODE==='staged'});
  await pruneObsoleteArtifacts(repo,context);
  const ready=await findReadyArtifact(repo,context);
  if(ready)return {ok:true,...publicArtifact(ready),cached:true};
  const pending=await repo.db.prepare("SELECT * FROM pdf_artifacts WHERE kind=? AND item_id=? AND source_revision=? AND layout_key=? AND locale=? AND status='pending' ORDER BY created_at DESC LIMIT 1").bind(context.kind,context.item_id,context.source_revision,context.layout_key,context.locale).first();
  if(pending)return {ok:true,...publicArtifact(pending),max_bytes:pdfByteLimit(env)};
  const now=new Date().toISOString(),id=crypto.randomUUID(),staged=env.BACKGROUND_EXECUTION_MODE==='staged',chunkBytes=artifactChunkBytes({chunk_bytes:staged?Number(env.PDF_ARTIFACT_CHUNK_BYTES||PDF_CHUNK_BYTES):PDF_CHUNK_BYTES});
  await repo.db.prepare(`INSERT INTO pdf_artifacts(id,kind,item_id,source_revision,layout_key,locale,status,created_at,updated_at${staged?',chunk_bytes':''}) VALUES(?,?,?,?,?,?,'pending',?,?${staged?',?':''})`)
    .bind(id,context.kind,context.item_id,context.source_revision,context.layout_key,context.locale,now,now,...(staged?[chunkBytes]:[])).run();
  return {ok:true,id,kind:context.kind,item_id:context.item_id,status:'pending',source_revision:context.source_revision,layout_key:context.layout_key,locale:context.locale,chunk_bytes:chunkBytes,max_bytes:pdfByteLimit(env)};
}

export async function pruneObsoleteArtifacts(repo,context,now=Date.now()) {
  // Keep recent interrupted uploads available, and bound each cleanup transaction.
  // Other languages and the current ready artifact are never removed here.
  return repo.db.prepare(`DELETE FROM pdf_artifacts WHERE id IN (SELECT id FROM pdf_artifacts
    WHERE kind=? AND item_id=? AND locale=? AND updated_at<?
      AND (source_revision<>? OR layout_key<>? OR status<>'ready')
    ORDER BY updated_at,id LIMIT 2)`).bind(context.kind,context.item_id,context.locale,new Date(now-7*86400000).toISOString(),context.source_revision,context.layout_key).run();
}

export function publicArtifact(row){const {id,kind,item_id,source_revision,layout_key,locale,total_bytes,chunk_count,sha256,last_error,validation_cursor,validation_algorithm,manifest_sha256}=row;return {id,kind,item_id,source_revision,layout_key,locale,status:row.status==='pending'&&row.validation_state==='validating'?'validating':row.status,total_bytes,chunk_count,sha256,last_error,validation_cursor,validation_algorithm,manifest_sha256,chunk_bytes:artifactChunkBytes(row)};}
export async function artifactById(repo,id){return repo.db.prepare('SELECT * FROM pdf_artifacts WHERE id=?').bind(id).first();}
async function assertCurrent(repo,env,row) {
  const current=await artifactContext(repo,env,{kind:row.kind,id:row.item_id,locale:row.locale,metadataOnly:true});
  if(current.source_revision!==row.source_revision||current.layout_key!==row.layout_key){
    await repo.db.prepare("UPDATE pdf_artifacts SET status='stale',updated_at=? WHERE id=?").bind(new Date().toISOString(),row.id).run();
    throw error(409,'PDF source or layout changed; prepare the current version');
  }
  return current;
}

export async function uploadArtifactChunk(repo,env,id,index,data) {
  const row=await artifactById(repo,id);if(!row)throw error(404,'PDF upload not found');
  if(row.status!=='pending'||row.validation_state)throw error(409,'PDF upload is not pending');
  const chunkBytes=artifactChunkBytes(row);
  if(!Number.isSafeInteger(index)||index<0||index>=Math.ceil(pdfByteLimit(env)/chunkBytes)||typeof data!=='string'||data.length>Math.ceil(chunkBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw error(400,'Invalid PDF chunk');
  let bytes;try{bytes=base64ToBytes(data);}catch{throw error(400,'Invalid PDF chunk encoding');}
  if(!bytes.length||bytes.length>chunkBytes)throw error(413,'PDF chunk exceeds limit');
  const digest=await pdfDigest(bytes),payload=row.kind==='private'?await buildStoredPayload({body:{plaintext:data},env}):data;
  const writable="status='pending'"+(Object.hasOwn(row,'validation_state')?' AND validation_state IS NULL':'');
  const results=await repo.db.batch([
    repo.db.prepare(`INSERT INTO pdf_artifact_chunks(artifact_id,chunk_index,payload,sha256,byte_length) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pdf_artifacts WHERE id=? AND ${writable}) ON CONFLICT(artifact_id,chunk_index) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,byte_length=excluded.byte_length WHERE EXISTS(SELECT 1 FROM pdf_artifacts WHERE id=? AND ${writable})`).bind(id,index,payload,digest,bytes.length,id,id),
    repo.db.prepare(`UPDATE pdf_artifacts SET upload_revision=upload_revision+1,updated_at=? WHERE id=? AND ${writable}`).bind(new Date().toISOString(),id),
  ]);
  if(!results[0].meta?.changes)throw error(409,'PDF upload changed');
  return {ok:true,index,sha256:digest,bytes:bytes.length};
}

export async function readArtifactBytes(repo,env,row) {
  const chunks=(await repo.db.prepare('SELECT * FROM pdf_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index').bind(row.id).all()).results;
  if(!Number.isSafeInteger(row.total_bytes)||row.total_bytes<16||row.total_bytes>HARD_MAX_PDF_BYTES||chunks.length!==row.chunk_count)throw error(409,'PDF artifact is incomplete');
  const manifest=row.validation_algorithm===PDF_MANIFEST_ALGORITHM?await verifiedValidationManifest(env,row,{complete:true}):null;
  const bytes=new Uint8Array(row.total_bytes);let offset=0;
  for(let i=0;i<chunks.length;i++){
    const chunk=chunks[i];if(chunk.chunk_index!==i)throw error(409,'PDF artifact chunks are incomplete');
    if(manifest){const part=await validatedPdfChunk(env,row,chunk,manifest.parts[i]);bytes.set(part,offset);offset+=part.length;continue;}
    let encoded=chunk.payload;
    if(row.kind==='private'){const opened=await openStoredPayload(encoded,env);if(opened.mode!=='link'||!opened.plaintext)throw error(409,'Invalid encrypted PDF chunk');encoded=opened.plaintext;}
    const part=base64ToBytes(encoded);
    if(part.length!==chunk.byte_length||offset+part.length>bytes.length||await pdfDigest(part)!==chunk.sha256)throw error(409,'PDF artifact chunk was modified');
    bytes.set(part,offset);offset+=part.length;
  }
  if(offset!==bytes.length||!validPdf(bytes)||(!manifest&&await pdfDigest(bytes)!==row.sha256))throw error(409,'PDF artifact validation failed');
  return bytes;
}

// Mail upload steps can authenticate one bounded range without rereading the
// whole PDF. A legacy ready artifact retains its original per-chunk checks.
export async function readValidatedArtifactChunk(repo,env,row,index){
  const chunkBytes=artifactChunkBytes(row);
  if(row.status!=='ready'||!Number.isSafeInteger(index)||index<0||index>=row.chunk_count||!Number.isSafeInteger(row.total_bytes)||row.total_bytes<16||row.total_bytes>HARD_MAX_PDF_BYTES||row.chunk_count!==Math.ceil(row.total_bytes/chunkBytes))throw error(409,'PDF artifact is not ready');
  const manifest=row.validation_algorithm===PDF_MANIFEST_ALGORITHM?await verifiedValidationManifest(env,row,{complete:true}):null;
  const chunk=await repo.db.prepare('SELECT * FROM pdf_artifact_chunks WHERE artifact_id=? AND chunk_index=?').bind(row.id,index).first();
  const expected=manifest?manifest.parts[index]:{index,bytes:Math.min(chunkBytes,row.total_bytes-index*chunkBytes),sha256:chunk?.sha256};
  return validatedPdfChunk(env,row,chunk,expected);
}

// Read only the PDF blocks covering one MIME upload range. The header and blocks
// share a D1 batch snapshot, and the authenticated manifest is checked once.
// Legacy artifacts have 128 KiB blocks; a stored block size can support smaller
// new uploads without changing that interpretation for earlier ready files.
export async function readValidatedArtifactRange(repo,env,reference,start,length){
  if(!reference||typeof reference.artifact_id!=='string'||!Number.isSafeInteger(reference.upload_revision)||reference.upload_revision<0||!(reference.manifest_sha256===null||typeof reference.manifest_sha256==='string'&&/^[a-f0-9]{64}$/.test(reference.manifest_sha256))||reference.chunk_bytes!==undefined&&![16*1024,32*1024,64*1024,128*1024].includes(reference.chunk_bytes)||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<0||length>256*1024||!Number.isSafeInteger(start+length))throw error(400,'Invalid PDF range');
  const batches=await repo.db.batch([
    repo.db.prepare('SELECT * FROM pdf_artifacts WHERE id=?').bind(reference.artifact_id),
    // The first block is full-sized for a multi-block file. A single-block file
    // always selects index zero. This avoids requiring a new column in old DBs.
    repo.db.prepare(`SELECT c.* FROM pdf_artifact_chunks c JOIN pdf_artifact_chunks first ON first.artifact_id=c.artifact_id AND first.chunk_index=0
      WHERE c.artifact_id=? AND ?>0 AND first.byte_length>0
      AND c.chunk_index BETWEEN CAST(? / COALESCE(?,first.byte_length) AS INTEGER) AND CAST((? + ? - 1) / COALESCE(?,first.byte_length) AS INTEGER)
      ORDER BY c.chunk_index LIMIT 18`).bind(reference.artifact_id,length,start,reference.chunk_bytes??null,start,length,reference.chunk_bytes??null),
  ]);
  const row=batches[0]?.results?.[0],chunks=batches[1]?.results||[],chunkBytes=row?.chunk_bytes??128*1024;
  if(!row||row.status!=='ready'||row.upload_revision!==reference.upload_revision||(row.manifest_sha256??null)!==reference.manifest_sha256||![16*1024,32*1024,64*1024,128*1024].includes(chunkBytes)||reference.chunk_bytes!==undefined&&reference.chunk_bytes!==chunkBytes||!Number.isSafeInteger(row.total_bytes)||row.total_bytes<16||row.total_bytes>HARD_MAX_PDF_BYTES||row.chunk_count!==Math.ceil(row.total_bytes/chunkBytes)||start+length>row.total_bytes||(reference.manifest_sha256===null?row.validation_algorithm!=null:row.validation_algorithm!==PDF_MANIFEST_ALGORITHM))throw error(409,'PDF artifact changed or is incomplete');
  const manifest=row.validation_algorithm===PDF_MANIFEST_ALGORITHM?await verifiedValidationManifest(env,row,{complete:true}):null;
  const first=Math.floor(start/chunkBytes),last=length?Math.floor((start+length-1)/chunkBytes):first-1;
  if(chunks.length!==last-first+1)throw error(409,'PDF artifact range is incomplete');
  const result=new Uint8Array(length);
  for(let index=first;index<=last;index++){
    const chunk=chunks[index-first],expected=manifest?manifest.parts[index]:{index,bytes:Math.min(chunkBytes,row.total_bytes-index*chunkBytes),sha256:chunk?.sha256};
    const part=await validatedPdfChunk(env,row,chunk,expected),offset=Math.max(start,index*chunkBytes),end=Math.min(start+length,(index+1)*chunkBytes);
    result.set(part.subarray(offset-index*chunkBytes,end-index*chunkBytes),offset-start);
  }
  return result;
}

export async function completeArtifact(repo,env,id,input) {
  const row=await artifactById(repo,id);if(!row)throw error(404,'PDF upload not found');
  if(row.status==='ready'){await assertCurrent(repo,env,row);return {ok:true,...publicArtifact(row)};}
  if(row.status!=='pending')throw error(409,'PDF upload is not pending');
  const {total_bytes,chunk_count,sha256}=input;
  const chunkBytes=artifactChunkBytes(row);
  if(!Number.isSafeInteger(total_bytes)||total_bytes<16||total_bytes>pdfByteLimit(env)||!Number.isSafeInteger(chunk_count)||chunk_count<1||chunk_count>Math.ceil(pdfByteLimit(env)/chunkBytes)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw error(400,'Invalid PDF manifest');
  if(chunk_count!==Math.ceil(total_bytes/chunkBytes))throw error(400,'Invalid PDF chunk count');
  if(row.validation_state==='validating'){
    await assertCurrent(repo,env,row);if(row.total_bytes!==total_bytes||row.chunk_count!==chunk_count||row.sha256!==sha256)throw error(409,'PDF validation has already started');
    return {ok:true,...publicArtifact(row)};
  }
  if(env.BACKGROUND_EXECUTION_MODE==='staged')return startArtifactValidation(repo,env,row,{total_bytes,chunk_count,sha256});
  await assertCurrent(repo,env,row);
  await readArtifactBytes(repo,env,{...row,total_bytes,chunk_count,sha256});
  // Recheck after asynchronous hashing/decryption, then use source guards in the
  // write itself so a concurrent save cannot publish an obsolete upload.
  const current=await assertCurrent(repo,env,row),now=new Date().toISOString();
  const guard=row.kind==='private'?"EXISTS(SELECT 1 FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id WHERE i.id=? AND i.revision=? AND COALESCE(r.name,c.name) IS ? AND COALESCE(r.email,c.email) IS ? AND COALESCE(r.locale,c.locale,'zh')=?)":"EXISTS(SELECT 1 FROM farewell_document_versions WHERE id=1 AND formal_revision=?)";
  const binds=row.kind==='private'?[row.item_id,current.item.revision,current.item.recipient_name,current.item.recipient_email,current.locale]:[JSON.parse(row.source_revision)[0]];
  const result=await repo.db.prepare(`UPDATE pdf_artifacts SET status='ready',total_bytes=?,chunk_count=?,sha256=?,last_error=NULL,updated_at=? WHERE id=? AND status='pending' AND upload_revision=? AND ${guard} AND EXISTS(SELECT 1 FROM owner WHERE id=1 AND display_name IS ?) AND EXISTS(SELECT 1 FROM user_settings WHERE id=1 AND revision=?)`)
    .bind(total_bytes,chunk_count,sha256,now,id,row.upload_revision,...binds,current.owner?.display_name,current.settings_revision).run();
  if(!result.meta?.changes)throw error(409,'PDF source changed during upload');
  return {ok:true,...publicArtifact({...row,status:'ready',total_bytes,chunk_count,sha256})};
}

async function startArtifactValidation(repo,env,row,input){
  const current=await assertCurrent(repo,env,row),counts=await repo.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes,MIN(chunk_index) AS first,MAX(chunk_index) AS last FROM pdf_artifact_chunks WHERE artifact_id=?').bind(row.id).first();
  if(counts.count!==input.chunk_count||counts.bytes!==input.total_bytes||counts.first!==0||counts.last!==input.chunk_count-1)throw error(409,'PDF artifact is incomplete');
  const frozen={...row,...input},manifest=initialValidationManifest(frozen),auth=await authenticateValidationManifest(env,manifest),guard=currentSourceGuard(current),now=new Date().toISOString();
  const result=await repo.db.prepare(`UPDATE pdf_artifacts SET total_bytes=?,chunk_count=?,sha256=?,validation_state='validating',validation_cursor=0,validation_upload_revision=upload_revision,validation_manifest=?,validation_algorithm=?,validation_bytes=0,validation_mac=?,manifest_sha256=?,last_error=NULL,updated_at=? WHERE id=? AND status='pending' AND validation_state IS NULL AND upload_revision=? AND ${guard.sql}`)
    .bind(input.total_bytes,input.chunk_count,input.sha256,auth.text,PDF_MANIFEST_ALGORITHM,auth.mac,auth.sha256,now,row.id,row.upload_revision,...guard.args).run();
  if(!result.meta?.changes)throw error(409,'PDF source changed during upload');
  return {ok:true,...publicArtifact({...frozen,validation_state:'validating',validation_cursor:0,validation_algorithm:PDF_MANIFEST_ALGORITHM,manifest_sha256:auth.sha256})};
}

function validationResult(row){return {done:row.status!=='pending'||row.validation_state!=='validating',status:publicArtifact(row).status,artifact_id:row.id,cursor:row.validation_cursor||0,total:row.chunk_count};}
export async function runArtifactValidationStep(repo,env,{artifact_id},now=new Date().toISOString()){
  const row=await artifactById(repo,artifact_id);if(!row)return {done:true,status:'missing',artifact_id,cursor:0,total:0};
  if(row.status!=='pending'||row.validation_state!=='validating')return validationResult(row);
  try{
    const current=await assertCurrent(repo,env,row),manifest=await verifiedValidationManifest(env,row);
    if(row.validation_cursor<row.chunk_count){
      const chunk=await repo.db.prepare('SELECT * FROM pdf_artifact_chunks WHERE artifact_id=? AND chunk_index=?').bind(row.id,row.validation_cursor).first();
      const next=await appendValidationPart(env,row,manifest,chunk),auth=await authenticateValidationManifest(env,next),guard=currentSourceGuard(current);
      const result=await repo.db.prepare(`UPDATE pdf_artifacts SET validation_cursor=validation_cursor+1,validation_bytes=validation_bytes+?,validation_manifest=?,validation_mac=?,manifest_sha256=?,updated_at=? WHERE id=? AND status='pending' AND validation_state='validating' AND validation_cursor=? AND upload_revision=? AND validation_upload_revision=? AND validation_manifest=? AND ${guard.sql}`)
        .bind(next.parts.at(-1).bytes,auth.text,auth.mac,auth.sha256,now,row.id,row.validation_cursor,row.upload_revision,row.upload_revision,row.validation_manifest,...guard.args).run();
      if(result.meta?.changes)return validationResult({...row,validation_cursor:row.validation_cursor+1});
    }else{
      if(!manifest.header_valid||!manifest.eof_valid||row.validation_bytes!==row.total_bytes)throw error(409,'PDF artifact validation failed');
      const guard=currentSourceGuard(current),result=await repo.db.prepare(`UPDATE pdf_artifacts SET status='ready',validation_state='verified',last_error=NULL,updated_at=? WHERE id=? AND status='pending' AND validation_state='validating' AND validation_cursor=chunk_count AND validation_bytes=total_bytes AND upload_revision=? AND validation_upload_revision=? AND validation_manifest=? AND ${guard.sql}`)
        .bind(now,row.id,row.upload_revision,row.upload_revision,row.validation_manifest,...guard.args).run();
      if(result.meta?.changes)return validationResult({...row,status:'ready',validation_state:'verified'});
    }
    // Another step or a source save won the compare-and-swap. No chunk is
    // counted twice, and a later invocation can resume the durable cursor.
    return validationResult(await artifactById(repo,row.id));
  }catch(err){
    if(isInvocationBudgetError(err))throw err;
    await repo.db.prepare("UPDATE pdf_artifacts SET status='failed',last_error='artifact-integrity',updated_at=? WHERE id=? AND status='pending' AND validation_state='validating' AND upload_revision=? AND validation_cursor=? AND validation_manifest=?").bind(now,row.id,row.upload_revision,row.validation_cursor,row.validation_manifest).run();
    return validationResult(await artifactById(repo,row.id));
  }
}

export async function preparedPdf(repo,env,context) {
  const row=await findReadyArtifact(repo,context);if(!row)return null;
  try{return {row,bytes:await readArtifactBytes(repo,env,row)};}
  catch(err){if(isInvocationBudgetError(err))throw err;await repo.db.prepare("UPDATE pdf_artifacts SET status='failed',last_error='artifact-integrity',updated_at=? WHERE id=?").bind(new Date().toISOString(),row.id).run();if(err.status!==409)throw err;return null;}
}

export async function listPdfPreparationTargets(repo,env,{cursor=0,limit=25}={}) {
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>25)throw error(400,'Invalid preparation cursor');
  const [settings,owner]=await Promise.all([repo.getSettings(env),repo.getOwner()]);
  const layouts=['zh','en','ru'].map(locale=>pdfLayoutKey({locale,style:settings.preferences.pdf_style,timezone:settings.preferences.timezone},owner?.display_name));
  const rows=(await repo.db.prepare(`SELECT i.id,i.revision FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id
    WHERE i.id>? AND i.revoked_at IS NULL AND json_valid(i.encrypted_payload) AND json_extract(i.encrypted_payload,'$.mode')='link'
    AND NOT EXISTS(SELECT 1 FROM pdf_artifacts a WHERE a.kind='private' AND a.item_id=i.id AND a.status='ready'
      AND a.source_revision=json_array(i.revision,i.updated_at,COALESCE(r.name,c.name),COALESCE(r.email,c.email))
      AND a.locale=COALESCE(r.locale,c.locale,'zh') AND a.layout_key=CASE COALESCE(r.locale,c.locale,'zh') WHEN 'en' THEN ? WHEN 'ru' THEN ? ELSE ? END)
    ORDER BY i.id LIMIT ?`).bind(cursor,layouts[1],layouts[2],layouts[0],limit+1).all()).results;
  const results=rows.slice(0,limit).map(r=>({kind:'private',id:r.id,revision:r.revision}));
  if(cursor===0){for(const locale of ['zh','en','ru']){const context=await artifactContext(repo,env,{kind:'public',locale,metadataOnly:env.BACKGROUND_EXECUTION_MODE==='staged'});if(context.document&&!await findReadyArtifact(repo,context))results.push({kind:'public',locale});}}
  return {results,next_cursor:rows.length>limit?rows[limit-1].id:null};
}

export async function pdfPreparationSource(repo,env,context,{cursor}={}) {
  if(context.kind==='private'){
    if(cursor)throw error(400,'Private PDF source does not accept a cursor');
    // Discovery and guards use metadata-only contexts. The authenticated source
    // endpoint is the one place that explicitly needs the original ciphertext.
    const stored=context.item.encrypted_payload??(await repo.db.prepare('SELECT encrypted_payload FROM encrypted_items WHERE id=? AND revision=?').bind(context.item_id,context.item.revision).first())?.encrypted_payload;
    if(!stored)throw error(409,'PDF source changed while loading');
    const opened=await openStoredPayload(stored,env);
    return {kind:'private',source_revision:context.source_revision,layout_key:context.layout_key,options:{...context.options,ownerName:context.owner?.display_name,recipientName:context.item.recipient_name,body:opened.plaintext,updatedAt:context.item.updated_at||context.item.created_at}};
  }
  let after=null;
  if(cursor){
    try{
      if(typeof cursor!=='string'||cursor.length>4096||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
      const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if(value.v!==1||value.source_revision!==context.source_revision||value.layout_key!==context.layout_key)throw error(409,'PDF source or layout changed during pagination');
      after=value.position;
      if(!Array.isArray(after)||after.length!==6||after.some(n=>!Number.isSafeInteger(n))||after[1]<1||after[2]<0||after[2]>2||after[4]<0||after[5]<0)throw Error();
    }catch(err){if(err.status)throw err;throw error(400,'Invalid PDF source cursor');}
  }
  // Slice text inside SQLite before crossing the D1 response boundary. Even an
  // entry or epigraph larger than a page is resumed by Unicode character offset.
  // 16,384 scalar values occupy at most 64 KiB of UTF-8 text.
  const records=`SELECT g.sort_order AS group_order,g.id AS group_id,0 AS field_order,0 AS entry_order,0 AS entry_id,g.title AS text,g.title_updated_at,g.epigraph_updated_at,NULL AS body_updated_at FROM public_farewell_groups_v2 g WHERE g.is_deleted=0
    UNION ALL SELECT g.sort_order,g.id,1,0,0,g.epigraph,g.title_updated_at,g.epigraph_updated_at,NULL FROM public_farewell_groups_v2 g WHERE g.is_deleted=0
    UNION ALL SELECT g.sort_order,g.id,2,e.sort_order,e.id,e.body,g.title_updated_at,g.epigraph_updated_at,e.body_updated_at FROM public_farewell_entries_v2 e JOIN public_farewell_groups_v2 g ON g.id=e.group_id WHERE g.is_deleted=0 AND e.is_deleted=0 AND e.is_public=1`;
  const tuple=after?.slice(0,5),offset=after?.[5]||0;
  const same=after?'(group_order,group_id,field_order,entry_order,entry_id)=(?,?,?,?,?)':'0';
  const row=await repo.db.prepare(`WITH records AS (${records}) SELECT group_order,group_id,field_order,entry_order,entry_id,title_updated_at,epigraph_updated_at,body_updated_at,length(text) AS text_length,
    CASE WHEN ${same} THEN ? ELSE 0 END AS start_offset,
    substr(text,CASE WHEN ${same} THEN ? ELSE 1 END,16384) AS text
    FROM records ${after?'WHERE (group_order,group_id,field_order,entry_order,entry_id)>(?,?,?,?,?) OR ((group_order,group_id,field_order,entry_order,entry_id)=(?,?,?,?,?) AND length(text)>?)':''}
    ORDER BY group_order,group_id,field_order,entry_order,entry_id LIMIT 1`)
    .bind(...(after?tuple:[]),offset,...(after?tuple:[]),offset+1,...(after?[...tuple,...tuple,offset]:[])).first();
  if(!await artifactIsCurrent(repo,context))throw error(409,'PDF source or layout changed during pagination');
  const fragments=[];let next_cursor=null;
  if(row){
    const text=String(row.text||''),end=row.start_offset+[...text].length;
    if(new TextEncoder().encode(text).length>PDF_SOURCE_PAGE_BYTES)throw error(413,'PDF source page exceeds limit');
    fragments.push({group_id:row.group_id,entry_id:row.entry_id,group_order:row.group_order,entry_order:row.entry_order,field:['display_title','display_epigraph','display_body'][row.field_order],text,offset:row.start_offset,end_offset:end,title_updated_at:row.title_updated_at,epigraph_updated_at:row.epigraph_updated_at,body_updated_at:row.body_updated_at});
    next_cursor=Buffer.from(JSON.stringify({v:1,source_revision:context.source_revision,layout_key:context.layout_key,position:[row.group_order,row.group_id,row.field_order,row.entry_order,row.entry_id,end]})).toString('base64url');
  }
  return {kind:'public',source_revision:context.source_revision,layout_key:context.layout_key,options:{...context.options,ownerName:context.owner?.display_name,updatedAt:context.document?.updated_at},fragments,next_cursor};
}
export async function assertPublicPdfSourceSize(repo,env={}){
  if(env.BACKGROUND_EXECUTION_MODE==='staged')return;
  const row=await repo.db.prepare(`SELECT
    COALESCE((SELECT SUM(length(CAST(e.body AS BLOB))) FROM public_farewell_entries_v2 e JOIN public_farewell_groups_v2 g ON g.id=e.group_id WHERE e.is_deleted=0 AND e.is_public=1 AND g.is_deleted=0),0)
    +COALESCE((SELECT SUM(length(CAST(title AS BLOB))+length(CAST(epigraph AS BLOB))+512) FROM public_farewell_groups_v2 WHERE is_deleted=0 AND is_committed=1),0) AS bytes`).first();
  if(row.bytes>MAX_PDF_SOURCE_BYTES)throw error(413,'Formal PDF source exceeds the 4 MiB automatic preparation limit; the saved text is safe');
}
