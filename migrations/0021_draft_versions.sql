-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (c) 2026 yasha92443
CREATE TABLE farewell_document_versions (
 id INTEGER PRIMARY KEY CHECK(id=1),
 draft_revision INTEGER NOT NULL DEFAULT 0,
 formal_revision INTEGER NOT NULL DEFAULT 0,
 pending_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_count>=0),
 write_token TEXT
);
INSERT INTO farewell_document_versions(id,formal_revision,pending_count)
 SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM public_farewell WHERE id=1) THEN 1 ELSE 0 END,
 (SELECT COUNT(*) FROM public_farewell_groups_v2 WHERE is_committed=0 OR title<>draft_title OR epigraph<>draft_epigraph OR sort_order<>draft_sort_order OR is_deleted<>draft_is_deleted)+
 (SELECT COUNT(*) FROM public_farewell_entries_v2 WHERE is_committed=0 OR body<>draft_body OR group_id<>draft_group_id OR is_public<>draft_is_public OR sort_order<>draft_sort_order OR is_deleted<>draft_is_deleted);
CREATE TRIGGER farewell_group_insert_revision AFTER INSERT ON public_farewell_groups_v2 BEGIN
 UPDATE farewell_document_versions SET draft_revision=draft_revision+1,pending_count=pending_count+(NEW.is_committed=0 OR NEW.title<>NEW.draft_title OR NEW.epigraph<>NEW.draft_epigraph OR NEW.sort_order<>NEW.draft_sort_order OR NEW.is_deleted<>NEW.draft_is_deleted) WHERE id=1;
END;
CREATE TRIGGER farewell_group_update_revision AFTER UPDATE ON public_farewell_groups_v2 BEGIN
 UPDATE farewell_document_versions SET draft_revision=draft_revision+1,pending_count=pending_count+(NEW.is_committed=0 OR NEW.title<>NEW.draft_title OR NEW.epigraph<>NEW.draft_epigraph OR NEW.sort_order<>NEW.draft_sort_order OR NEW.is_deleted<>NEW.draft_is_deleted)-(OLD.is_committed=0 OR OLD.title<>OLD.draft_title OR OLD.epigraph<>OLD.draft_epigraph OR OLD.sort_order<>OLD.draft_sort_order OR OLD.is_deleted<>OLD.draft_is_deleted) WHERE id=1;
END;
CREATE TRIGGER farewell_group_delete_revision AFTER DELETE ON public_farewell_groups_v2 BEGIN
 UPDATE farewell_document_versions SET draft_revision=draft_revision+1,pending_count=pending_count-(OLD.is_committed=0 OR OLD.title<>OLD.draft_title OR OLD.epigraph<>OLD.draft_epigraph OR OLD.sort_order<>OLD.draft_sort_order OR OLD.is_deleted<>OLD.draft_is_deleted) WHERE id=1;
END;
CREATE TRIGGER farewell_entry_insert_revision AFTER INSERT ON public_farewell_entries_v2 BEGIN
 UPDATE farewell_document_versions SET draft_revision=draft_revision+1,pending_count=pending_count+(NEW.is_committed=0 OR NEW.body<>NEW.draft_body OR NEW.group_id<>NEW.draft_group_id OR NEW.is_public<>NEW.draft_is_public OR NEW.sort_order<>NEW.draft_sort_order OR NEW.is_deleted<>NEW.draft_is_deleted) WHERE id=1;
END;
CREATE TRIGGER farewell_entry_update_revision AFTER UPDATE ON public_farewell_entries_v2 BEGIN
 UPDATE farewell_document_versions SET draft_revision=draft_revision+1,pending_count=pending_count+(NEW.is_committed=0 OR NEW.body<>NEW.draft_body OR NEW.group_id<>NEW.draft_group_id OR NEW.is_public<>NEW.draft_is_public OR NEW.sort_order<>NEW.draft_sort_order OR NEW.is_deleted<>NEW.draft_is_deleted)-(OLD.is_committed=0 OR OLD.body<>OLD.draft_body OR OLD.group_id<>OLD.draft_group_id OR OLD.is_public<>OLD.draft_is_public OR OLD.sort_order<>OLD.draft_sort_order OR OLD.is_deleted<>OLD.draft_is_deleted) WHERE id=1;
END;
CREATE TRIGGER farewell_entry_delete_revision AFTER DELETE ON public_farewell_entries_v2 BEGIN
 UPDATE farewell_document_versions SET draft_revision=draft_revision+1,pending_count=pending_count-(OLD.is_committed=0 OR OLD.body<>OLD.draft_body OR OLD.group_id<>OLD.draft_group_id OR OLD.is_public<>OLD.draft_is_public OR OLD.sort_order<>OLD.draft_sort_order OR OLD.is_deleted<>OLD.draft_is_deleted) WHERE id=1;
END;
