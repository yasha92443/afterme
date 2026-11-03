// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {GmailMailProvider} from './mail.js';
import {openJobValue,sealJobValue} from './background-jobs.js';
import {inboxWorkFence} from './inbox-fence.js';
import {inboxGenerationFresh} from './background-scheduler.js';

const activeStates="'pending','running','failed'";
const enabled=value=>String(value??'true').trim().toLowerCase()!=='false';
const parsed=value=>{try{return JSON.parse(value||'');}catch{return null;}};
const expired=(at,now,limit)=>{const age=Date.parse(now)-Date.parse(at||'');return !Number.isFinite(age)||age<0||age>limit;};

function generationMetadata(generation,phase,now,extra={}){
  return {v:2,...generation,phase,status:'scanning',closed:false,completed_at:null,observed_at:now,backlog:false,incomplete:false,provider_verified_at:null,provider_failed:false,...extra};
}

async function bootstrap(repo,env,owner,previousValue,now,{configured=true}={}){
  const id=crypto.randomUUID(),generation={round:owner.confirmation_round,generation_id:id,job_id:id,started_at:now};
  const prior=parsed(previousValue),actual=prior?.round===owner.confirmation_round?{provider_verified_at:prior.provider_verified_at??null,provider_failed:prior.provider_failed===true,backlog:prior.backlog===true,incomplete:prior.incomplete===true}:{};
  const metadata=generationMetadata(generation,'list',now,{...actual,...(configured?{}:{status:'not-configured',closed:true})});
  const old="EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?) AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox')) OR EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox' AND value IS ?))";
  const oldArgs=[owner.confirmation_round,previousValue,previousValue],statements=[];
  if(configured){
    const [payload,checkpoint]=await Promise.all([sealJobValue(env,{v:1,generation}),sealJobValue(env,{phase:'list',pageCursor:'',scanStarted:false})]);
    statements.push(repo.db.prepare(`INSERT INTO background_jobs(id,job_key,kind,confirmation_round,payload,checkpoint,next_attempt_at,created_at,updated_at) SELECT ?,?,'inbox',?,?,?,?,?,? WHERE ${old}`).bind(id,'inbox:'+id,owner.confirmation_round,payload,checkpoint,now,now,now,...oldArgs));
  }
  statements.push(
    repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'gmail-inbox-page','' WHERE ${old} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(...oldArgs),
    repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'inbox-status',? WHERE ${old} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(metadata.status,...oldArgs),
    repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'inbox-status-round',? WHERE ${old} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(generation.round),...oldArgs),
    // The ownership row changes last: every statement tests the same prior value.
    repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'background-inbox',? WHERE ${old} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(metadata),...oldArgs),
  );
  const results=await repo.db.batch(statements),changed=Boolean(results.at(-1)?.meta?.changes);
  return {ok:changed,phase:'bootstrap',status:changed?metadata.status:'degraded',generation_id:id,...(!configured?{skipped:true}:{})};
}

async function claimPipelineJob(repo,metadata,now){
  const token=crypto.randomUUID(),until=new Date(Date.parse(now)+120000).toISOString();
  return repo.db.prepare(`UPDATE background_jobs SET state='running',lease_token=?,lease_until=?,attempt_id=?,updated_at=?
    WHERE id=? AND kind='inbox' AND confirmation_round=? AND state IN (${activeStates}) AND next_attempt_at<=? AND (lease_token IS NULL OR lease_until<=?)
    AND EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?)
    AND EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox' AND json_valid(value) AND json_extract(value,'$.generation_id')=? AND json_extract(value,'$.round')=?) RETURNING *`)
    .bind(token,until,token,now,metadata.job_id,metadata.round,now,now,metadata.round,metadata.generation_id,metadata.round).first();
}

function scopedRepository(repo,job,generation,owner,checkpoint,clock){
  const scoped=Object.create(repo),fence={jobId:job.id,leaseToken:job.lease_token,round:generation.round,generationId:generation.generation_id,clock};
  scoped.inboxFence=fence;
  let cachedOwner=owner,desiredPage=checkpoint.pageCursor||'';
  scoped.getOwner=async()=>cachedOwner||(cachedOwner=await repo.getOwner.call(scoped));
  scoped.getCursor=async key=>key==='gmail-inbox-page'?desiredPage:repo.getCursor.call(scoped,key);
  // Applying a previously fetched message does not make an independent cursor
  // write. The final checkpoint transaction owns and commits that progress.
  scoped.setCursor=async(key,value)=>{if(key==='gmail-inbox-page'){desiredPage=value||'';return true;}return repo.setCursor.call(scoped,key,value);};
  scoped.checkin=async(...args)=>{const changed=await repo.checkin.apply(scoped,args);if(changed)cachedOwner=null;return changed;};
  return {repo:scoped,fence,page:()=>desiredPage};
}

