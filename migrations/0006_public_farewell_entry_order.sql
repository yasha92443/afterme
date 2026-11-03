ALTER TABLE public_farewell_items ADD COLUMN entry_order INTEGER NOT NULL DEFAULT 100;

-- Existing entries keep their original creation order within each title.
UPDATE public_farewell_items
SET entry_order = id * 10
WHERE entry_order = 100;

CREATE INDEX IF NOT EXISTS idx_public_farewell_items_title_entry_order
  ON public_farewell_items(title, entry_order, id);