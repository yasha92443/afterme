// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {Buffer} from 'node:buffer';
import {buildGmailMimeMessage} from './mail.js';
import {budgetFetch,invocationBudget,isInvocationBudgetError} from './invocation-budget.js';

export const MAIL_UPLOAD_CHUNK_BYTES=256*1024;
// Gmail discovery users.messages.send.mediaUpload.maxSize (revision 20261019).
// https://gmail.googleapis.com/$discovery/rest?version=v1
export const GMAIL_MAX_MIME_BYTES=36700160;
const invalid=()=>{throw new Error('Invalid mail upload data');};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const encodedLength=bytes=>{const n=4*Math.ceil(bytes/3);return n+2*Math.max(0,Math.floor((n-1)/76));};

// Persist this descriptor inside the encrypted job payload. It contains mail text.
export function createMimeDescriptor(message,{boundary='afterme_'+crypto.randomUUID().replaceAll('-',''),messageId='<afterme_'+crypto.randomUUID().replaceAll('-','')+'@afterme.invalid>'}={}){
  const attachment=message.attachment||message.attachments?.[0];
  if(!attachment||message.attachments?.length>1||!integer(attachment.byteLength)||attachment.byteLength>GMAIL_MAX_MIME_BYTES)invalid();
  const suffix='\r\n--'+boundary+'--\r\n';
  const empty=buildGmailMimeMessage({...message,boundary,messageId,attachments:[{filename:attachment.filename,contentType:attachment.contentType||'application/pdf',data:new Uint8Array()}]});
  if(!empty.endsWith(suffix))invalid();
  const prefix=empty.slice(0,-suffix.length),attachmentEncodedBytes=encodedLength(attachment.byteLength);
  const descriptor={version:1,boundary,messageId,prefix,suffix,attachmentBytes:attachment.byteLength,attachmentEncodedBytes,totalBytes:Buffer.byteLength(prefix,'utf8')+attachmentEncodedBytes+Buffer.byteLength(suffix,'utf8')};
  validateDescriptor(descriptor);return descriptor;
}
function validateDescriptor(d){
  if(!d||d.version!==1||typeof d.prefix!=='string'||d.prefix.length>128*1024||typeof d.suffix!=='string'||!/^[A-Za-z0-9_-]{1,70}$/.test(d.boundary)||d.suffix!=='\r\n--'+d.boundary+'--\r\n'||!d.prefix.endsWith('\r\n\r\n')||!integer(d.attachmentBytes)||d.attachmentBytes>GMAIL_MAX_MIME_BYTES||d.attachmentEncodedBytes!==encodedLength(d.attachmentBytes)||d.totalBytes!==Buffer.byteLength(d.prefix,'utf8')+d.attachmentEncodedBytes+Buffer.byteLength(d.suffix,'utf8')||d.totalBytes>GMAIL_MAX_MIME_BYTES||Buffer.byteLength(d.prefix,'utf8')>128*1024)invalid();
}

// The callback reads binary PDF bytes only. No whole PDF or MIME is assembled.
export async function readMimeRange(descriptor,offset,length,readAttachmentRange){
  validateDescriptor(descriptor);
  if(!integer(offset)||!integer(length)||length>MAIL_UPLOAD_CHUNK_BYTES||offset+length>descriptor.totalBytes||typeof readAttachmentRange!=='function')invalid();
  const result=new Uint8Array(length),prefix=Buffer.from(descriptor.prefix,'utf8'),suffix=Buffer.from(descriptor.suffix,'utf8'),end=offset+length;
  function copy(bytes,start){const low=Math.max(offset,start),high=Math.min(end,start+bytes.length);if(high>low)result.set(bytes.subarray(low-start,high-start),low-offset);}
  copy(prefix,0);const low=Math.max(0,offset-prefix.length),high=Math.min(descriptor.attachmentEncodedBytes,end-prefix.length);
  if(high>low){
    const firstLine=Math.floor(low/78),lastLine=Math.floor((high-1)/78),rawStart=firstLine*57,rawEnd=Math.min(descriptor.attachmentBytes,(lastLine+1)*57);
    const bytes=await readAttachmentRange(rawStart,rawEnd-rawStart);
    if(!(bytes instanceof Uint8Array)||bytes.byteLength!==rawEnd-rawStart)invalid();
    let encoded=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64').replace(/.{76}(?=.)/g,'$&\r\n');
    if(rawEnd<descriptor.attachmentBytes)encoded+='\r\n';
    const slice=Buffer.from(encoded.slice(low-firstLine*78,high-firstLine*78),'ascii');if(slice.length!==high-low)invalid();
    result.set(slice,prefix.length+low-offset);
  }
  copy(suffix,prefix.length+descriptor.attachmentEncodedBytes);return result;
}

