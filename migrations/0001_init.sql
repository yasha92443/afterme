CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'NORMAL',
  last_checkin_at TEXT NOT NULL,
  release_suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'contact',
  priority INTEGER NOT NULL DEFAULT 100,
  can_release INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS encrypted_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('letter', 'task', 'privacy')),
  title TEXT NOT NULL,
  recipient_contact_id INTEGER,
  assignee_contact_id INTEGER,
  release_stage TEXT NOT NULL DEFAULT 'PRIVATE_RELEASE',
  encrypted_payload TEXT NOT NULL,
  payload_size INTEGER NOT NULL,
  vault_token TEXT NOT NULL UNIQUE,
  vault_token_hash TEXT NOT NULL UNIQUE,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipient_contact_id) REFERENCES contacts(id),
  FOREIGN KEY (assignee_contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unable_to_reach', 'confirmed_death', 'false_alarm')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(contact_id, status),
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS delivery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'sent', 'skipped', 'failed')),
  dedupe_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_active_priority ON contacts(active, priority);
CREATE INDEX IF NOT EXISTS idx_items_release ON encrypted_items(release_stage, released_at);
CREATE INDEX IF NOT EXISTS idx_delivery_created ON delivery_log(created_at);
CREATE INDEX IF NOT EXISTS idx_confirmations_contact ON confirmations(contact_id);
