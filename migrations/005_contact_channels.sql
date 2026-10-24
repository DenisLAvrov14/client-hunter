-- Public business contact channels other than email (docs/decisions.md). Emails stay in
-- `contacts` (MX check, delivery status, outreach_risk rows refer to them). Additive only.
-- Nothing here is ever used to send or submit anything automatically.
CREATE TABLE contact_channels (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  channel TEXT NOT NULL,           -- form|phone|whatsapp|telegram
  value TEXT NOT NULL,             -- form page URL, phone (+E.164 only when certain, else as published), https://wa.me/<digits>, https://t.me/<username>
  match_key TEXT NOT NULL,         -- de-duplication key (for national-format phones: the assumed +E.164)
  uncertain INTEGER NOT NULL DEFAULT 0, -- 1 = value could not be confirmed (e.g. country of a national-format phone)
  note TEXT,                       -- what is uncertain, operator-facing
  display TEXT,                    -- as published on the site
  source_url TEXT NOT NULL,        -- page where it was first found
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_inspection_id TEXT REFERENCES inspections(id),
  UNIQUE(company_id, channel, match_key)
);
CREATE INDEX idx_contact_channels_inspection ON contact_channels(last_inspection_id);
