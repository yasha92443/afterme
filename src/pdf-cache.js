// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { buildPrivateLetterPdf,buildPublicFarewellPdf } from './pdf.js';
import { openStoredPayload,buildStoredPayload,storedPayloadMode } from './content.js';
import {cloudChineseFont} from './pdf-chinese-font.js';
import {PDF_VERSION,pdfLayoutKey} from './pdf-layout.js';
import {artifactContext,artifactIsCurrent,preparedPdf,validPdf} from './pdf-artifacts.js';
import {bytesToBase64,base64ToBytes} from './invocation-budget.js';
export {PDF_VERSION} from './pdf-layout.js';
export async function pdfOptions(repo,env,locale) {
  const p=repo.getSettings?(await repo.getSettings(env)).preferences:{};
  return {locale:locale||p.locale||'zh',timezone:p.timezone||'Asia/Shanghai',style:p.pdf_style||'night'};
}
const layoutKey=pdfLayoutKey;
export async function privatePdfPayload(bytes,env,encryptedPayload='') {
  // D1 limits the entire row. An oversized derivative can be generated on demand
  // without preventing the original letter from being saved or delivered.
  if(bytes.length*16/9+encryptedPayload.length+8192>1800000)return null;
  return buildStoredPayload({body:{plaintext:bytesToBase64(bytes)},env});
}
async function sha(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function cachedPrivatePdf(repo,env,item,owner,options) {
  if(storedPayloadMode(item.encrypted_payload)!=='link')return {skipped:true};
  options ||= await pdfOptions(repo,env,item.recipient_locale);
  const key=await sha(layoutKey(options,owner?.display_name)+JSON.stringify([item.revision,item.recipient_name,item.updated_at]));
  if(item.pdf_payload&&item.pdf_cache_key===key){try{const opened=await openStoredPayload(item.pdf_payload,env);const bytes=opened.mode==='link'&&opened.plaintext?base64ToBytes(opened.plaintext):null;if(validPdf(bytes))return {bytes,cached:true};}catch{/* The original text remains the source of truth. */}}
  if(repo.db){const context=await artifactContext(repo,env,{kind:'private',id:item.id}),ready=await preparedPdf(repo,env,context);if(ready)return {bytes:ready.bytes,cached:true,artifact_id:ready.row.id,conflict:context.item.revision!==item.revision||!await artifactIsCurrent(repo,context)};}
  if(env.PDF_GENERATION_MODE==='browser')throw Object.assign(new Error('PDF preparation is pending; open management to prepare the saved letter'),{status:409,code:'pdf_not_ready'});
  const body=await openStoredPayload(item.encrypted_payload,env);
  const bytes=buildPrivateLetterPdf({...options,chineseFont:await cloudChineseFont(env),ownerName:owner?.display_name,recipientName:item.recipient_name,body:body.plaintext,updatedAt:item.updated_at||item.created_at});
  const pdfPayload=await privatePdfPayload(bytes,env,item.encrypted_payload);
  if(!pdfPayload){const current=await repo.getEncryptedItemForAdmin(item.id);return {bytes,cached:false,uncacheable:true,conflict:current?.revision!==item.revision};}
  const saved=await repo.updatePrivateItemPdf({id:item.id,pdfPayload,expectedRevision:item.revision,cacheKey:key});
  return {bytes,cached:false,conflict:saved===false};
}
export async function cachedPublicPdf(repo,env,owner,locale,retry=true,{bytesOnly=false}={}) {
  const options=await pdfOptions(repo,env,locale),document=await repo.getPublicFarewell();
  const context=repo.db?await artifactContext(repo,env,{kind:'public',locale:options.locale}):null;
  const ready=context?await preparedPdf(repo,env,context):null;
  if(ready){
    if(!await artifactIsCurrent(repo,context)){if(retry)return cachedPublicPdf(repo,env,owner,locale,false,{bytesOnly});throw Object.assign(Error('Public content changed during PDF read'),{status:409});}
    return {key:locale?'public_farewell:'+locale:'public_farewell',filename:'afterme-public-farewell.pdf',...(bytesOnly?{bytes:ready.bytes}:{content_base64:bytesToBase64(ready.bytes)}),mime_type:'application/pdf',sha256:ready.row.sha256,updated_at:document?.updated_at,layout_key:ready.row.layout_key,source_revision:ready.row.source_revision};
  }
  const key=locale?'public_farewell:'+locale:'public_farewell',layout=layoutKey(options,owner?.display_name)+(context?':'+context.source_revision:'');
  let artifact=await repo.getDocumentArtifact(key);
  if(artifact?.layout_key===layout&&artifact.updated_at===document?.updated_at){try{const bytes=base64ToBytes(artifact.content_base64);if(validPdf(bytes))return bytesOnly?{...artifact,bytes}:artifact;}catch{}}
  if(env.PDF_GENERATION_MODE==='browser')throw Object.assign(new Error('PDF preparation is pending; open management to prepare the formal version'),{status:409,code:'pdf_not_ready'});
  const groups=await repo.farewell.listFormalGroups(),bytes=buildPublicFarewellPdf({...options,chineseFont:await cloudChineseFont(env),ownerName:owner?.display_name,groups,updatedAt:document?.updated_at});
  const generated={key,filename:'afterme-public-farewell.pdf',mimeType:'application/pdf',contentBase64:bytesToBase64(bytes),sha256:await sha(bytes),updatedAt:document?.updated_at||new Date().toISOString(),layoutKey:layout,guardDocument:Boolean(document)};
  const saved=generated.contentBase64.length<1800000?await repo.saveDocumentArtifact(generated):undefined;
  const current=await repo.getPublicFarewell();
  const after=context?await artifactContext(repo,env,{kind:'public',locale:options.locale}):null;
  if(saved===false||current?.updated_at!==document?.updated_at||(context&&after.source_revision!==context.source_revision)){if(retry)return cachedPublicPdf(repo,env,owner,locale,false,{bytesOnly});const error=new Error('Public content changed during PDF generation');error.status=409;throw error;}
  return {...generated,...(bytesOnly?{bytes}:{}),content_base64:generated.contentBase64,mime_type:generated.mimeType,layout_key:layout,updated_at:generated.updatedAt};
}
export async function queuePdfJob(repo,env,now,{force=false}={}) {
  const owner=await repo.getOwner(),options=await pdfOptions(repo,env),key=layoutKey(options,owner?.display_name);
  await repo.db.prepare("UPDATE pdf_jobs SET status='cancelled',updated_at=? WHERE layout_key<>? AND status='pending'").bind(now,key).run();
  const existing=await repo.db.prepare("SELECT * FROM pdf_jobs WHERE layout_key=? AND status IN ('pending','running','complete') ORDER BY id DESC LIMIT 1").bind(key).first();
  if(existing&&(!force||existing.status!=='complete'))return existing;
  const r=await repo.db.prepare('INSERT INTO pdf_jobs(layout_key,created_at,updated_at) VALUES(?,?,?)').bind(key,now,now).run();
  return repo.db.prepare('SELECT * FROM pdf_jobs WHERE id=?').bind(r.meta.last_row_id).first();
}
export async function processPdfBatch(repo,env,now) {
  if(env.PDF_GENERATION_MODE==='browser')return {status:'pending',reason:'browser-preparation-required',generator_version:PDF_VERSION};
  const job=await queuePdfJob(repo,env,now);if(job.status==='complete')return {skipped:true,reason:'current',generator_version:PDF_VERSION};
  const lease=crypto.randomUUID();
  const claim=await repo.db.prepare("UPDATE pdf_jobs SET status='running',lease_id=?,leased_at=? WHERE id=? AND (status='pending' OR (status='running' AND julianday(leased_at)<julianday(?)-15.0/1440))").bind(lease,now,job.id,now).run();
  if(!claim.meta?.changes)return {skipped:true,reason:'claimed'};
  try {
    const owner=await repo.getOwner(),options=await pdfOptions(repo,env);
    if(layoutKey(options,owner?.display_name)!==job.layout_key){await repo.db.prepare("UPDATE pdf_jobs SET status='cancelled',updated_at=? WHERE id=? AND lease_id=?").bind(now,job.id,lease).run();return {cancelled:true};}
    const items=(await repo.db.prepare("SELECT i.*,COALESCE(r.name,c.name) AS recipient_name,COALESCE(r.locale,c.locale,'zh') AS recipient_locale FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id WHERE i.id>? ORDER BY i.id LIMIT 6").bind(job.cursor).all()).results;
    let completed=0,conflicts=0,cursor=job.cursor;
    for(const item of items.slice(0,5)){const r=await cachedPrivatePdf(repo,env,item,owner,{...options,locale:item.recipient_locale});if(r.conflict)conflicts++;else completed++;cursor=item.id;}
    const done=items.length<=5;if(done)await cachedPublicPdf(repo,env,owner);
    await repo.db.prepare('UPDATE pdf_jobs SET status=?,cursor=?,completed=completed+?,conflicts=conflicts+?,updated_at=? WHERE id=? AND lease_id=?').bind(done?'complete':'pending',cursor,completed,conflicts,now,job.id,lease).run();
    if(done)await repo.audit('pdf_artifacts_rebuilt',{generator_version:PDF_VERSION,job_id:job.id,private_generated:job.completed+completed,conflicts:job.conflicts+conflicts},now);
    return {job_id:job.id,status:done?'complete':'pending',completed:job.completed+completed,conflicts:job.conflicts+conflicts,generator_version:PDF_VERSION};
  }catch(error){await repo.db.prepare("UPDATE pdf_jobs SET status='pending',updated_at=? WHERE id=? AND lease_id=?").bind(now,job.id,lease).run();throw error;}
}
