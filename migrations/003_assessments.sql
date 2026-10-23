-- LLM assessments (docs/decisions.md): stage B screening now, stage C deep analysis later.
-- input_hash = sha256(model + prompt version + digest), so unchanged input is never paid for twice.

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  inspection_id TEXT REFERENCES inspections(id),
  stage TEXT NOT NULL,             -- screen|deep
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  decision TEXT,                   -- screen: deep|maybe|skip
  payload_json TEXT NOT NULL,      -- validated model output
  validation_json TEXT NOT NULL,   -- issues found by code (unverifiable quotes, unknown ids, ...)
  llm_call_id TEXT REFERENCES llm_calls(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assessments_company ON assessments(company_id, stage, created_at);
CREATE INDEX idx_assessments_hash ON assessments(company_id, stage, input_hash);

CREATE INDEX idx_llm_calls_company ON llm_calls(company_id, created_at);
