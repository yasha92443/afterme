CREATE TABLE IF NOT EXISTS mail_templates (
  template_key TEXT PRIMARY KEY CHECK (template_key IN ('contact_alert', 'contact_verify', 'public_release', 'private_release')),
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
