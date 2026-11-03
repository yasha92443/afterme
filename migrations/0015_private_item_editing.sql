ALTER TABLE encrypted_items ADD COLUMN updated_at TEXT;

UPDATE encrypted_items
SET updated_at = created_at
WHERE updated_at IS NULL;
