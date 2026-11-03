// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { createMailProvider,sendGuardedMail } from './mail.js';
import { invocationBudget } from './invocation-budget.js';
// Sample at most one event per kind/minute/isolate. Never persist request bodies,
// passwords, link tokens, query strings, or raw client addresses.
const seen=new Map();
export async function recordSecurityEvent(env,status,now=Date.now()){
  const kind=status===429?'rate_limit':status===401||status===403?'authorization_rejected':status>=500?'service_failure':null;
  if(!kind||!env.DB)return;
  const minute=Math.floor(now/60000),key=kind+':'+minute;if(seen.has(key))return;seen.set(key,true);
  for(const old of seen.keys())if(Number(old.split(':')[1])<minute-1)seen.delete(old);
  try{await env.DB.prepare('INSERT INTO security_events(hour,kind) VALUES(?,?) ON CONFLICT(hour,kind) DO UPDATE SET count=count+1').bind(new Date(now).toISOString().slice(0,13),kind).run();}catch{/* Error reporting must not replace the original response. */}
}
export async function sendSecurityAlerts(repo,env,now,provider=createMailProvider(env)){
  const budget=invocationBudget(env);if(provider.name==='dry-run'||(budget&&!budget.canStart(20,1)))return;
  const owner=await repo.getOwner();if(!owner)return;
  const events=(await repo.db.prepare('SELECT kind,SUM(count) AS count FROM security_events WHERE hour>=? GROUP BY kind').bind(new Date(Date.parse(now)-86400000).toISOString().slice(0,13)).all()).results;
  let snapshot={};try{snapshot=JSON.parse(await repo.getCursor('public-health')||'{}');}catch{}
  const relevant=events.filter(e=>e.kind==='service_failure'||e.count>=5);
  if(snapshot.checks?.gmail_inbound_healthy===false||snapshot.checks?.inbound_processing_healthy===false)relevant.push({kind:'inbox_degraded',count:1});
  if(snapshot.checks?.deliveries_healthy===false)relevant.push({kind:'outbound_degraded',count:1});
  if(relevant.length){
    const key=kind=>'security-alert:'+now.slice(0,10)+':'+kind,keys=relevant.map(e=>key(e.kind));
    const completed=new Set((await repo.db.prepare(`SELECT dedupe_key FROM mail_claims WHERE dedupe_key IN (${keys.map(()=>'?').join(',')}) AND status IN ('sent','dry_run','uncertain','sending')`).bind(...keys).all()).results.map(r=>r.dedupe_key));
    for(const event of relevant){
      if(completed.has(key(event.kind)))continue;
      const result=await sendGuardedMail({repo,env,provider,eventType:'security_alert',to:owner.email,subject:'AfterMe / security and service alert',text:`AfterMe observed ${event.kind} (${event.count} sampled events in the last 24 hours). This notice summarizes sampled event types and counts. Review the maintenance page and operational health for details.`,dedupeKey:key(event.kind),now});
      if(result.reason==='invocation-budget'||result.reason==='daily-cap')break;
    }
  }
  if(!budget||budget.canStart(3))await repo.db.batch([
    repo.db.prepare('DELETE FROM security_events WHERE hour<?').bind(new Date(Date.parse(now)-7*86400000).toISOString().slice(0,13)),
    repo.db.prepare('DELETE FROM verification_code_budget WHERE day<?').bind(new Date(Date.parse(now)-7*86400000).toISOString().slice(0,10)),
  ]);
}
