// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Public monitoring reads one privacy-safe row. Detailed diagnostics remain
// authenticated; scans are performed once per scheduled batch.
import {PUBLIC_DELIVERY_PROBLEMS_SQL} from './repository.js';
export async function refreshOperationalSnapshot(repo,env,now,evaluate) {
  if(!repo.db||!repo.setCursor)return;
  const row=await repo.db.prepare(`SELECT
    (SELECT created_at FROM audit_log WHERE event_type='scheduled_check_completed' ORDER BY id DESC LIMIT 1) AS scheduled_at,
    (SELECT details_json FROM audit_log WHERE event_type='scheduled_check_completed' ORDER BY id DESC LIMIT 1) AS scheduled_details,
    (SELECT COUNT(*) FROM mail_claims WHERE status='uncertain' OR (status='sending' AND julianday(claimed_at)<julianday(?)-15.0/1440)) AS blocked,
    (SELECT COUNT(*) FROM delivery_log WHERE status IN ('failed','uncertain') AND created_at>=(SELECT last_checkin_at FROM owner WHERE id=1)) AS outbound,
    (SELECT COUNT(*) FROM inbound_mail_log WHERE confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1) AND (status='failed' OR (status='processing' AND julianday(processed_at)<julianday(?)-15.0/1440))) AS inbound,
    (SELECT COUNT(*) FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id
      LEFT JOIN mail_claims m ON m.dedupe_key='private_letter_release:v2:'||i.id||':'||i.delivery_version||':'||lower(trim(COALESCE(r.email,c.email)))
      WHERE i.released_at IS NOT NULL AND i.revoked_at IS NULL AND COALESCE(r.active,c.active,0)=1
      AND EXISTS(SELECT 1 FROM owner WHERE id=1 AND state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') AND release_suspended=0)
      AND CASE WHEN json_valid(i.encrypted_payload) THEN json_extract(i.encrypted_payload,'$.mode')='link' AND COALESCE(m.status,'pending') NOT IN ('sent','dry_run') ELSE 0 END) AS private_problems,
    (${PUBLIC_DELIVERY_PROBLEMS_SQL}) AS public_problems,
    (SELECT created_at FROM delivery_log WHERE event_type='mail_healthcheck' AND status='sent' ORDER BY id DESC LIMIT 1) AS mail_check_at,
    (SELECT pause_mode FROM owner WHERE id=1) AS pause_mode,
    (SELECT preferences_json FROM user_settings WHERE id=1) AS preferences`).bind(now,now).first();
  let preferences={};try{preferences=JSON.parse(row.preferences||'{}');}catch{}
  const health={latestScheduled:row.scheduled_at?{created_at:row.scheduled_at,details_json:row.scheduled_details}:null,outboundProblemCount:row.outbound,inboundProblemCount:row.inbound,privateDeliveryProblemCount:row.private_problems,publicDeliveryProblemCount:row.public_problems,blockedMail:row.blocked?[true]:[],latestMailHealthcheck:row.mail_check_at?{created_at:row.mail_check_at}:null};
  const result=evaluate(health,new Date(now),env.MAIL_INBOUND_ENABLED!=='false',{mailHealthcheckEnabled:env.MAIL_PROVIDER!=='dry-run'&&(preferences.selfcheck??env.MAIL_HEALTHCHECK_ENABLED==='true'),verificationPath:env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'),paused:Boolean(row.pause_mode)});
  await repo.setCursor('public-health',JSON.stringify({...result,snapshot_at:now}));
}
export function readOperationalSnapshot(value,now=Date.now()) {
  let result;try{result=JSON.parse(value);}catch{}
  const age=now-Date.parse(result?.snapshot_at||'');
  if(!result||!Number.isFinite(age)||age<0||age>15*60000)return {ok:false,checks:{worker_reachable:true,cron_fresh:false},last_scheduled_at:result?.last_scheduled_at||null,cron_age_minutes:null};
  if(result.last_scheduled_at)result.cron_age_minutes=Math.round((now-Date.parse(result.last_scheduled_at))/6000)/10;
  return result;
}
