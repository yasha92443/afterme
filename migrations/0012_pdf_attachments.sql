CREATE TABLE IF NOT EXISTS document_artifacts (
  artifact_key TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE encrypted_items ADD COLUMN pdf_payload TEXT;
