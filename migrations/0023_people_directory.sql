-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (c) 2026 yasha92443
CREATE TABLE people_links (
 contact_id INTEGER PRIMARY KEY REFERENCES contacts(id),
 recipient_id INTEGER NOT NULL UNIQUE REFERENCES recipients(id),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 write_token TEXT,
 legacy_contact INTEGER NOT NULL DEFAULT 0 CHECK(legacy_contact IN (0,1))
);

-- Preserve every existing row and ID. Match only normalized email identities.
INSERT OR IGNORE INTO recipients(name,email,note,active,created_at,updated_at,locale)
 SELECT c.name,c.email,c.role,c.active,c.created_at,c.created_at,c.locale FROM contacts c
 WHERE NOT EXISTS(SELECT 1 FROM recipients r WHERE lower(trim(r.email))=lower(trim(c.email)));
INSERT OR IGNORE INTO people_links(contact_id,recipient_id,legacy_contact)
 SELECT c.id,r.id,1 FROM contacts c JOIN recipients r ON lower(trim(r.email))=lower(trim(c.email));
INSERT OR IGNORE INTO contacts(name,email,role,priority,can_release,token_hash,active,created_at,locale)
 SELECT r.name,r.email,'contact',100,0,'people-mirror:'||lower(hex(randomblob(32))),r.active,r.created_at,r.locale FROM recipients r
 WHERE NOT EXISTS(SELECT 1 FROM contacts c WHERE lower(trim(c.email))=lower(trim(r.email)));
INSERT OR IGNORE INTO people_links(contact_id,recipient_id,legacy_contact)
 SELECT c.id,r.id,0 FROM contacts c JOIN recipients r ON lower(trim(r.email))=lower(trim(c.email));

CREATE TRIGGER people_contact_revision AFTER UPDATE OF name,email,role,priority,active,locale ON contacts
 WHEN OLD.name IS NOT NEW.name OR OLD.email IS NOT NEW.email OR OLD.role IS NOT NEW.role OR OLD.priority IS NOT NEW.priority OR OLD.active IS NOT NEW.active OR OLD.locale IS NOT NEW.locale
 BEGIN UPDATE people_links SET revision=revision+1 WHERE contact_id=NEW.id; END;
CREATE TRIGGER people_recipient_revision AFTER UPDATE OF name,email,note,active,locale ON recipients
 WHEN OLD.name IS NOT NEW.name OR OLD.email IS NOT NEW.email OR OLD.note IS NOT NEW.note OR OLD.active IS NOT NEW.active OR OLD.locale IS NOT NEW.locale
 BEGIN UPDATE people_links SET revision=revision+1 WHERE recipient_id=NEW.id; END;
