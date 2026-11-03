ALTER TABLE owner ADD COLUMN timer_anchor_at TEXT;
ALTER TABLE owner ADD COLUMN pause_until TEXT;
ALTER TABLE owner ADD COLUMN pause_mode TEXT;
UPDATE owner SET timer_anchor_at = last_checkin_at;
ALTER TABLE contacts ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh';
ALTER TABLE recipients ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh';
CREATE TABLE user_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL DEFAULT 0,
  preferences_json TEXT NOT NULL DEFAULT '{}', active_rules_json TEXT NOT NULL,
  pending_rules_json TEXT, configured INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, save_id TEXT,
  active_rule_version INTEGER NOT NULL DEFAULT 0,pending_rule_version INTEGER
);
INSERT INTO user_settings (id, active_rules_json, updated_at)
VALUES (1, json_object('overdue_hours',48,'alert_hours',72,'verify_hours',120,
 'private',json_object('enabled',json('true'),'contact_ids',json((SELECT COALESCE(json_group_array(id),'[]') FROM contacts WHERE active=1)),'quorum',3,'grace_hours',72),
 'public',json_object('enabled',json('true'),'contact_ids',json((SELECT COALESCE(json_group_array(id),'[]') FROM contacts WHERE active=1)),'quorum',3,'grace_hours',72,'web',json('true'),'pdf',json('true'),'audience',json((SELECT COALESCE(json_group_array('contact:' || id),'[]') FROM contacts WHERE active=1)))), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE round_rules (round INTEGER PRIMARY KEY, rules_json TEXT NOT NULL, anchor_at TEXT NOT NULL, created_at TEXT NOT NULL,rule_version INTEGER NOT NULL DEFAULT 0);
INSERT INTO round_rules(round,rules_json,anchor_at,created_at) SELECT confirmation_round, active_rules_json, last_checkin_at, owner.updated_at FROM owner JOIN user_settings ON user_settings.id=1;
CREATE TABLE release_progress (
 round INTEGER NOT NULL REFERENCES round_rules(round), channel TEXT NOT NULL CHECK(channel IN ('private','public')),
 ready_at TEXT, released_at TEXT, PRIMARY KEY(round,channel)
);
INSERT INTO release_progress SELECT confirmation_round,'private',release_ready_at,CASE WHEN state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') THEN updated_at END FROM owner;
INSERT INTO release_progress SELECT confirmation_round,'public',release_ready_at,(SELECT auto_released_at FROM public_farewell WHERE id=1) FROM owner;
CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX idx_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE pdf_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'pending', cursor INTEGER NOT NULL DEFAULT 0, layout_key TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,lease_id TEXT,leased_at TEXT);
CREATE INDEX idx_items_directory ON encrypted_items(id DESC);
CREATE INDEX idx_entries_group_id ON public_farewell_entries_v2(group_id,id);
CREATE INDEX idx_entries_draft_order ON public_farewell_entries_v2(draft_group_id,draft_sort_order,id);
ALTER TABLE encrypted_items ADD COLUMN pdf_cache_key TEXT;
ALTER TABLE document_artifacts ADD COLUMN layout_key TEXT;
-- Retain historical public deliveries even when the PDF typography changes.
INSERT OR IGNORE INTO mail_claims (dedupe_key,status,claimed_at)
SELECT 'public_farewell_release:content:' || p.updated_at || ':contact:' || c.id, d.status, d.created_at
FROM delivery_log d JOIN contacts c ON lower(c.email)=lower(d.recipient_email) JOIN public_farewell p ON p.id=1
WHERE d.event_type='public_farewell_release' AND d.status IN ('sent','dry_run') AND julianday(d.created_at)>=julianday(p.updated_at);
