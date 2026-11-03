// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {createMailProvider as getMailProvider} from './mail.js';
import {claimJob,checkpointJob,saveOwnedJob,openJobValue} from './background-jobs.js';
import {createMimeDescriptor,readMimeRange,startUpload,probeUpload,uploadPart,MAIL_UPLOAD_CHUNK_BYTES} from './mail-upload.js';

// One invocation advances only one durable phase and at most one MIME range.
// payload.dedupeKey stays the existing canonical delivery identity across rounds.
export async function runStagedMail(repo,env,now=new Date().toISOString(),options={}){
  const job=await claimJob(repo,{now,kind:'mail'});if(!job)return {status:'idle'};
  const started=performance.now(),clock=()=>new Date(Date.parse(now)+performance.now()-started).toISOString();
  const provider=options.provider||getMailProvider(env);if(provider.env)provider.env=env;
  let payload,checkpoint,durableReceipt=false,temporarilyBlocked=false;
  const next=()=>new Date(Date.parse(now)+Math.max(1000,Number(env.BACKGROUND_MAIL_RETRY_MS)||300000)).toISOString();
  const save=(state='pending',error=null,delay=false)=>checkpointJob(repo,env,job,{checkpoint,state,error,next:delay?next():clock(),now:clock()});
  const guard=async()=>typeof options.canSend==='function'&&Boolean(await options.canSend(job,payload,checkpoint));
  const canDispatch=async()=>{
    temporarilyBlocked=false;
    if(!await guard())return false;
    if(options.deliveryReady&&!await options.deliveryReady(job,payload,checkpoint)){temporarilyBlocked=true;return false;}
    return true;
  };
  async function finish(status,error=null,receipt={}){
    let changed=true;
    if(checkpoint.finalAttemptId&&!durableReceipt){const result=await repo.finishMailClaim(payload.dedupeKey,status,error,checkpoint.finalAttemptId,receipt);changed=Boolean(result?.meta?.changes??result);}
    if(changed&&['sent','dry_run','uncertain'].includes(status)){
      const logged=await repo.logDelivery({eventType:payload.eventType||'background_mail',recipientEmail:checkpoint.message?.to||payload.to||'',subject:checkpoint.message?.subject||'',provider:provider.name,status,dedupeKey:payload.dedupeKey,lastError:error,now:clock(),expectedAttemptId:checkpoint.finalAttemptId??null});
      if(logged?.meta?.changes!==0)await options.onResult?.(job,payload,checkpoint,{status,...receipt,attemptId:checkpoint.finalAttemptId});
    }
    await save(status==='sent'||status==='dry_run'?'completed':status==='uncertain'?'uncertain':'cancelled',error);
    return {jobId:job.id,status,...receipt};
  }
  async function beforeFinal(phase){
    const attemptId=crypto.randomUUID(),settings=repo.getSettings?await repo.getSettings(env):null;
    const cap=Math.min(Number(env.MAX_DAILY_EMAILS)||20,settings?.preferences.daily_email_limit??20);
    if(!await repo.claimMail(payload.dedupeKey,clock(),cap,attemptId))return false;
    checkpoint={...checkpoint,phase,finalAttemptId:attemptId};
    if(!await saveOwnedJob(repo,env,job,{checkpoint,now:clock()})){
      await repo.finishMailClaim(payload.dedupeKey,'cancelled','lease-or-round-changed',attemptId);return false;
    }
    return true;
  }
  async function handle(result){
    if(result.status==='sent'||result.status==='dry_run')return await finish(result.status,null,{...(result.id?{id:result.id}:{}),...(result.threadId?{threadId:result.threadId}:{})});
    if(result.status==='uncertain')return await finish('uncertain',result.error||'dispatch-result-uncertain');
    if(result.status==='probe_required'){
      checkpoint.phase='probe';await save('pending','upload-probe-required',true);return {jobId:job.id,status:'probe_required'};
    }
    if(result.status==='session_lost'){
      if(checkpoint.finalAttemptId)return await finish('uncertain','final-upload-session-lost');
      checkpoint={...checkpoint,phase:'start',session:null,offset:0};await save('pending','upload-session-expired',true);return {jobId:job.id,status:'pending'};
    }
    if(result.status==='uploading'){
      if(checkpoint.finalAttemptId){await repo.finishMailClaim(payload.dedupeKey,'cancelled','upload-confirmed-incomplete',checkpoint.finalAttemptId);checkpoint.finalAttemptId=null;}
      checkpoint={...checkpoint,phase:'upload',offset:result.offset};await save();return {jobId:job.id,status:'pending',offset:result.offset};
    }
    if(checkpoint.phase==='probe'&&result.status==='deferred'){
      await save('pending','upload-probe-deferred',true);return {jobId:job.id,status:'probe_required'};
    }
    if(result.claimed&&checkpoint.finalAttemptId){await repo.finishMailClaim(payload.dedupeKey,'cancelled',result.reason||result.error||'not-dispatched',checkpoint.finalAttemptId);checkpoint.finalAttemptId=null;}
    if(result.status==='skipped'&&result.reason==='state-changed'||result.status==='skipped'&&result.error==='state-changed'){
      if(temporarilyBlocked){checkpoint.phase=checkpoint.descriptor?'upload':'text';await save('pending','inbox-not-fresh',true);return {jobId:job.id,status:'deferred',reason:'inbox-not-fresh'};}
      return await finish('cancelled','state-changed');
    }
    if(result.status==='skipped'&&result.reason==='claimed-or-cap'){
      const row=await repo.db.prepare('SELECT status FROM mail_claims WHERE dedupe_key=?').bind(payload.dedupeKey).first();
      if(['sent','dry_run'].includes(row?.status)){await save('completed');return {jobId:job.id,status:'dedupe'};}
      if(['sending','uncertain'].includes(row?.status)){await save('uncertain','canonical-claim-unresolved');return {jobId:job.id,status:'uncertain'};}
    }
    checkpoint.phase=checkpoint.descriptor?'upload':'text';await save('pending',result.reason||result.error||'mail-deferred',true);return {jobId:job.id,status:'deferred'};
  }
  try{
    payload=await openJobValue(env,job.payload);checkpoint=await openJobValue(env,job.checkpoint);
    if(typeof payload.dedupeKey!=='string'||!payload.dedupeKey||payload.dedupeKey!==job.dedupe_key)throw Error('Invalid mail job identity');
    if(checkpoint.finalAttemptId){
      const prior=await repo.db.prepare('SELECT status,attempt_id,provider_message_id,provider_thread_id FROM mail_claims WHERE dedupe_key=?').bind(payload.dedupeKey).first();
      if(prior?.attempt_id===checkpoint.finalAttemptId&&['sent','dry_run'].includes(prior.status)){durableReceipt=true;return await finish(prior.status,null,{...(prior.provider_message_id?{id:prior.provider_message_id}:{}),...(prior.provider_thread_id?{threadId:prior.provider_thread_id}:{})});}
    }
    if(checkpoint.phase==='text-probe')return await finish('uncertain','text-dispatch-receipt-missing');
    if(checkpoint.phase==='dry-probe')return await finish('dry_run');
    if(checkpoint.phase==='probe')return await handle(await probeUpload(provider,checkpoint.session,{transport:options.transport}));
    if(!await guard())return await finish('cancelled','state-changed');
    if(!checkpoint.phase){
      if(typeof options.prepare!=='function')throw Error('Missing mail preparation hook');
      const prepared=await options.prepare(job,payload,checkpoint);if(!prepared?.message){await save('pending','mail-not-ready',true);return {jobId:job.id,status:'pending'};}
      checkpoint={...prepared,message:{...prepared.message,messageId:prepared.message.messageId||'<afterme_'+crypto.randomUUID().replaceAll('-','')+'@afterme.invalid>'}};
      if(!checkpoint.descriptor&&(checkpoint.message.attachment||checkpoint.message.attachments?.length))checkpoint.descriptor=createMimeDescriptor(checkpoint.message,{messageId:checkpoint.message.messageId});
      checkpoint.phase=checkpoint.descriptor?'start':'text';await save();return {jobId:job.id,status:'prepared'};
    }
    if(checkpoint.phase==='text'){
      if(provider.name==='dry-run'){
        if(!await canDispatch())return await handle({status:'skipped',reason:'state-changed'});
        if(!await beforeFinal('dry-probe'))return await handle({status:'skipped',reason:'claimed-or-cap'});
        if(!await canDispatch())return await handle({status:'skipped',reason:'state-changed',claimed:true});
        return await handle(await provider.send(checkpoint.message));
      }
      if(typeof provider.sendMedia!=='function')throw Error('Staged provider requires media upload');
      return await handle(await provider.sendMedia({...checkpoint.message,canSend:canDispatch,beforeFinal:()=>beforeFinal('text-probe')},{transport:options.transport}));
    }
    if(checkpoint.phase==='start'){
      if(provider.name==='dry-run'){checkpoint={...checkpoint,phase:'upload',offset:0};await save();return {jobId:job.id,status:'pending'};}
      const result=await startUpload(provider,checkpoint.descriptor.totalBytes,{transport:options.transport});
      if(result.status==='uploading'){checkpoint={...checkpoint,phase:'upload',session:result.session,offset:0};await save();return {jobId:job.id,status:'started'};}
      await save('pending','upload-not-started',true);return {jobId:job.id,status:'deferred'};
    }
    if(checkpoint.phase!=='upload'||typeof options.readAttachmentRange!=='function')throw Error('Invalid mail upload checkpoint');
    const offset=Number(checkpoint.offset||0),length=Math.min(MAIL_UPLOAD_CHUNK_BYTES,checkpoint.descriptor.totalBytes-offset);
    const bytes=await readMimeRange(checkpoint.descriptor,offset,length,(start,size)=>options.readAttachmentRange(job,payload,checkpoint,start,size));
    if(!await guard())return await finish('cancelled','state-changed');
    if(provider.name==='dry-run'){
      if(offset+length<checkpoint.descriptor.totalBytes){checkpoint.offset=offset+length;await save();return {jobId:job.id,status:'pending',offset:checkpoint.offset};}
      if(!await canDispatch())return await handle({status:'skipped',reason:'state-changed'});
      if(!await beforeFinal('dry-probe'))return await handle({status:'skipped',reason:'claimed-or-cap'});
      if(!await canDispatch())return await handle({status:'skipped',reason:'state-changed',claimed:true});
      await provider.send({...checkpoint.message,attachments:[{filename:checkpoint.message.attachment?.filename,data:bytes}]});return await finish('dry_run');
    }
    // Record the upload intention even for non-final chunks: after a crash the
    // next owner probes Google's offset instead of replaying an unknown range.
    const final=offset+length===checkpoint.descriptor.totalBytes;
    if(!final){checkpoint.phase='probe';if(!await saveOwnedJob(repo,env,job,{checkpoint,now:clock()}))return {jobId:job.id,status:'lease-lost'};}
    return await handle(await uploadPart(provider,checkpoint.session,offset,bytes,{canSend:canDispatch,beforeFinal:()=>beforeFinal('probe'),transport:options.transport}));
  }catch(error){
    // Never discard a durable dispatch intention on a local/database error.
    if(checkpoint?.finalAttemptId){await save('pending','dispatch-result-needs-review',true);return {jobId:job.id,status:'probe_required'};}
    if(payload&&checkpoint)await save('failed','mail-stage-failed',true);
    return {jobId:job.id,status:'failed'};
  }
}
