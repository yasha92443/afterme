CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipients_email_normalized
ON recipients(lower(trim(email)));

ALTER TABLE encrypted_items ADD COLUMN recipient_id INTEGER REFERENCES recipients(id);

INSERT OR IGNORE INTO recipients (name, email, note, active, created_at, updated_at)
SELECT contacts.name, contacts.email, contacts.role, contacts.active,
       contacts.created_at, CURRENT_TIMESTAMP
FROM contacts
JOIN encrypted_items ON encrypted_items.recipient_contact_id = contacts.id
GROUP BY lower(trim(contacts.email));

UPDATE encrypted_items
SET recipient_id = (
  SELECT recipients.id
  FROM contacts
  JOIN recipients ON lower(trim(recipients.email)) = lower(trim(contacts.email))
  WHERE contacts.id = encrypted_items.recipient_contact_id
)
WHERE recipient_id IS NULL AND recipient_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_recipient ON encrypted_items(recipient_id);
