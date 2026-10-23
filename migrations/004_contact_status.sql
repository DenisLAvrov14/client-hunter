-- Contact availability, kept separate from outreach (legal) risk (docs/decisions.md).
-- Additive only: no rows are changed or removed. Inspections made before this migration keep
-- contact_status NULL, meaning "not determined" (phone links were not recorded back then).
ALTER TABLE inspections ADD COLUMN contact_status TEXT;  -- email|form_only|phone_or_messenger|none

-- From rules version 2026-10-23.2, every inspection also gets one outreach_risk row with
-- contact_id NULL: the risk of cold outreach to this recipient as such (market + recipient type),
-- independent of whether an email address was found. Rows with a contact_id refine it per address.
