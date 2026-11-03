-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (c) 2026 yasha92443
ALTER TABLE encrypted_items ADD COLUMN delivery_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE private_delivery_state ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE private_delivery_state ADD COLUMN next_attempt_at TEXT;
ALTER TABLE inbound_mail_log ADD COLUMN confirmation_round INTEGER;
ALTER TABLE inbound_mail_log ADD COLUMN source TEXT NOT NULL DEFAULT 'gmail';
ALTER TABLE inbound_mail_log ADD COLUMN contact_id INTEGER;
ALTER TABLE inbound_mail_log ADD COLUMN reconciled_at TEXT;
ALTER TABLE inbound_mail_log ADD COLUMN reconciliation_note TEXT;
UPDATE inbound_mail_log SET confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1)
WHERE COALESCE(received_at,processed_at)>=(SELECT COALESCE(timer_anchor_at,last_checkin_at) FROM owner WHERE id=1);
INSERT OR IGNORE INTO mail_claims(dedupe_key,status,claimed_at,last_error)
SELECT 'private_letter_release:v2:'||i.id||':0:'||lower(trim(COALESCE(r.email,c.email))),
 CASE WHEN m.status IN ('sent','dry_run') AND julianday(COALESCE(i.updated_at,i.created_at))>julianday(m.claimed_at) THEN 'uncertain' ELSE m.status END,m.claimed_at,
 CASE WHEN m.status IN ('sent','dry_run') AND julianday(COALESCE(i.updated_at,i.created_at))>julianday(m.claimed_at) THEN 'legacy-content-unverified' ELSE m.last_error END
FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id
JOIN mail_claims m ON m.dedupe_key='private_letter_release:'||i.id||':'||COALESCE(r.email,c.email);
INSERT OR IGNORE INTO mail_claims(dedupe_key,status,claimed_at,last_error)
SELECT m.dedupe_key||':email-'||lower(trim(d.recipient_email)),m.status,m.claimed_at,m.last_error
FROM mail_claims m JOIN delivery_log d ON d.dedupe_key=m.dedupe_key
WHERE d.event_type IN ('contact_verify','contact_alert') AND instr(m.dedupe_key,':email-')=0;
CREATE INDEX idx_inbound_round_source_status ON inbound_mail_log(confirmation_round,source,status,processed_at);
CREATE INDEX idx_private_delivery_retry ON private_delivery_state(next_attempt_at,item_id);
