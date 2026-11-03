// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Every tick owns a short lease and executes exactly one bounded stage. The
// control/maintenance timestamps are completions; inbox_at is a poll-attempt
// timestamp so an unavailable inbox cannot starve diagnostic/owner mail forever.
// Both the start and completion of the same healthy generation must be fresh.
export async function runBackgroundTick(repo,env,now,hooks){
  const token=crypto.randomUUID(),until=new Date(Date.parse(now)+120000).toISOString();
  const claimed=await repo.db.prepare('UPDATE background_scheduler SET lease_token=?,lease_until=? WHERE id=1 AND (lease_token IS NULL OR lease_until<=?)').bind(token,until,now).run();
  if(!claimed.meta?.changes)return {ok:true,stage:'leased',deferred:true};
  const state=await repo.db.prepare('SELECT * FROM background_scheduler WHERE id=1 AND lease_token=?').bind(token).first();
  let stage='idle',result={},error=null;
  const due=(value,ms)=>!value||Date.parse(now)-Date.parse(value)>=ms;
  try{
    if(due(state.control_at,240000)){stage='control';result=await hooks.control();}
    else if(due(state.inbox_at,240000)){stage='inbox';result=await hooks.inbox();}
    else if(due(state.maintenance_at,240000)){stage='maintenance';result=await hooks.maintenance();}
    else {
      // A large attachment cannot starve new notifications, discovery, or PDF
      // validation. Control and inbox deadlines always preempt this rotation.
      const kinds=['mail','validate','discover','release','notice','maintenance'];
      for(let offset=0;offset<kinds.length;offset++){
        const index=(state.next_kind+offset)%kinds.length,key=kinds[index];
        if(key==='maintenance')continue;
        if(hooks.available&&!await hooks.available(key))continue;
        stage=key;result=await hooks[key]();state.next_kind=(index+1)%kinds.length;break;
      }
    }
    return {ok:true,stage,result};
  }catch(err){error=err.name||'Error';throw err;}
  finally{
    await repo.db.prepare(`UPDATE background_scheduler SET lease_token=NULL,lease_until=NULL,control_at=CASE WHEN ?='control' AND ? IS NULL THEN ? ELSE control_at END,inbox_at=CASE WHEN ?='inbox' THEN ? ELSE inbox_at END,maintenance_at=CASE WHEN ?='maintenance' AND ? IS NULL THEN ? ELSE maintenance_at END,next_kind=?,last_stage=?,last_error=?,updated_at=? WHERE id=1 AND lease_token=?`)
      .bind(stage,error,now,stage,now,stage,error,now,state.next_kind,stage,error,now,token).run();
  }
}

export const BACKGROUND_LANE_CRONS=Object.freeze({inbox:'* * * * *',control:'*/2 * * * *',work:'1-59/2 * * * *'});
export function backgroundLaneForCron(cron){return Object.keys(BACKGROUND_LANE_CRONS).find(lane=>BACKGROUND_LANE_CRONS[lane]===cron)||null;}