async function commit(repo,env,job,generation,checkpoint,metadata,now,{state='pending',error=null,pageCursor,delay=0,payload,statusChanged=true}={}){
  const fence=inboxWorkFence(repo,now,{scanning:false}),next=new Date(Date.parse(now)+delay).toISOString();
  const [encoded,encodedPayload]=await Promise.all([checkpoint===undefined?job.checkpoint:sealJobValue(env,checkpoint),payload===undefined?job.payload:sealJobValue(env,payload)]),statements=[];
  if(pageCursor!==undefined)statements.push(repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'gmail-inbox-page',? WHERE ${fence.sql} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(pageCursor,...fence.args));
  // Bootstrap already fixes the round cursor. Pure progress steps retain its
  // scanning status, so they need not rewrite those compatibility values.
  if(statusChanged)statements.push(repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'inbox-status',? WHERE ${fence.sql} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(metadata.status,...fence.args));
  statements.push(
    repo.db.prepare(`UPDATE runtime_cursors SET value=? WHERE key='background-inbox' AND ${fence.sql}`).bind(JSON.stringify(metadata),...fence.args),
    // Only this final statement releases the work lease. It still checks the
    // same generation after its watermark has changed from scanning to closed.
    repo.db.prepare(`UPDATE background_jobs SET state=?,payload=?,checkpoint=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=? WHERE id=? AND ${fence.sql}`).bind(state,encodedPayload,encoded,next,error,now,job.id,...fence.args),
  );
  const result=await repo.db.batch(statements);return Boolean(result.at(-1)?.meta?.changes);
}

function boundedMessage(message,id,threadId){
  if(!message||message.id!==id||typeof message.body!=='string'||new TextEncoder().encode(JSON.stringify(message)).byteLength>65536)return {id,threadId:threadId||'',from:'',recipients:'',subject:'',body:'',authenticationPassed:false,receivedAt:null,incomplete:true};
  return message;
}

