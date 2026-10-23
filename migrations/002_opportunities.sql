-- Opportunity discovery (docs/decisions.md, 2026-10-23).
-- Inspection history so re-inspection never overwrites earlier evidence, cleaned page text for
-- business analysis, and outreach risk stored separately from commercial qualification.

CREATE TABLE inspections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  mode TEXT NOT NULL,              -- discover|reinspect
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result_status TEXT,              -- inspected|rejected_auto|error
  result_reason TEXT,
  capabilities_json TEXT           -- what the site already offers (cart, booking, quote form, ...)
);
CREATE INDEX idx_inspections_company ON inspections(company_id, started_at);

ALTER TABLE companies ADD COLUMN last_inspection_id TEXT;

-- Legacy rows (before 002) keep inspection_id NULL and only text_excerpt.
ALTER TABLE pages ADD COLUMN inspection_id TEXT;
ALTER TABLE pages ADD COLUMN main_text TEXT;     -- main content without nav/footer/boilerplate, capped
ALTER TABLE pages ADD COLUMN links_json TEXT;    -- internal links with anchor text, capped
CREATE INDEX idx_pages_inspection ON pages(inspection_id);

ALTER TABLE observations ADD COLUMN inspection_id TEXT;
CREATE INDEX idx_observations_inspection ON observations(inspection_id);

ALTER TABLE contacts ADD COLUMN is_freemail INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN last_seen_at TEXT;

-- Whether cold email to this contact may be lawful. Never affects qualification or ranking.
CREATE TABLE outreach_risk (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  inspection_id TEXT REFERENCES inspections(id),
  contact_id TEXT REFERENCES contacts(id),   -- NULL when no public contact was found
  jurisdiction TEXT NOT NULL,
  recipient_type TEXT NOT NULL,    -- company_confirmed|company_likely|sole_trader_confirmed|individual_likely|unknown
  risk TEXT NOT NULL,              -- low|review_required|high
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL,        -- high|medium|low
  unknowns_json TEXT NOT NULL,
  to_verify_json TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_outreach_risk_company ON outreach_risk(company_id, created_at);
