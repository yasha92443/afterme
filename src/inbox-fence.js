// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// A trusted per-invocation context, never a client-provided authorization token.
export function inboxWorkFence(repo,now,{processing=false,scanning=true}={}){
  const f=repo.inboxFence;if(!f)return {sql:'1',args:[]};
  if(typeof f.jobId!=='string'||typeof f.leaseToken!=='string'||typeof f.generationId!=='string'||!Number.isSafeInteger(f.round))throw Error('Invalid inbox work fence');
  const at=typeof f.clock==='function'?f.clock():now||f.now||new Date().toISOString();
  const changed=f.checkinMarker?" OR (o.confirmation_round=? AND EXISTS(SELECT 1 FROM user_settings WHERE id=1 AND save_id=?))":'';
  const args=[f.jobId,f.leaseToken,f.round,at,f.round,...(f.checkinMarker?[f.round+1,f.checkinMarker]:[]),f.generationId,f.round];
  let sql=`EXISTS(SELECT 1 FROM background_jobs j JOIN owner o ON o.id=1 JOIN runtime_cursors c ON c.key='background-inbox' WHERE j.id=? AND j.lease_token=? AND j.confirmation_round=? AND j.state='running' AND j.lease_until>? AND (o.confirmation_round=?${changed}) AND json_valid(c.value) AND json_extract(c.value,'$.generation_id')=? AND json_extract(c.value,'$.round')=?${scanning?" AND json_extract(c.value,'$.status')='scanning'":''})`;
  if(processing){
    if(typeof f.messageId!=='string'||!f.messageId)throw Error('Missing inbox message fence');
    sql+=" AND EXISTS(SELECT 1 FROM inbound_mail_log WHERE gmail_message_id=? AND confirmation_round=? AND status='processing')";args.push(f.messageId,f.round);
  }
  return {sql,args};
}
