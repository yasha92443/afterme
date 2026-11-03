ALTER TABLE public_farewell_groups_v2
  ADD COLUMN epigraph TEXT NOT NULL DEFAULT '';

ALTER TABLE public_farewell_groups_v2
  ADD COLUMN draft_epigraph TEXT NOT NULL DEFAULT '';

ALTER TABLE public_farewell_groups_v2
  ADD COLUMN epigraph_updated_at TEXT;
