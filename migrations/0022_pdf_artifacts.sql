-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (c) 2026 yasha92443
CREATE TABLE pdf_artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('private','public')),
  item_id INTEGER NOT NULL DEFAULT 0,
  source_revision TEXT NOT NULL,
  layout_key TEXT NOT NULL,
  locale TEXT NOT NULL CHECK(locale IN ('zh','en','ru')),
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed','stale')),
  total_bytes INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  upload_revision INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pdf_artifact_source ON pdf_artifacts(kind,item_id,locale,source_revision,layout_key,status);
CREATE TABLE pdf_artifact_chunks (
  artifact_id TEXT NOT NULL REFERENCES pdf_artifacts(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=131072),
  PRIMARY KEY(artifact_id,chunk_index)
);
-- Retain receipts for the current formal content when adopting monotonic
-- document versions. A legacy key identifies the audience, not its email;
-- successful delivery to the current address needs a matching delivery log.
INSERT OR IGNORE INTO mail_claims(dedupe_key,status,claimed_at,last_error)
SELECT 'public_farewell_release:v2:'||v.formal_revision||':'||p.updated_at||':contact:'||c.id||':'||lower(trim(c.email)),
 CASE WHEN m.status IN ('sent','dry_run') AND NOT EXISTS(SELECT 1 FROM delivery_log d WHERE d.dedupe_key=m.dedupe_key AND d.event_type='public_farewell_release' AND d.status=m.status AND lower(trim(d.recipient_email))=lower(trim(c.email))) THEN 'uncertain' ELSE m.status END,m.claimed_at,
 CASE WHEN m.status IN ('sent','dry_run') AND NOT EXISTS(SELECT 1 FROM delivery_log d WHERE d.dedupe_key=m.dedupe_key AND d.event_type='public_farewell_release' AND d.status=m.status AND lower(trim(d.recipient_email))=lower(trim(c.email))) THEN 'legacy-recipient-unverified' ELSE m.last_error END
FROM mail_claims m JOIN public_farewell p ON p.id=1 JOIN farewell_document_versions v ON v.id=1 JOIN contacts c
ON m.dedupe_key='public_farewell_release:content:'||p.updated_at||':contact:'||c.id;
INSERT OR IGNORE INTO mail_claims(dedupe_key,status,claimed_at,last_error)
SELECT 'public_farewell_release:v2:'||v.formal_revision||':'||p.updated_at||':recipient:'||r.id||':'||lower(trim(r.email)),
 CASE WHEN m.status IN ('sent','dry_run') AND NOT EXISTS(SELECT 1 FROM delivery_log d WHERE d.dedupe_key=m.dedupe_key AND d.event_type='public_farewell_release' AND d.status=m.status AND lower(trim(d.recipient_email))=lower(trim(r.email))) THEN 'uncertain' ELSE m.status END,m.claimed_at,
 CASE WHEN m.status IN ('sent','dry_run') AND NOT EXISTS(SELECT 1 FROM delivery_log d WHERE d.dedupe_key=m.dedupe_key AND d.event_type='public_farewell_release' AND d.status=m.status AND lower(trim(d.recipient_email))=lower(trim(r.email))) THEN 'legacy-recipient-unverified' ELSE m.last_error END
FROM mail_claims m JOIN public_farewell p ON p.id=1 JOIN farewell_document_versions v ON v.id=1 JOIN recipients r
ON m.dedupe_key='public_farewell_release:content:'||p.updated_at||':recipient:'||r.id;
