-- Existing confirmation records remain historical; a new current vote must be
-- tied to a verification request issued in this round.
ALTER TABLE owner ADD COLUMN confirmation_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contacts ADD COLUMN verification_round INTEGER;
ALTER TABLE contacts ADD COLUMN verification_thread_id TEXT;
CREATE TABLE confirmation_votes (
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  round INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unable_to_reach','confirmed_death')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(contact_id, round)
);
ALTER TABLE encrypted_items ADD COLUMN revoked_at TEXT;
CREATE TABLE mail_claims (
  dedupe_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE runtime_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO mail_claims (dedupe_key, status, claimed_at)
SELECT dedupe_key, status, created_at FROM delivery_log WHERE status IN ('sent', 'dry_run');
CREATE INDEX idx_confirmation_round ON confirmation_votes(round, status);
