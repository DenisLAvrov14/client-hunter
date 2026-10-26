// Persistence of buyer-intent requests (migrations/006_intent_leads.sql, 007_intent_buyer_fit.sql).
// One row per request at its source; a request seen again keeps its first_seen_at and gets the
// latest classification.
import type { Db } from '../db/connection.js';
import { newId } from '../util/ids.js';
import { contentHash } from './rank.js';
import type { ClassifiedRequest } from './types.js';

const EXCERPT_CHARS = 1200;
/** skill_fit (006, NOT NULL) keeps a coarse level; tech_fit (007) holds the capability-profile verdict. */
const SKILL_LEVEL = { core: 'high', adjacent: 'medium', conditional: 'low', poor: 'none' } as const;

export function saveRequests(db: Db, list: ClassifiedRequest[], now = new Date().toISOString()): { inserted: number; updated: number } {
  const exists = db.prepare('SELECT 1 FROM intent_leads WHERE source = ? AND source_item_id = ?');
  const upsert = db.prepare(`
    INSERT INTO intent_leads (id, source, source_item_id, url, published_at, author, organisation, title, excerpt, evidence_quote,
      request_type, work_requested, technologies, budget, deadline, location, geo, status, status_basis, engagement,
      contact_channel, intent_confidence, skill_fit, qualified, reasons_json, classifier, content_hash, first_seen_at, last_seen_at,
      buyer_category, tech_fit, remote, fit_areas)
    VALUES (@id, @source, @itemId, @url, @publishedAt, @author, @organisation, @title, @excerpt, @evidenceQuote,
      @requestType, @workRequested, @technologies, @budget, @deadline, @location, @geo, @status, @statusBasis, @engagement,
      @contactChannel, @intentConfidence, @skillFit, @qualified, @reasons, @classifier, @hash, @now, @now,
      @buyerCategory, @techFit, @remote, @fitAreas)
    ON CONFLICT(source, source_item_id) DO UPDATE SET
      url = excluded.url, published_at = excluded.published_at, author = excluded.author, organisation = excluded.organisation,
      title = excluded.title, excerpt = excluded.excerpt, evidence_quote = excluded.evidence_quote, request_type = excluded.request_type,
      work_requested = excluded.work_requested, technologies = excluded.technologies, budget = excluded.budget, deadline = excluded.deadline,
      location = excluded.location, geo = excluded.geo, status = excluded.status, status_basis = excluded.status_basis,
      engagement = excluded.engagement, contact_channel = excluded.contact_channel, intent_confidence = excluded.intent_confidence,
      skill_fit = excluded.skill_fit, qualified = excluded.qualified, reasons_json = excluded.reasons_json,
      classifier = excluded.classifier, content_hash = excluded.content_hash, last_seen_at = excluded.last_seen_at,
      buyer_category = excluded.buyer_category, tech_fit = excluded.tech_fit, remote = excluded.remote, fit_areas = excluded.fit_areas`);
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    for (const c of list) {
      if (exists.get(c.source, c.itemId)) updated++;
      else inserted++;
      upsert.run({
        id: newId('intentLead'),
        source: c.source,
        itemId: c.itemId,
        url: c.url,
        publishedAt: c.publishedAt,
        author: c.author,
        organisation: c.organisation,
        title: c.title,
        excerpt: c.text.slice(0, EXCERPT_CHARS),
        evidenceQuote: c.evidenceQuote,
        // Forum posts have no source-level type; their verdict is buyer_category.
        requestType: c.requestType ?? 'forum_post',
        workRequested: c.workRequested,
        technologies: c.technologies.join(', '),
        budget: c.budget ?? null,
        deadline: c.deadline ?? null,
        location: c.location,
        geo: c.geo,
        status: c.status,
        statusBasis: c.statusBasis,
        engagement: c.engagement,
        contactChannel: c.contactChannel,
        intentConfidence: c.intentConfidence,
        skillFit: SKILL_LEVEL[c.techFit],
        qualified: c.qualified ? 1 : 0,
        reasons: JSON.stringify(c.reasons),
        classifier: c.classifier,
        hash: contentHash(c),
        buyerCategory: c.buyerCategory,
        techFit: c.techFit,
        remote: c.remote,
        fitAreas: c.fitAreas.join(', '),
        now,
      });
    }
  })();
  return { inserted, updated };
}
