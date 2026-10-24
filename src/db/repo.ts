import { createHash } from 'node:crypto';
import type { MarketCode, SegmentCode } from '../config/schema.js';
import type { ContactChannel } from '../contacts/channels.js';
import type { ContactCandidate } from '../contacts/extract.js';
import type { Capabilities } from '../inspect/capabilities.js';
import type { PageLink } from '../inspect/extract.js';
import type { ObservationDraft, PageContext } from '../inspect/types.js';
import type { ContactStatus } from '../outreach/contactStatus.js';
import { LEGACY_NO_EMAIL_RULES_VERSION, type RiskAssessment } from '../outreach/risk.js';
import type { CandidateCompany } from '../sources/types.js';
import { registrableDomain } from '../util/domain.js';
import { newId } from '../util/ids.js';
import type { Db } from './connection.js';

const now = () => new Date().toISOString();

export type CompanyStatus =
  | 'discovered'
  | 'website_resolved'
  | 'entity_checked'
  | 'inspected' // final state of a successful inspection since migration 002
  | 'contact_found' // legacy final state (before 002): had a contact and a verified finding
  | 'rejected_auto'
  | 'error';

export interface CompanyRow {
  id: string;
  name: string | null;
  domain: string;
  website_url: string | null;
  market: MarketCode;
  city: string | null;
  segment: SegmentCode | null;
  platform: string | null;
  entity_type: string | null;
  entity_evidence: string | null;
  registry_id: string | null;
  registry_status: string | null;
  status: CompanyStatus;
  reject_reason: string | null;
  last_inspection_id: string | null;
}

export function isSuppressed(db: Db, domain: string): boolean {
  return db.prepare('SELECT 1 FROM suppression WHERE domain = ? LIMIT 1').get(domain) !== undefined;
}

/** Inserts a discovered company, deduplicated by eTLD+1 (spec 7.4). Always records the source. */
export function upsertDiscovered(
  db: Db,
  c: CandidateCompany,
  ctx: { market: MarketCode; segment: SegmentCode; sourceId: string; termsNote: string },
): { id: string; created: boolean } | null {
  const domain = registrableDomain(c.websiteUrl);
  if (!domain) return null;
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM companies WHERE domain = ?').get(domain) as { id: string } | undefined;
    const id = existing?.id ?? newId('company');
    if (!existing) {
      db.prepare(
        `INSERT INTO companies (id, name, domain, website_url, market, city, segment, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`,
      ).run(id, c.name, domain, c.websiteUrl, ctx.market, c.city, ctx.segment, now(), now());
    }
    db.prepare(
      `INSERT INTO company_sources (id, company_id, source_id, source_ref, query, retrieved_at, terms_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId('companySource'), id, ctx.sourceId, c.sourceRef, c.query, now(), ctx.termsNote);
    return { id, created: !existing };
  })();
}

export function companiesToProcess(db: Db, market: MarketCode, segment: SegmentCode, limit: number): CompanyRow[] {
  return db
    .prepare(
      `SELECT * FROM companies WHERE market = ? AND segment = ? AND status = 'discovered' ORDER BY random() LIMIT ?`,
    )
    .all(market, segment, limit) as CompanyRow[];
}

export function updateCompany(db: Db, id: string, fields: Partial<Omit<CompanyRow, 'id'>>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE companies SET ${set}, updated_at = @updated_at WHERE id = @id`).run({
    ...fields,
    id,
    updated_at: now(),
  });
}

export function setStatus(db: Db, id: string, status: CompanyStatus, rejectReason: string | null = null): void {
  updateCompany(db, id, { status, reject_reason: rejectReason });
  logEvent(db, id, `status:${status}`, rejectReason ? { reason: rejectReason } : null);
}

/** Opens an inspection record; every page/observation/risk row of this run points to it. */
export function startInspection(db: Db, companyId: string, mode: 'discover' | 'reinspect'): string {
  const id = newId('inspection');
  db.prepare('INSERT INTO inspections (id, company_id, mode, started_at) VALUES (?, ?, ?, ?)').run(id, companyId, mode, now());
  return id;
}

export function finishInspection(
  db: Db,
  id: string,
  result: {
    status: CompanyStatus;
    reason: string | null;
    capabilities: Capabilities | null;
    contactStatus: ContactStatus | null;
  },
): void {
  db.prepare(
    `UPDATE inspections SET finished_at = ?, result_status = ?, result_reason = ?, capabilities_json = ?, contact_status = ?
     WHERE id = ?`,
  ).run(
    now(),
    result.status,
    result.reason,
    result.capabilities ? JSON.stringify(result.capabilities) : null,
    result.contactStatus,
    id,
  );
}

