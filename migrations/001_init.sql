-- Initial schema, spec section 13. All timestamps are UTC ISO-8601; ids are prefixed text (cmp_, obs_, ...).

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  domain TEXT UNIQUE,              -- eTLD+1
  website_url TEXT,
  market TEXT NOT NULL,            -- UK|IE|NL|KZ|RU
  city TEXT,
  segment TEXT,                    -- S1|S2|S3|none
  business_type TEXT,
  platform TEXT,                   -- shopify|woocommerce|wix|tilda|bitrix|custom|unknown
  entity_type TEXT,                -- ltd|plc|llp|bv|nv|ooo|ao|too|sole_trader|unknown
  entity_evidence TEXT,
  registry_id TEXT,
  registry_status TEXT,
  registry_incorporated_on TEXT,
  size_hint TEXT,                  -- small|medium|large|unknown
  status TEXT NOT NULL,            -- статус конвейера (раздел 6)
  reject_reason TEXT,
  injection_suspected INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE company_sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  source_id TEXT NOT NULL,         -- osm|companies_house|adzuna|hh|csv|search
  source_ref TEXT,                 -- id/URL в источнике
  query TEXT,
  retrieved_at TEXT NOT NULL,
  terms_note TEXT
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  url TEXT NOT NULL,
  kind TEXT,                       -- home|contact|catalog|quote|about|product|other
  http_status INTEGER,
  fetched_at TEXT NOT NULL,
  content_hash TEXT,
  text_excerpt TEXT                -- обрезанный текст, не полный HTML
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,              -- PDF_CATALOG, MOBILE_OVERFLOW, ...
  status TEXT NOT NULL,            -- verified|likely|unknown
  description TEXT NOT NULL,       -- человекочитаемо
  evidence_url TEXT,
  evidence_detail TEXT,            -- фрагмент/число/селектор
  screenshot_path TEXT,
  collected_at TEXT NOT NULL
);

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL,              -- job_posting|new_location|new_site|other
  title TEXT,
  url TEXT,
  observed_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL,
  kind TEXT NOT NULL,              -- role|named
  role_hint TEXT,                  -- sales|info|support|...
  found_on_url TEXT NOT NULL,
  mx_ok INTEGER,
  status TEXT NOT NULL DEFAULT 'ok', -- ok|bounced|invalid
  created_at TEXT NOT NULL,
  UNIQUE(company_id, email)
);

CREATE TABLE dossiers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  version INTEGER NOT NULL,
  primary_offer TEXT,
  secondary_offer TEXT,
  payload_json TEXT NOT NULL,      -- полный ответ L2
  score INTEGER,
  score_breakdown_json TEXT,
  confidence TEXT,
  llm_call_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE outreach (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  dossier_id TEXT NOT NULL REFERENCES dossiers(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  step INTEGER NOT NULL,           -- 0 = первое письмо, 1.. = follow-up
  subject TEXT,
  body TEXT NOT NULL,
  edited_by_operator INTEGER DEFAULT 0,
  approved_at TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  message_id TEXT,
  status TEXT NOT NULL,            -- draft|approved|scheduled|sending|sent|dry_run_sent|cancelled|failed
  error TEXT
);

CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  outreach_id TEXT REFERENCES outreach(id),
  from_email TEXT,
  received_at TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  classification TEXT,             -- результат L3
  summary_ru TEXT,
  handled INTEGER DEFAULT 0
);

CREATE TABLE operator_decisions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  dossier_id TEXT,
  decision TEXT NOT NULL,          -- approve|edit|regenerate|reject|skip|never
  reason_code TEXT,
  reason_text TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  stage TEXT NOT NULL,             -- interested|call|proposal|won|lost
  offer TEXT,
  amount REAL,
  currency TEXT,
  payment_route TEXT,              -- произвольный текст, заполняет оператор
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE suppression (
  id TEXT PRIMARY KEY,
  domain TEXT,
  email TEXT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,            -- reply|command|button|bounce|import
  created_at TEXT NOT NULL
);
CREATE INDEX idx_suppression_domain ON suppression(domain);
CREATE INDEX idx_suppression_email ON suppression(email);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,           -- L1|L2|L3
  company_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  ok INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  params_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  discovered INTEGER DEFAULT 0,
  inspected INTEGER DEFAULT 0,
  rejected_auto INTEGER DEFAULT 0,
  queued INTEGER DEFAULT 0,
  llm_cost_usd REAL DEFAULT 0,
  errors_json TEXT
);

CREATE TABLE events (                -- аудит-лог всего значимого
  id TEXT PRIMARY KEY,
  company_id TEXT,
  type TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

-- Lookup indexes for pipeline stages (not in spec 13, no schema change).
CREATE INDEX idx_companies_status ON companies(market, status);
CREATE INDEX idx_company_sources_company ON company_sources(company_id);
CREATE INDEX idx_pages_company ON pages(company_id);
CREATE INDEX idx_observations_company ON observations(company_id);
CREATE INDEX idx_triggers_company ON triggers(company_id);
CREATE INDEX idx_dossiers_company ON dossiers(company_id, version);
CREATE INDEX idx_outreach_company ON outreach(company_id, step);
CREATE INDEX idx_outreach_message_id ON outreach(message_id);
CREATE INDEX idx_replies_company ON replies(company_id);
CREATE INDEX idx_llm_calls_created ON llm_calls(created_at);
CREATE INDEX idx_events_company ON events(company_id, created_at);
