-- Buyer-intent leads (docs/decisions.md, 2026-10-25): public requests where someone explicitly
-- wants to hire / pay for development work. A separate table on purpose: the old website-problem
-- analysis (companies, observations, assessments) infers opportunities; nothing here is inferred.
-- Additive only. Nothing is ever sent from this table.
CREATE TABLE intent_leads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- hn_freelance | hn_hiring | uk_contracts_finder
  source_item_id TEXT NOT NULL,    -- id of the request at the source (HN comment id, tender id)
  url TEXT NOT NULL,               -- exact original request URL
  published_at TEXT,               -- UTC ISO-8601, as published by the source
  author TEXT,                     -- as publicly identified at the source
  organisation TEXT,
  title TEXT,
  excerpt TEXT,                    -- start of the original text (capped)
  evidence_quote TEXT NOT NULL,    -- verbatim short quote showing the intent
  request_type TEXT NOT NULL,      -- direct_request | contract_role | rfp | vacancy | service_offer | recruiter | advice_only | irrelevant
  work_requested TEXT,
  technologies TEXT,               -- as stated, comma-separated
  budget TEXT,                     -- as stated
  deadline TEXT,                   -- as stated / source deadline
  location TEXT,
  geo TEXT NOT NULL,               -- open | target | restricted_other | unknown
  status TEXT NOT NULL,            -- open | closed | unknown (never inferred from the page being online)
  status_basis TEXT NOT NULL,
  engagement TEXT NOT NULL,        -- contractor | agency | employee | unknown
  contact_channel TEXT,            -- publicly permitted reply channel, as given at the source
  intent_confidence TEXT NOT NULL, -- high | medium | low (evidence of intent)
  skill_fit TEXT NOT NULL,         -- high | medium | low | none (match with our services)
  qualified INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,      -- why it qualifies or not (operator-facing)
  classifier TEXT NOT NULL,        -- rules | llm
  content_hash TEXT NOT NULL,      -- normalised request text, for de-duplication of reposts
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(source, source_item_id)
);
CREATE INDEX idx_intent_leads_hash ON intent_leads(content_hash);
CREATE INDEX idx_intent_leads_qualified ON intent_leads(qualified, published_at);
