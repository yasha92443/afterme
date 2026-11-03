CREATE TABLE IF NOT EXISTS inbound_mail_log (
  gmail_message_id TEXT PRIMARY KEY,
  gmail_thread_id TEXT,
  sender_email TEXT NOT NULL DEFAULT '',
  recipient_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  command TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'rejected', 'ignored', 'failed')),
  details_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_mail_processed_at
ON inbound_mail_log(processed_at);