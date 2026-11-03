-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (c) 2026 yasha92443
CREATE TABLE background_jobs (
 id TEXT PRIMARY KEY,
 job_key TEXT NOT NULL UNIQUE,
  dedupe_key TEXT,
 kind TEXT NOT NULL,
 confirmation_round INTEGER,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','cancelled','failed','uncertain')),
 payload TEXT NOT NULL,
 checkpoint TEXT,
 lease_token TEXT,
 lease_until TEXT,
 attempt_id TEXT,
 next_attempt_at TEXT NOT NULL,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_background_due ON background_jobs(state,next_attempt_at,kind);
CREATE INDEX idx_background_round ON background_jobs(confirmation_round,state);
CREATE TABLE background_scheduler (
 id INTEGER PRIMARY KEY CHECK(id=1),
 lease_token TEXT,
 lease_until TEXT,
 control_at TEXT,
 inbox_at TEXT,
 maintenance_at TEXT,
 next_kind INTEGER NOT NULL DEFAULT 0,
 last_stage TEXT,
 last_error TEXT,
 updated_at TEXT
);
INSERT INTO background_scheduler(id) VALUES(1);
-- Runtime-only leases are intentionally excluded from recovery snapshots.
CREATE TABLE background_lane_leases (
 lane TEXT PRIMARY KEY CHECK(lane IN ('inbox','control','work')),
 lease_token TEXT,
 lease_until TEXT,
 next_kind INTEGER NOT NULL DEFAULT 0,
 control_at TEXT,
 inbox_at TEXT,
 maintenance_at TEXT,
 last_stage TEXT,
 last_error TEXT,
 updated_at TEXT
);
INSERT INTO background_lane_leases(lane) VALUES('inbox'),('control'),('work');
ALTER TABLE mail_claims ADD COLUMN attempt_id TEXT;
ALTER TABLE mail_claims ADD COLUMN provider_message_id TEXT;
ALTER TABLE mail_claims ADD COLUMN provider_thread_id TEXT;
ALTER TABLE pdf_artifacts ADD COLUMN validation_state TEXT CHECK(validation_state IN ('validating','verified'));
ALTER TABLE pdf_artifacts ADD COLUMN validation_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pdf_artifacts ADD COLUMN validation_upload_revision INTEGER;
ALTER TABLE pdf_artifacts ADD COLUMN validation_manifest TEXT;
ALTER TABLE pdf_artifacts ADD COLUMN validation_algorithm TEXT;
ALTER TABLE pdf_artifacts ADD COLUMN validation_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pdf_artifacts ADD COLUMN validation_mac TEXT;
ALTER TABLE pdf_artifacts ADD COLUMN manifest_sha256 TEXT;
ALTER TABLE pdf_artifacts ADD COLUMN chunk_bytes INTEGER NOT NULL DEFAULT 131072 CHECK(chunk_bytes IN (16384,32768,65536,131072));
