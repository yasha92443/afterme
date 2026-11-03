DROP TABLE IF EXISTS _afterme_contact_email_merge;

CREATE TABLE _afterme_contact_email_merge (
  duplicate_id INTEGER PRIMARY KEY,
  keeper_id INTEGER NOT NULL
);

INSERT INTO _afterme_contact_email_merge (duplicate_id, keeper_id)
SELECT
  contact.id,
  (
    SELECT MIN(candidate.id)
    FROM contacts AS candidate
    WHERE lower(trim(candidate.email)) = lower(trim(contact.email))
  )
FROM contacts AS contact
WHERE contact.id <> (
  SELECT MIN(candidate.id)
  FROM contacts AS candidate
  WHERE lower(trim(candidate.email)) = lower(trim(contact.email))
);

UPDATE contacts
SET
  active = (
    SELECT MAX(candidate.active)
    FROM contacts AS candidate
    WHERE lower(trim(candidate.email)) = lower(trim(contacts.email))
  ),
  priority = (
    SELECT MIN(candidate.priority)
    FROM contacts AS candidate
    WHERE lower(trim(candidate.email)) = lower(trim(contacts.email))
  )
WHERE id IN (SELECT keeper_id FROM _afterme_contact_email_merge);

UPDATE encrypted_items
SET recipient_contact_id = (
  SELECT keeper_id
  FROM _afterme_contact_email_merge
  WHERE duplicate_id = encrypted_items.recipient_contact_id
)
WHERE recipient_contact_id IN (SELECT duplicate_id FROM _afterme_contact_email_merge);

UPDATE encrypted_items
SET assignee_contact_id = (
  SELECT keeper_id
  FROM _afterme_contact_email_merge
  WHERE duplicate_id = encrypted_items.assignee_contact_id
)
WHERE assignee_contact_id IN (SELECT duplicate_id FROM _afterme_contact_email_merge);

INSERT OR IGNORE INTO confirmations (contact_id, status, note, created_at)
SELECT merge.keeper_id, confirmation.status, confirmation.note, confirmation.created_at
FROM confirmations AS confirmation
JOIN _afterme_contact_email_merge AS merge
  ON merge.duplicate_id = confirmation.contact_id;

DELETE FROM confirmations
WHERE contact_id IN (SELECT duplicate_id FROM _afterme_contact_email_merge);

DELETE FROM contacts
WHERE id IN (SELECT duplicate_id FROM _afterme_contact_email_merge);

DROP TABLE _afterme_contact_email_merge;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email_unique
ON contacts(lower(trim(email)));