// One minute of the inbox lane advances one durable phase only. A generation
// bootstrap does no network I/O; list and detail each perform one bounded HTTP
// read, while apply uses the normal authenticated reply processor without I/O.
export async function runInboxPipelineStep(repo,env,now=new Date().toISOString(),{provider,processReplies}={}){
  const started=performance.now(),clock=()=>new Date(Date.parse(now)+performance.now()-started).toISOString();
  const owner=await repo.db.prepare(`SELECT o.*,w.value AS inbox_generation,j.state AS inbox_job_state,j.confirmation_round AS inbox_job_round FROM owner o
    LEFT JOIN runtime_cursors w ON w.key='background-inbox'
    LEFT JOIN background_jobs j ON j.id=CASE WHEN json_valid(w.value) THEN json_extract(w.value,'$.job_id') ELSE NULL END WHERE o.id=1`).first();
  if(!owner)return {ok:true,phase:'idle',skipped:true,reason:'owner-not-setup'};
  const metadata=parsed(owner.inbox_generation),configured=(env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&enabled(env.MAIL_INBOUND_ENABLED);
  if(!configured){
    if(metadata?.round===owner.confirmation_round&&metadata.status==='not-configured')return {ok:true,phase:'idle',status:'not-configured',skipped:true};
    return bootstrap(repo,env,owner,owner.inbox_generation,now,{configured:false});
  }
  if(metadata?.round===owner.confirmation_round&&metadata.closed===true&&metadata.status==='healthy'&&!expired(metadata.completed_at,now,180000))return {ok:true,phase:'idle',status:inboxGenerationFresh(metadata,owner.confirmation_round,now)?'healthy':'degraded',skipped:true};
  const continuing=metadata?.v===2&&metadata.round===owner.confirmation_round&&typeof metadata.generation_id==='string'&&metadata.generation_id&&metadata.job_id===metadata.generation_id&&metadata.closed!==true&&Number.isFinite(Date.parse(metadata.started_at))&&Date.parse(metadata.started_at)<=Date.parse(now)&&owner.inbox_job_round===owner.confirmation_round&&['pending','running','failed'].includes(owner.inbox_job_state);
  if(!continuing)return bootstrap(repo,env,owner,owner.inbox_generation,now);
  const job=await claimPipelineJob(repo,metadata,clock());
  if(!job)return {ok:true,phase:'leased',status:'scanning',deferred:true};
  const generation={round:metadata.round,generation_id:metadata.generation_id,job_id:job.id,started_at:metadata.started_at};
  let checkpoint,currentMetadata=metadata;
  const observation={provider_verified_at:metadata.provider_verified_at??null,provider_failed:metadata.provider_failed===true,backlog:metadata.backlog===true,incomplete:metadata.incomplete===true};
  const state=(phase,at,extra={})=>generationMetadata(generation,phase,at,{...observation,...extra});
  const scoped=Object.create(repo);scoped.inboxFence={jobId:job.id,leaseToken:job.lease_token,round:generation.round,generationId:generation.generation_id,clock};
  const finish=async(nextCheckpoint,stateMeta,options={})=>commit(scoped,env,job,generation,nextCheckpoint,stateMeta,clock(),{...options,statusChanged:stateMeta.status!==currentMetadata.status,...(options.pageCursor!==undefined&&options.pageCursor===(checkpoint?.pageCursor||'')?{pageCursor:undefined}:{})});
  try{
    const payload=await openJobValue(env,job.payload);checkpoint=await openJobValue(env,job.checkpoint);
    if(payload?.v!==1||payload.generation?.generation_id!==generation.generation_id||payload.generation.round!==generation.round||payload.generation.started_at!==generation.started_at||!['list','detail','apply'].includes(checkpoint.phase))throw Error('Invalid inbox checkpoint');
    if(metadata.status!=='scanning'){
      const fence=inboxWorkFence(scoped,clock(),{scanning:false});
      const scanning=state(checkpoint.phase,clock()),changed=await repo.db.batch([
        repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'inbox-status','scanning' WHERE ${fence.sql} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(...fence.args),
        repo.db.prepare(`UPDATE runtime_cursors SET value=? WHERE key='background-inbox' AND ${fence.sql}`).bind(JSON.stringify(scanning),...fence.args),
      ]);
      if(!changed.at(-1)?.meta?.changes)return {ok:false,phase:'lease-lost',status:'degraded'};
      currentMetadata=scanning;
    }
    provider=provider?.name==='gmail'?provider:new GmailMailProvider(env);if(provider.env)provider.env=env;
    if(checkpoint.phase==='list'){
      const scanStartedAt=clock();
      const retry=(await repo.pendingInboundIds(1))[0];
      let candidate,backlog=false,nextPageToken='',moreOnPage=false;
      if(retry){candidate={id:retry};backlog=true;}
      else {
        const page=await provider.listInboundPage({pageToken:checkpoint.pageCursor||''}),verifiedAt=clock();
        if(!page||!Array.isArray(page.messages)||page.messages.length>100||typeof page.nextPageToken!=='string'||page.nextPageToken.length>4096||page.messages.some(row=>typeof row?.id!=='string'||!row.id||row.id.length>256||row.threadId!==undefined&&(typeof row.threadId!=='string'||row.threadId.length>256)))throw Error('Incomplete inbox page');
        const completed=await repo.completedInboundIds(page.messages.map(row=>row.id),generation.round),fresh=page.messages.filter(row=>!completed.has(row.id));
        candidate=fresh[0];nextPageToken=page.nextPageToken;moreOnPage=fresh.length>1;backlog=moreOnPage||Boolean(nextPageToken);
        observation.provider_verified_at=verifiedAt;observation.provider_failed=false;
      }
      observation.backlog=backlog;
      // No mailbox data exists at bootstrap. Bind the proof to the first real
      // list/retry observation's START, not its response completion. Later pages
      // and retries retain this exact time even if they finish much later.
      const firstObservation=checkpoint.scanStarted!==true;
      if(firstObservation)generation.started_at=scanStartedAt;
      const proof=firstObservation?{payload:{...payload,generation}}:{};
      if(candidate){
        const next={phase:'detail',pageCursor:checkpoint.pageCursor||'',scanStarted:true,id:candidate.id,threadId:candidate.threadId||'',nextPageToken,moreOnPage,backlog,retry:Boolean(retry)};
        const saved=await finish(next,state('detail',clock()),proof);
        return {ok:saved,phase:'list',status:saved?'scanning':'degraded',candidate:true,backlog};
      }
      if(nextPageToken){
        const next={phase:'list',pageCursor:nextPageToken,scanStarted:true},saved=await finish(next,state('list',clock()),{pageCursor:nextPageToken,...proof});
        return {ok:saved,phase:'list',status:saved?'scanning':'degraded',backlog:true};
      }
      const blocked=await repo.hasBlockingInbound(generation.round),at=clock(),healthy=!blocked&&!expired(generation.started_at,at,300000);
      const resultState=state('closed',at,{status:healthy?'healthy':'degraded',closed:!blocked,completed_at:healthy?at:null,backlog:Boolean(blocked),incomplete:blocked?observation.incomplete:false});
      const saved=await finish({phase:'list',pageCursor:'',scanStarted:true},resultState,{state:blocked?'pending':'completed',pageCursor:'',...proof});
      return {ok:saved,phase:'list',status:saved?resultState.status:'degraded',closed:resultState.closed,backlog:Boolean(blocked)};
    }
    if(checkpoint.phase==='detail'){
      const fetched=await provider.fetchInboundDetail({id:checkpoint.id,threadId:checkpoint.threadId}),verifiedAt=clock(),message=boundedMessage(fetched,checkpoint.id,checkpoint.threadId);
      observation.provider_verified_at=verifiedAt;observation.provider_failed=false;observation.incomplete=Boolean(message.incomplete);observation.backlog=Boolean(checkpoint.backlog||checkpoint.retry);
      const saved=await finish({...checkpoint,phase:'apply',message},state('apply',clock()));
      return {ok:saved,phase:'detail',status:saved?'scanning':'degraded',incomplete:Boolean(message.incomplete)};
    }
    if(typeof processReplies!=='function')throw Error('Missing inbox reply processor');
    const message=boundedMessage(checkpoint.message,checkpoint.id,checkpoint.threadId),view=scopedRepository(repo,job,generation,owner,checkpoint,clock);
    view.fence.messageId=message.id;
    // Keep the same mutable fence on both processor and final commit so a genuine
    // false alarm's unique check-in marker can finish the old round atomically.
    scoped.inboxFence=view.fence;
    const messages=[message];messages.backlog=Boolean(checkpoint.backlog||checkpoint.retry);messages.nextPageToken=checkpoint.retry||checkpoint.moreOnPage?checkpoint.pageCursor||'':checkpoint.nextPageToken||'';
    const summary=await processReplies({repo:view.repo,env,now:clock(),provider:{name:'gmail',async listInboundMessages(){return messages;}}});
    const after=await repo.db.prepare("SELECT confirmation_round,EXISTS(SELECT 1 FROM inbound_mail_log WHERE confirmation_round=owner.confirmation_round AND source='gmail' AND status IN ('failed','processing')) AS blocked,(SELECT status FROM inbound_mail_log WHERE gmail_message_id=?) AS message_status FROM owner WHERE id=1").bind(message.id).first(),at=clock();
    if(after?.confirmation_round!==generation.round){
      const saved=await finish({phase:'list',pageCursor:'',scanStarted:true},state('closed',at,{status:'degraded',closed:true}),{state:'completed'});
      return {...summary,ok:saved,phase:'apply',status:'degraded',closed:true,reason:'round-changed'};
    }
    const terminal=['processed','rejected','ignored'].includes(after.message_status),backlog=Boolean(summary.failed||summary.backlog||after.blocked||!terminal),closed=!backlog,healthy=closed&&!expired(generation.started_at,at,300000),next={phase:'list',pageCursor:summary.failed?checkpoint.pageCursor||'':view.page(),scanStarted:true};
    const resultState=state(closed?'closed':'list',at,{status:healthy?'healthy':'scanning',closed,completed_at:healthy?at:null,backlog,incomplete:Boolean(message.incomplete)});
    if(closed&&!healthy)resultState.status='degraded';
    const saved=await finish(next,resultState,{state:closed?'completed':'pending',pageCursor:next.pageCursor});
    return {...summary,ok:saved,phase:'apply',status:saved?resultState.status:'degraded',closed,backlog};
  }catch(error){
    const phase=checkpoint?.phase||'list',at=clock(),next={...(checkpoint||{phase:'list',pageCursor:''})};
    if(phase==='list'&&Number(error.statusCode||error.status)===400)next.pageCursor='';
    const saved=await finish(next,state(phase,at,{status:'failed',provider_failed:true}),{state:'failed',error:'inbox-'+phase+'-failed',delay:60000,...(next.pageCursor!==checkpoint?.pageCursor?{pageCursor:next.pageCursor}:{})});
    return {ok:false,phase,status:'failed',deferred:!saved,reason:'inbox-'+phase+'-failed'};
  }
}