export function insertPage(
  db: Db,
  companyId: string,
  inspectionId: string,
  page: PageContext,
  extracted: { mainText: string; links: PageLink[] },
): void {
  db.prepare(
    `INSERT INTO pages (id, company_id, inspection_id, url, kind, http_status, fetched_at, content_hash, text_excerpt, main_text, links_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('page'),
    companyId,
    inspectionId,
    page.url,
    page.kind,
    page.status,
    now(),
    createHash('sha256').update(page.html).digest('hex'),
    page.text.slice(0, 2000),
    extracted.mainText,
    JSON.stringify(extracted.links),
  );
}

export function insertObservation(db: Db, companyId: string, inspectionId: string, o: ObservationDraft): string {
  const id = newId('observation');
  db.prepare(
    `INSERT INTO observations (id, company_id, inspection_id, code, status, description, evidence_url, evidence_detail, screenshot_path, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    companyId,
    inspectionId,
    o.code,
    o.status,
    o.description,
    o.evidenceUrl ?? null,
    o.evidenceDetail ?? null,
    o.screenshotPath ?? null,
    now(),
  );
  return id;
}

/** Inserts or refreshes a contact; never touches its delivery status (bounced stays bounced). Returns its id. */
export function upsertContact(db: Db, companyId: string, c: ContactCandidate, mxOk: boolean): string {
  db.prepare(
    `INSERT INTO contacts (id, company_id, email, kind, role_hint, found_on_url, mx_ok, status, created_at, is_freemail, last_seen_at)
     VALUES (@id, @companyId, @email, @kind, @roleHint, @foundOnUrl, @mxOk, 'ok', @now, @isFreemail, @now)
     ON CONFLICT(company_id, email) DO UPDATE SET
       kind = excluded.kind, role_hint = excluded.role_hint, mx_ok = excluded.mx_ok,
       is_freemail = excluded.is_freemail, last_seen_at = excluded.last_seen_at`,
  ).run({
    id: newId('contact'),
    companyId,
    email: c.email,
    kind: c.kind,
    roleHint: c.roleHint,
    foundOnUrl: c.foundOnUrl,
    mxOk: mxOk ? 1 : 0,
    isFreemail: c.isFreemail ? 1 : 0,
    now: now(),
  });
  return (db.prepare('SELECT id FROM contacts WHERE company_id = ? AND email = ?').get(companyId, c.email) as { id: string }).id;
}

/**
 * Records a non-email contact channel, keyed by match_key. A channel seen again keeps its first
 * source and first_seen_at; last_seen_at / last_inspection_id move, and an uncertain value is
 * replaced by a certain one (never the other way round). Returns its id.
 */
export function upsertContactChannel(db: Db, companyId: string, inspectionId: string, c: ContactChannel): string {
  db.prepare(
    `INSERT INTO contact_channels (id, company_id, channel, value, match_key, uncertain, note, display, source_url,
       first_seen_at, last_seen_at, last_inspection_id)
     VALUES (@id, @companyId, @channel, @value, @matchKey, @uncertain, @note, @display, @sourceUrl, @now, @now, @inspectionId)
     ON CONFLICT(company_id, channel, match_key) DO UPDATE SET
       last_seen_at = excluded.last_seen_at, last_inspection_id = excluded.last_inspection_id,
       value = CASE WHEN excluded.uncertain = 0 THEN excluded.value ELSE contact_channels.value END,
       note = CASE WHEN excluded.uncertain = 0 THEN NULL ELSE contact_channels.note END,
       uncertain = MIN(contact_channels.uncertain, excluded.uncertain),
       display = COALESCE(contact_channels.display, excluded.display)`,
  ).run({
    id: newId('contactChannel'),
    companyId,
    inspectionId,
    now: now(),
    channel: c.channel,
    value: c.value,
    matchKey: c.matchKey,
    uncertain: c.uncertain ? 1 : 0,
    note: c.note,
    display: c.display,
    sourceUrl: c.sourceUrl,
  });
  return (
    db
      .prepare('SELECT id FROM contact_channels WHERE company_id = ? AND channel = ? AND match_key = ?')
      .get(companyId, c.channel, c.matchKey) as { id: string }
  ).id;
}

/**
 * Stores pages read on demand by stage C under a separate 'supplement' inspection, so they are
 * kept as evidence without changing what the latest real inspection loaded (contact logic).
 */
export function recordSupplementPages(
  db: Db,
  companyId: string,
  pages: { page: PageContext; mainText: string }[],
): string | null {
  if (pages.length === 0) return null;
  const id = newId('inspection');
  db.prepare(
    `INSERT INTO inspections (id, company_id, mode, started_at, finished_at, result_status) VALUES (?, ?, 'deep_pages', ?, ?, 'supplement')`,
  ).run(id, companyId, now(), now());
  for (const p of pages) insertPage(db, companyId, id, p.page, { mainText: p.mainText, links: [] });
  return id;
}

/** The most recent inspection that finished successfully; failed or rejected ones say nothing about contacts. */
export function latestSuccessfulInspection(db: Db, companyId: string): string | null {
  const row = db
    .prepare(`SELECT id FROM inspections WHERE company_id = ? AND result_status = 'inspected' ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get(companyId) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface ContactChannelRow {
  channel: string;
  value: string;
  uncertain: number;
  note: string | null;
  display: string | null;
  source_url: string;
  first_seen_at: string;
  /** 1 = seen in the latest successful inspection; 0 = its source page was not re-checked there. */
  confirmed: number;
}

/**
 * Current non-email channels of a company, judged by its latest successful inspection:
 * seen there → confirmed; seen earlier and its source page was NOT loaded there → kept as
 * unconfirmed (an incomplete check is not evidence it disappeared); seen earlier but its
 * source page was loaded and it was gone → not current.
 */
export function currentContactChannels(db: Db, companyId: string): ContactChannelRow[] {
  const latest = latestSuccessfulInspection(db, companyId);
  if (!latest) return [];
  return db
    .prepare(
      `SELECT ch.channel, ch.value, ch.uncertain, ch.note, ch.display, ch.source_url, ch.first_seen_at,
              (ch.last_inspection_id IS @latest) AS confirmed
       FROM contact_channels ch
       WHERE ch.company_id = @companyId
         AND (ch.last_inspection_id IS @latest
              OR NOT EXISTS (SELECT 1 FROM pages p WHERE p.inspection_id = @latest AND p.url = ch.source_url))
       ORDER BY confirmed DESC, CASE ch.channel WHEN 'form' THEN 0 WHEN 'phone' THEN 1 WHEN 'whatsapp' THEN 2 ELSE 3 END, ch.value`,
    )
    .all({ companyId, latest }) as ContactChannelRow[];
}

/**
 * Emails by the same rule as currentContactChannels: an email has an outreach_risk row for every
 * inspection it was seen in; one not seen in the latest successful inspection is kept (unconfirmed)
 * only if the page it was found on was not loaded there.
 */
export function unconfirmedEmails(db: Db, companyId: string): { email: string; found_on_url: string }[] {
  const latest = latestSuccessfulInspection(db, companyId);
  if (!latest) return [];
  return db
    .prepare(
      `SELECT k.email, k.found_on_url FROM contacts k
       WHERE k.company_id = @companyId AND k.mx_ok = 1 AND k.status = 'ok'
         AND NOT EXISTS (SELECT 1 FROM outreach_risk r WHERE r.contact_id = k.id AND r.inspection_id = @latest)
         AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.inspection_id = @latest AND p.url = k.found_on_url)
       ORDER BY k.email`,
    )
    .all({ companyId, latest }) as { email: string; found_on_url: string }[];
}

export interface RiskRow {
  email: string | null;
  is_freemail: number | null;
  found_on_url: string | null;
  risk: string;
  reason: string;
  recipient_type: string;
}

/**
 * Risk for the recipient as such (market + recipient type) at one inspection; null when there is
 * none, including inspections assessed under the legacy rules where a row without contact meant
 * "no email found". Contact availability is separate (inspectionContactStatus).
 */
export function recipientRisk(db: Db, companyId: string, inspectionId: string | null): RiskRow | null {
  return (
    (db
      .prepare(
        `SELECT NULL AS email, NULL AS is_freemail, NULL AS found_on_url, r.risk, r.reason, r.recipient_type FROM outreach_risk r
         WHERE r.company_id = ? AND r.inspection_id IS ? AND r.contact_id IS NULL AND r.rules_version != ?
         ORDER BY r.created_at DESC LIMIT 1`,
      )
      .get(companyId, inspectionId, LEGACY_NO_EMAIL_RULES_VERSION) as RiskRow | undefined) ?? null
  );
}

/** Per-address risk refinements at one inspection, lowest risk first. */
export function emailRisks(db: Db, companyId: string, inspectionId: string | null): RiskRow[] {
  return db
    .prepare(
      `SELECT k.email, k.is_freemail, k.found_on_url, r.risk, r.reason, r.recipient_type FROM outreach_risk r
       JOIN contacts k ON k.id = r.contact_id
       WHERE r.company_id = ? AND r.inspection_id IS ?
       ORDER BY CASE r.risk WHEN 'low' THEN 0 WHEN 'review_required' THEN 1 ELSE 2 END, k.email`,
    )
    .all(companyId, inspectionId) as RiskRow[];
}

/**
 * Pages of an inspection where the site hides an email behind anti-harvesting protection
 * (Cloudflare "email protection"). Only reported for manual lookup — never decoded or fetched.
 */
export function protectedEmailPages(db: Db, inspectionId: string | null): string[] {
  return (
    db
      .prepare(
        `SELECT url FROM pages WHERE inspection_id IS ?
           AND (main_text LIKE '%[email%protected]%' OR links_json LIKE '%/cdn-cgi/l/email-protection%')
         ORDER BY url`,
      )
      .all(inspectionId) as { url: string }[]
  ).map((r) => r.url);
}

export function inspectionContactStatus(db: Db, inspectionId: string | null): string | null {
  const row = db.prepare('SELECT contact_status FROM inspections WHERE id IS ?').get(inspectionId) as { contact_status: string | null } | undefined;
  return row?.contact_status ?? null;
}

export function observationById(db: Db, id: string): { code: string; status: string; evidence_url: string | null } | null {
  return (db.prepare('SELECT code, status, evidence_url FROM observations WHERE id = ?').get(id) as
    | { code: string; status: string; evidence_url: string | null }
    | undefined) ?? null;
}

export function insertOutreachRisk(
  db: Db,
  companyId: string,
  inspectionId: string,
  contactId: string | null,
  r: RiskAssessment,
  rulesVersion: string,
): void {
  db.prepare(
    `INSERT INTO outreach_risk (id, company_id, inspection_id, contact_id, jurisdiction, recipient_type, risk, reason,
       confidence, unknowns_json, to_verify_json, rules_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('outreachRisk'),
    companyId,
    inspectionId,
    contactId,
    r.jurisdiction,
    r.recipientType,
    r.risk,
    r.reason,
    r.confidence,
    JSON.stringify(r.unknowns),
    JSON.stringify(r.toVerify),
    rulesVersion,
    now(),
  );
}

/** Companies by registrable domain, in the given order; unknown domains are returned separately. */
export function companiesByDomain(db: Db, domains: string[]): { found: CompanyRow[]; missing: string[] } {
  const found: CompanyRow[] = [];
  const missing: string[] = [];
  for (const d of domains) {
    const domain = registrableDomain(d) ?? d.toLowerCase();
    const row = db.prepare('SELECT * FROM companies WHERE domain = ?').get(domain) as CompanyRow | undefined;
    if (!row) missing.push(d);
    else if (!found.some((c) => c.id === row.id)) found.push(row);
  }
  return { found, missing };
}

/** Companies whose earlier inspection ended in one of `reasons` (or a legacy candidate), for re-inspection. */
export function companiesForReinspection(
  db: Db,
  opts: {
    markets: MarketCode[];
    reasons: string[];
    includeLegacyCandidates: boolean;
    limit: number;
    random?: boolean;
    /** Re-inspect companies already inspected under the new rules (e.g. after an extraction fix). */
    refresh?: boolean;
  },
): CompanyRow[] {
  if (opts.refresh) {
    return db
      .prepare(
        `SELECT * FROM companies WHERE market IN (${opts.markets.map(() => '?').join(', ')})
           AND status = 'inspected' AND last_inspection_id IS NOT NULL
         ORDER BY ${opts.random ? 'random()' : 'market, domain'} LIMIT ?`,
      )
      .all(...opts.markets, opts.limit) as CompanyRow[];
  }
  const reasonClauses = opts.reasons.map(() => `(status = 'rejected_auto' AND (reject_reason = ? OR reject_reason LIKE ? || ':%'))`);
  if (opts.includeLegacyCandidates) reasonClauses.push(`status = 'contact_found'`);
  if (reasonClauses.length === 0) return [];
  const params = opts.reasons.flatMap((r) => [r, r]);
  return db
    .prepare(
      `SELECT * FROM companies
       WHERE market IN (${opts.markets.map(() => '?').join(', ')})
         AND last_inspection_id IS NULL
         AND (${reasonClauses.join(' OR ')})
       ORDER BY ${opts.random ? 'random()' : 'market, domain'} LIMIT ?`,
    )
    .all(...opts.markets, ...params, opts.limit) as CompanyRow[];
}

export function logEvent(db: Db, companyId: string | null, type: string, data: unknown): void {
  db.prepare('INSERT INTO events (id, company_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
    newId('event'),
    companyId,
    type,
    data === null ? null : JSON.stringify(data),
    now(),
  );
}

export function startRun(db: Db, params: unknown): string {
  const id = newId('run');
  db.prepare('INSERT INTO runs (id, params_json, started_at) VALUES (?, ?, ?)').run(id, JSON.stringify(params), now());
  return id;
}

export function finishRun(
  db: Db,
  id: string,
  stats: { discovered: number; inspected: number; rejected_auto: number; errors: string[] },
): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, discovered = ?, inspected = ?, rejected_auto = ?, errors_json = ? WHERE id = ?`,
  ).run(now(), stats.discovered, stats.inspected, stats.rejected_auto, JSON.stringify(stats.errors), id);
}
