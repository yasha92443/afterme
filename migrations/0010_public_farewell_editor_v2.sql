CREATE TABLE IF NOT EXISTS public_farewell_groups_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  draft_title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  draft_sort_order INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  draft_is_deleted INTEGER NOT NULL DEFAULT 0,
  is_committed INTEGER NOT NULL DEFAULT 1,
  title_updated_at TEXT NOT NULL,
  draft_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_farewell_entries_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  draft_group_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  draft_body TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  draft_is_public INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  draft_sort_order INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  draft_is_deleted INTEGER NOT NULL DEFAULT 0,
  is_committed INTEGER NOT NULL DEFAULT 1,
  body_updated_at TEXT NOT NULL,
  draft_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES public_farewell_groups_v2(id),
  FOREIGN KEY (draft_group_id) REFERENCES public_farewell_groups_v2(id)
);

INSERT INTO public_farewell_groups_v2 (
  title, draft_title, sort_order, draft_sort_order,
  is_deleted, draft_is_deleted, is_committed,
  title_updated_at, draft_updated_at, created_at
)
SELECT
  items.title,
  items.title,
  MIN(items.sort_order),
  MIN(items.sort_order),
  0,
  0,
  1,
  COALESCE(
    (
      SELECT MAX(audit_log.created_at)
      FROM audit_log
      WHERE audit_log.event_type = 'public_farewell_group_renamed'
        AND json_extract(audit_log.details_json, '$.new_title') = items.title
    ),
    MIN(items.created_at)
  ),
  MAX(items.updated_at),
  MIN(items.created_at)
FROM public_farewell_items AS items
GROUP BY items.title;

INSERT INTO public_farewell_entries_v2 (
  id, group_id, draft_group_id, body, draft_body,
  is_public, draft_is_public, sort_order, draft_sort_order,
  is_deleted, draft_is_deleted, is_committed,
  body_updated_at, draft_updated_at, created_at
)
SELECT
  items.id,
  groups.id,
  groups.id,
  items.body,
  items.body,
  CASE WHEN items.status = 'published' THEN 1 ELSE 0 END,
  CASE WHEN items.status = 'published' THEN 1 ELSE 0 END,
  items.entry_order,
  items.entry_order,
  0,
  0,
  1,
  COALESCE(
    (
      SELECT MAX(audit_log.created_at)
      FROM audit_log
      WHERE audit_log.event_type = 'public_farewell_item_upsert'
        AND CAST(json_extract(audit_log.details_json, '$.id') AS INTEGER) = items.id
    ),
    items.created_at
  ),
  items.updated_at,
  items.created_at
FROM public_farewell_items AS items
JOIN public_farewell_groups_v2 AS groups ON groups.title = items.title;

CREATE INDEX IF NOT EXISTS idx_farewell_groups_v2_draft_order
  ON public_farewell_groups_v2(draft_is_deleted, draft_sort_order, id);

CREATE INDEX IF NOT EXISTS idx_farewell_groups_v2_formal_order
  ON public_farewell_groups_v2(is_deleted, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_farewell_entries_v2_draft_order
  ON public_farewell_entries_v2(draft_group_id, draft_is_deleted, draft_sort_order, id);

CREATE INDEX IF NOT EXISTS idx_farewell_entries_v2_formal_order
  ON public_farewell_entries_v2(group_id, is_deleted, is_public, sort_order, id);
