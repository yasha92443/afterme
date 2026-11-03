-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (c) 2026 yasha92443
CREATE TABLE admin_security (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
 secret_payload TEXT, pending_payload TEXT, pending_id TEXT, pending_expires INTEGER,
 last_counter INTEGER NOT NULL DEFAULT -1, revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO admin_security(id) VALUES(1);
CREATE TABLE admin_recovery_codes (code_hash TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, used_at INTEGER);
ALTER TABLE admin_sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_sessions ADD COLUMN security_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN verification_issued_at TEXT;
ALTER TABLE contacts ADD COLUMN verification_expires_at TEXT;
UPDATE contacts SET verification_issued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),verification_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days') WHERE verification_round IS NOT NULL;
CREATE TABLE verification_challenges (
 id TEXT PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id),
 round INTEGER NOT NULL, token_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 delivered INTEGER NOT NULL DEFAULT 0, used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX verification_challenge_contact ON verification_challenges(contact_id,created_at DESC);
CREATE TABLE verification_code_budget (day TEXT PRIMARY KEY,count INTEGER NOT NULL,last_id TEXT NOT NULL);
CREATE TABLE security_events (
 hour TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(hour,kind)
);
