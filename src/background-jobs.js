// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {buildStoredPayload,openStoredPayload} from './content.js';
import {inboxWorkFence} from './inbox-fence.js';

const terminal="'completed','cancelled','uncertain'";
export async function sealJobValue(env,value){return buildStoredPayload({body:{plaintext:JSON.stringify(value)},env});}
export async function openJobValue(env,value){if(!value)return {};const opened=await openStoredPayload(value,env);if(opened.mode!=='link')throw Error('Invalid background job encryption');return JSON.parse(opened.plaintext);}
export async function enqueueJob(repo,env,{key,kind,round=null,payload={},now=new Date().toISOString(),next=now}){
  const encoded=await sealJobValue(env,payload),id=crypto.randomUUID();
  const fence=inboxWorkFence(repo,now,{processing:Boolean(repo.inboxFence)});
  const result=await repo.db.prepare(`INSERT INTO background_jobs(id,job_key,dedupe_key,kind,confirmation_round,payload,next_attempt_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${fence.sql}
    ON CONFLICT(job_key) DO UPDATE SET state='pending',payload=excluded.payload,checkpoint=NULL,confirmation_round=excluded.confirmation_round,lease_token=NULL,lease_until=NULL,attempt_id=NULL,next_attempt_at=excluded.next_attempt_at,last_error=NULL,updated_at=excluded.updated_at
    WHERE background_jobs.state='cancelled' AND NOT EXISTS(SELECT 1 FROM mail_claims m WHERE m.dedupe_key=background_jobs.dedupe_key AND m.status IN ('sending','sent','dry_run','uncertain')) RETURNING id`).bind(id,key,payload.dedupeKey||null,kind,round,encoded,next,now,now,...fence.args).first();
  return {id:result?.id||null,created:Boolean(result)};
}
export async function claimJob(repo,{now=new Date().toISOString(),kind=null,leaseSeconds=120}={}){
  const token=crypto.randomUUID(),until=new Date(Date.parse(now)+leaseSeconds*1000).toISOString();
  const eligible="state IN ('pending','running','failed') AND next_attempt_at<=? AND (lease_token IS NULL OR lease_until<=?)";
  return repo.db.prepare(`UPDATE background_jobs SET state='running',lease_token=?,lease_until=?,attempt_id=?,updated_at=? WHERE id=(SELECT id FROM background_jobs WHERE ${eligible} ${kind?'AND kind=?':''} ORDER BY next_attempt_at,created_at,id LIMIT 1) AND state NOT IN (${terminal}) AND (lease_token IS NULL OR lease_until<=?) RETURNING *`).bind(token,until,token,now,now,now,...(kind?[kind]:[]),now).first();
}
export async function checkpointJob(repo,env,job,{checkpoint,state='pending',error=null,next=new Date().toISOString(),now=new Date().toISOString()}={}){
  const encoded=checkpoint===undefined?job.checkpoint:await sealJobValue(env,checkpoint);
  const result=await repo.db.prepare(`UPDATE background_jobs SET state=?,checkpoint=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=? WHERE id=? AND lease_token=? AND state='running' AND (confirmation_round IS NULL OR confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1))`).bind(state,encoded,next,error,now,job.id,job.lease_token).run();
  return Boolean(result.meta?.changes);
}
export async function saveOwnedJob(repo,env,job,{checkpoint,now=new Date().toISOString()}={}){
  const encoded=await sealJobValue(env,checkpoint);
  const result=await repo.db.prepare("UPDATE background_jobs SET checkpoint=?,updated_at=? WHERE id=? AND lease_token=? AND state='running' AND lease_until>? AND (confirmation_round IS NULL OR confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1))").bind(encoded,now,job.id,job.lease_token,now).run();
  if(result.meta?.changes)job.checkpoint=encoded;
  return Boolean(result.meta?.changes);
}
export async function cancelObsoleteJobs(repo,now){return repo.db.prepare(`UPDATE background_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM mail_claims m WHERE m.dedupe_key=background_jobs.dedupe_key AND m.status IN ('sending','uncertain')) THEN 'uncertain' ELSE 'cancelled' END,lease_token=NULL,lease_until=NULL,last_error='round-changed',updated_at=? WHERE confirmation_round IS NOT NULL AND confirmation_round<>(SELECT confirmation_round FROM owner WHERE id=1) AND state NOT IN (${terminal})`).bind(now).run();}
export async function backgroundStatus(repo){return (await repo.db.prepare("SELECT kind,state,COUNT(*) AS count,MIN(created_at) AS oldest_at,MAX(updated_at) AS updated_at FROM background_jobs GROUP BY kind,state").all()).results;}