function validateSession(session){
  if(!session||typeof session.uri!=='string'||!integer(session.totalBytes)||session.totalBytes<1||session.totalBytes>GMAIL_MAX_MIME_BYTES)invalid();
  let url;try{url=new URL(session.uri);}catch{invalid();}
  if(url.protocol!=='https:'||!['gmail.googleapis.com','www.googleapis.com'].includes(url.hostname)||(url.port&&url.port!=='443')||url.username||url.password||url.hash||!/^\/(?:resumable\/)?upload\/gmail\/v1\/users\/[^/]+\/messages\/send$/.test(url.pathname)||url.searchParams.get('uploadType')!=='resumable'||!url.searchParams.get('upload_id'))invalid();
}
async function access(provider){const result=await provider.getAccessToken();if(!result?.ok||typeof result.accessToken!=='string'||!result.accessToken)throw new Error('Mail OAuth unavailable');return result.accessToken;}
const request=(provider,url,init,options)=>{const transport=options.transport||provider.transport;if(transport){invocationBudget(provider.env)?.consumeExternal();return transport(url,init);}return budgetFetch(provider.env,url,init);};
const uncertain=(final=false,claimed=false)=>({status:'probe_required',needsProbe:true,final,claimed});
async function receipt(response){
  const reader=response.body?.getReader();if(!reader)return null;const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();return null;}parts.push(value);}}finally{reader.releaseLock();}
  try{const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(typeof row.id!=='string'||!row.id||row.id.length>200||row.threadId!==undefined&&(typeof row.threadId!=='string'||row.threadId.length>200))return null;return {id:row.id,...(row.threadId?{threadId:row.threadId}:{})};}catch{return null;}
}
async function outcome(response,totalBytes,{final=false,claimed=false,maxOffset=totalBytes}={}){
  if(response.status===308){
    const header=response.headers.get('Range'),match=header?.match(/^(?:bytes=)?0-(\d+)$/i),offset=header===null?0:match?Number(match[1])+1:NaN;
    if(!integer(offset)||offset>=totalBytes||offset>maxOffset)return uncertain(final,claimed);
    return {status:'uploading',offset,final,claimed};
  }
  if(response.status===200||response.status===201){const sent=await receipt(response);return sent?{status:'sent',offset:totalBytes,...sent,final,claimed}:uncertain(final,claimed);}
  if(response.status===404||response.status===410)return {status:'session_lost',needsProbe:false,statusCode:response.status,final,claimed};
  return {...uncertain(final,claimed),statusCode:response.status};
}

export async function startUpload(provider,totalBytes,options={}){
  if(!integer(totalBytes)||totalBytes<1||totalBytes>GMAIL_MAX_MIME_BYTES)invalid();
  try{
    const token=await access(provider),response=await request(provider,'https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send?uploadType=resumable&fields=id,threadId',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'X-Upload-Content-Type':'message/rfc822','X-Upload-Content-Length':String(totalBytes)},body:''},options);
    if(response.status!==200)return {status:'failed',error:'upload-start-failed',statusCode:response.status};
    const session={uri:response.headers.get('Location'),totalBytes};validateSession(session);return {status:'uploading',session,offset:0};
  }catch(error){return isInvocationBudgetError(error)?{status:'deferred',reason:'invocation-budget'}:{status:'failed',error:'upload-start-failed'};}
}
export async function probeUpload(provider,session,options={}){
  validateSession(session);
  try{const token=await access(provider),response=await request(provider,session.uri,{method:'PUT',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'message/rfc822','Content-Range':'bytes */'+session.totalBytes},body:new Uint8Array()},options);return await outcome(response,session.totalBytes);}
  catch(error){return isInvocationBudgetError(error)?{status:'deferred',reason:'invocation-budget'}:uncertain();}
}
export async function uploadPart(provider,session,offset,bytes,options={}){
  validateSession(session);
  if(!integer(offset)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAIL_UPLOAD_CHUNK_BYTES||offset+bytes.length>session.totalBytes)invalid();
  const final=offset+bytes.length===session.totalBytes;if(!final&&bytes.length!==MAIL_UPLOAD_CHUNK_BYTES)invalid();
  if(final&&(typeof options.canSend!=='function'||typeof options.beforeFinal!=='function'))invalid();
  let token,claimed=false;
  try{
    token=await access(provider);
    if(invocationBudget(provider.env)&&!invocationBudget(provider.env).canStart(0,1))return {status:'deferred',reason:'invocation-budget',final,claimed};
    if(final){if(!await options.canSend())return {status:'skipped',reason:'state-changed',final,claimed};if(!await options.beforeFinal())return {status:'skipped',reason:'claimed-or-cap',final,claimed};claimed=true;if(!await options.canSend())return {status:'skipped',reason:'state-changed',final,claimed};}
  }catch(error){return isInvocationBudgetError(error)?{status:'deferred',reason:'invocation-budget',final,claimed}:{status:'failed',error:'upload-preparation-failed',final,claimed};}
  try{const response=await request(provider,session.uri,{method:'PUT',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'message/rfc822','Content-Range':'bytes '+offset+'-'+(offset+bytes.length-1)+'/'+session.totalBytes},body:bytes},options);return await outcome(response,session.totalBytes,{final,claimed,maxOffset:offset+bytes.length});}
  catch(error){return isInvocationBudgetError(error)?{status:'deferred',reason:'invocation-budget',final,claimed}:uncertain(final,claimed);}
}
