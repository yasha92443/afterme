// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {DEFAULT_PREFERENCES} from './settings.js';
// One transaction and one remote round trip for the initial authenticated view.
export async function dashboardSnapshot(repo,env,retry=true) {
  const results=await repo.db.batch([
    repo.db.prepare('SELECT * FROM owner WHERE id=1'),
    repo.db.prepare('SELECT * FROM user_settings WHERE id=1'),
    repo.db.prepare('SELECT r.* FROM round_rules r JOIN owner o ON o.confirmation_round=r.round WHERE o.id=1'),
    repo.db.prepare('SELECT p.* FROM release_progress p JOIN owner o ON o.confirmation_round=p.round WHERE o.id=1'),
    repo.db.prepare(`SELECT
      (SELECT COUNT(*) FROM encrypted_items) AS letters,
      (SELECT COUNT(*) FROM public_farewell_groups_v2 WHERE draft_is_deleted=0) AS chapters,
      (SELECT COUNT(*) FROM contacts WHERE active=1) AS contacts,
      (SELECT COUNT(*) FROM confirmation_votes v JOIN contacts c ON c.id=v.contact_id JOIN round_rules r ON r.round=v.round JOIN owner o ON o.confirmation_round=v.round WHERE o.id=1 AND c.active=1 AND c.verification_round=v.round AND v.status='confirmed_death' AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.private.contact_ids'))) AS private,
      (SELECT COUNT(*) FROM confirmation_votes v JOIN contacts c ON c.id=v.contact_id JOIN round_rules r ON r.round=v.round JOIN owner o ON o.confirmation_round=v.round WHERE o.id=1 AND c.active=1 AND c.verification_round=v.round AND v.status='confirmed_death' AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.public.contact_ids'))) AS public`),
    repo.db.prepare("SELECT created_at FROM audit_log WHERE event_type='complete_backup_exported' ORDER BY id DESC LIMIT 1"),
    repo.db.prepare("SELECT (SELECT COUNT(*) FROM mail_claims WHERE status IN ('uncertain','failed')) AS outbound,(SELECT COUNT(*) FROM inbound_mail_log WHERE status='failed' AND confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1)) AS inbound"),
  ]);
  const first=i=>results[i].results?.[0]||null,owner=first(0),row=first(1),round=first(2);
  if(retry&&(!row.configured||(owner&&!round))){await repo.getSettings(env);if(owner)await repo.getRoundRules(owner);return dashboardSnapshot(repo,env,false);}
  const settings={revision:row.revision,active_rule_version:row.active_rule_version,pending_rule_version:row.pending_rule_version,preferences:{...DEFAULT_PREFERENCES,...JSON.parse(row.preferences_json)},active:JSON.parse(row.active_rules_json),pending:row.pending_rules_json?JSON.parse(row.pending_rules_json):null,mail_cap:Number(env.MAX_DAILY_EMAILS||20)};
  return {owner,settings,rules:round?JSON.parse(round.rules_json):settings.active,progress:results[3].results||[],counts:first(4),latestBackup:first(5),mailProblems:first(6)};
}
