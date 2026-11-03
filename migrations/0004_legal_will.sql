CREATE TABLE IF NOT EXISTS legal_will (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'drafted', 'signed', 'notarized')),
  location TEXT NOT NULL DEFAULT '',
  custodian TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
