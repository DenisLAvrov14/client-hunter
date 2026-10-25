// Persistence of buyer-intent requests (migrations/006_intent_leads.sql). One row per request at
// its source; a request seen again keeps its first_seen_at and gets the latest classification.
import type { Db } from '../db/connection.js';
import { newId } from '../util/ids.js';
import { contentHash } from './rank.js';
import type { ClassifiedRequest } from './types.js';

const EXCERPT_CHARS = 1200;

export function saveRequests(db: Db, list: ClassifiedRequest[], now = new Date().toISOString()): { inserted: number; updated: number } {
  const exists = db.prepare('SELECT 1 FROM intent_leads WHERE source = ? AND source_item_id = ?');
  const upsert = db.prepare(`
    INSERT INTO intent_leads (id, source, source_item_id, url, published_at, author, organisation, title, excerpt, evidence_quote,
      request_type, work_requested, technologies, budget, deadline, location, geo, status, status_basis, engagement,
      contact_channel, intent_confidence, skill_fit, qualified, reasons_json, classifier, content_hash, first_seen_at, last_seen_at)
    VALUES (@id, @source, @itemId, @url, @publishedAt, @author, @organisation, @title, @excerpt, @evidenceQuote,
      @requestType, @workRequested, @technologies, @budget, @deadline, @location, @geo, @status, @statusBasis, @engagement,
      @contactChannel, @intentConfidence, @skillFit, @qualified, @reasons, @classifier, @hash, @now, @now)
    ON CONFLICT(source, source_item_id) DO UPDATE SET
      url = excluded.url, published_at = excluded.published_at, author = excluded.author, organisation = excluded.organisation,
      title = excluded.title, excerpt = excluded.excerpt, evidence_quote = excluded.evidence_quote, request_type = excluded.request_type,
      work_requested = excluded.work_requested, technologies = excluded.technologies, budget = excluded.budget, deadline = excluded.deadline,
      location = excluded.location, geo = excluded.geo, status = excluded.status, status_basis = excluded.status_basis,
      engagement = excluded.engagement, contact_channel = excluded.contact_channel, intent_confidence = excluded.intent_confidence,
      skill_fit = excluded.skill_fit, qualified = excluded.qualified, reasons_json = excluded.reasons_json,
      classifier = excluded.classifier, content_hash = excluded.content_hash, last_seen_at = excluded.last_seen_at`);
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
        requestType: c.requestType,
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
        skillFit: c.skillFit,
        qualified: c.qualified ? 1 : 0,
        reasons: JSON.stringify(c.reasons),
        classifier: c.classifier,
        hash: contentHash(c),
        now,
      });
    }
  })();
  return { inserted, updated };
}
