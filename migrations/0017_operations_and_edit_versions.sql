ALTER TABLE public_farewell_groups_v2 ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public_farewell_entries_v2 ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE encrypted_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE private_delivery_state (
  item_id INTEGER PRIMARY KEY REFERENCES encrypted_items(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL
);
-- These claims were cancelled before the provider submitted any message.
UPDATE mail_claims SET status = 'cancelled' WHERE status = 'skipped' AND last_error = 'state-changed';
CREATE INDEX idx_audit_type_id ON audit_log(event_type, id DESC);
CREATE INDEX idx_audit_type_time ON audit_log(event_type, created_at);
CREATE INDEX idx_delivery_status_time ON delivery_log(status, created_at);
CREATE INDEX idx_claim_status_time ON mail_claims(status, claimed_at);
CREATE INDEX idx_inbound_status_time ON inbound_mail_log(status, processed_at);