// Separate trigger lanes give inbox phases a minute-by-minute slot without
// making state checks, maintenance, or an attachment wait behind that scan.
// Each lane has its own lease. A single UPDATE returns the claimed state so the
// normal scheduler path needs only a claim and a fenced completion round trip.
export async function runBackgroundLaneTick(repo,env,now,lane,hooks){
  if(!Object.hasOwn(BACKGROUND_LANE_CRONS,lane))throw new TypeError('Invalid background lane');
  const current=Date.parse(now);if(!Number.isFinite(current))throw new TypeError('Invalid background time');
  const token=crypto.randomUUID(),until=new Date(current+120000).toISOString();
  const state=await repo.db.prepare(`UPDATE background_lane_leases SET lease_token=?,lease_until=? WHERE lane=? AND (lease_token IS NULL OR lease_until<=?) RETURNING *`).bind(token,until,lane,now).first();
  if(!state)return {ok:true,lane,stage:'leased',deferred:true};
  let stage='idle',result={},error=null,report;
  const due=value=>!value||!Number.isFinite(Date.parse(value))||current-Date.parse(value)>=240000;
  try{
    if(lane==='inbox')stage='inbox';
    else if(lane==='control'){
      // Successful ticks alternate at two-minute intervals. After a failed
      // stage, still give the other stage its slot; completion timestamps stay
      // unchanged and continue to report the failure accurately.
      if(due(state.control_at)&&state.last_stage!=='control')stage='control';
      else if(due(state.maintenance_at)&&state.last_stage!=='maintenance')stage='maintenance';
      else stage=Number(state.next_kind)%2===1?'maintenance':'control';
      state.next_kind=stage==='control'?1:0;
    }else{
      const kinds=['mail','validate','discover','release','notice'];
      const available=hooks.availability?(await hooks.availability())??null:null;
      const allowed=key=>available instanceof Set?available.has(key):Boolean(available?.[key]);
      const start=((Number(state.next_kind)||0)%kinds.length+kinds.length)%kinds.length;
      for(let offset=0;offset<kinds.length;offset++){
        const index=(start+offset)%kinds.length,key=kinds[index];
        if(available!==null){if(!allowed(key))continue;}
        else if(hooks.available&&!await hooks.available(key))continue;
        stage=key;state.next_kind=(index+1)%kinds.length;break;
      }
    }
    if(stage!=='idle'){
      if(typeof hooks[stage]!=='function')throw new TypeError('Missing background stage');
      result=await hooks[stage]();
    }
    report={ok:true,lane,stage,result};return report;
  }catch(err){error=err?.name||'Error';throw err;}
  finally{
    const finished=await repo.db.prepare(`UPDATE background_lane_leases SET lease_token=NULL,lease_until=NULL,control_at=CASE WHEN ?='control' AND ? IS NULL THEN ? ELSE control_at END,inbox_at=CASE WHEN ?='inbox' THEN ? ELSE inbox_at END,maintenance_at=CASE WHEN ?='maintenance' AND ? IS NULL THEN ? ELSE maintenance_at END,next_kind=?,last_stage=?,last_error=?,updated_at=? WHERE lane=? AND lease_token=?`)
      .bind(stage,error,now,stage,now,stage,error,now,state.next_kind,stage,error,now,lane,token).run();
    if(report&&!finished.meta?.changes){report.ok=false;report.deferred=true;report.lease_lost=true;}
  }
}

export async function inboxAllowsDelivery(repo,env,round,now){
  const gmail=(env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&String(env.MAIL_INBOUND_ENABLED).trim().toLowerCase()!=='false';
  if(!gmail)return true;
  const row=await repo.db.prepare(`SELECT value FROM runtime_cursors WHERE key='background-inbox'`).first();
  let state;try{state=JSON.parse(row?.value||'');}catch{return false;}
  if(!inboxGenerationFresh(state,round,now))return false;
  return !await repo.hasBlockingInbound(round);
}

export function inboxGenerationFresh(state,round,now){
  if(!state||state.round!==round||state.status!=='healthy'||typeof state.generation_id!=='string'||!state.generation_id)return false;
  const current=Date.parse(now),started=Date.parse(state.started_at||''),completed=Date.parse(state.completed_at||'');
  return Number.isFinite(started)&&Number.isFinite(completed)&&started<=completed&&current>=completed&&current-started<=300000&&current-completed<=300000;
}

// Service monitoring answers whether the provider path and a bounded scan are
// still making verified progress. Final dispatch continues to use the stricter
// complete-generation proof above, even while this operational check is healthy.
export function inboxOperationallyHealthy(state,round,now,{blocked=false}={}){
  if(blocked||!state||Array.isArray(state)||!Number.isSafeInteger(round)||round<1||state.round!==round||typeof state.generation_id!=='string'||!state.generation_id||state.backlog!==false||state.incomplete!==false||state.provider_failed===true)return false;
  const current=Date.parse(now),provider=Date.parse(state.provider_verified_at||'');
  const fresh=(value,maxAge)=>Number.isFinite(current)&&Number.isFinite(value)&&current>=value&&current-value<=maxAge;
  if(!fresh(provider,300000))return false;
  // A healthy generation intentionally remains idle for several minutes. Its
  // completion need not acquire an artificial two-minute progress heartbeat.
  if(state.status==='healthy')return inboxGenerationFresh(state,round,now);
  if(state.status!=='scanning'||state.closed!==false||!['list','detail','apply'].includes(state.phase))return false;
  const started=Date.parse(state.started_at||''),observed=Date.parse(state.observed_at||'');
  return fresh(started,300000)&&fresh(observed,120000)&&started<=observed&&provider<=observed;
}
