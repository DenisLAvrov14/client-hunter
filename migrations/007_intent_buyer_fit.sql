-- Buyer category and technology fit against the Service Capability Profile (config/capabilities.yaml,
-- docs/decisions.md 2026-10-26). Additive only: existing rows keep their values and get NULLs here
-- until the next `npm run intent` reclassifies them. request_type keeps the source-level type.
ALTER TABLE intent_leads ADD COLUMN buyer_category TEXT; -- PROJECT_BUYER | SERVICE_RECOMMENDATION | POTENTIAL_BUYER | AGENCY_PARTNERSHIP | STAFFING | SERVICE_PROVIDER | IRRELEVANT
ALTER TABLE intent_leads ADD COLUMN tech_fit TEXT;       -- core | adjacent | conditional | poor
ALTER TABLE intent_leads ADD COLUMN remote TEXT;         -- permitted | prohibited | unknown (remote work from abroad, as the post says)
ALTER TABLE intent_leads ADD COLUMN fit_areas TEXT;      -- matched capability areas, comma-separated
