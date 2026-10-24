// Builds the lead-qualification input from stored data only: latest successful inspection,
// latest stage B (screen) and stage C (deep) assessments, contacts and outreach risk. Read-only.
import type { Db } from '../db/connection.js';
import { emailRisks, latestSuccessfulInspection, protectedEmailPages, recipientRisk } from '../db/repo.js';
import type { DeepResult, ScreenResult, StatementT } from '../llm/schemas.js';
import type { CompanyInput, EvidenceItem, OpportunityInput } from './qualify.js';

interface CompanyRow {
  id: string;
  name: string | null;
  domain: string;
  website_url: string | null;
  market: string;
  status: string;
}

function statementEvidence(s: StatementT, presentCaps: Set<string>): EvidenceItem {
  const quote = s.evidence.find((e) => e.type === 'quote');
  const caps = s.evidence.filter((e) => e.type === 'capability');
  const absenceOnly = s.evidence.length > 0 && caps.length === s.evidence.length && caps.every((e) => !presentCaps.has(e.ref));
  const kind = s.kind === 'fact' ? 'fact' : s.kind === 'inference' ? 'inference' : 'hypothesis';
  return { kind, text: quote ? `${s.text} — «${quote.ref}»` : s.text, url: quote?.page_url || undefined, absenceOnly };
}

export function loadLeadInputs(db: Db): CompanyInput[] {
  const companies = db
    .prepare(`SELECT id, name, domain, website_url, market, status FROM companies WHERE status IN ('inspected', 'contact_found') ORDER BY market, domain`)
    .all() as CompanyRow[];
  return companies.map((c): CompanyInput => {
    const ins = latestSuccessfulInspection(db, c.id);
    const legacy = c.status === 'contact_found' || ins === null;
    const capsJson = ins ? (db.prepare('SELECT capabilities_json AS j FROM inspections WHERE id = ?').get(ins) as { j: string | null } | undefined)?.j : null;
    const presentCaps = new Set<string>(
      capsJson ? Object.entries((JSON.parse(capsJson) as { flags: Record<string, { present: boolean }> }).flags).filter(([, v]) => v.present).map(([k]) => k) : [],
    );
    const findings = db
      .prepare('SELECT id, code, status, evidence_url FROM observations WHERE company_id = ? AND inspection_id IS ? AND status IN (\'verified\', \'likely\')')
      .all(c.id, ins) as { id: string; code: string; status: 'verified' | 'likely'; evidence_url: string | null }[];
    const findingStatus = (id: string) =>
      (db.prepare('SELECT status FROM observations WHERE id = ?').get(id.trim()) as { status: string } | undefined)?.status;

    const opportunities: OpportunityInput[] = [];
    const screenRow = db
      .prepare(`SELECT payload_json AS p, validation_json AS v FROM assessments WHERE company_id = ? AND stage = 'screen' ORDER BY created_at DESC LIMIT 1`)
      .get(c.id) as { p: string; v: string } | undefined;
    const screen = screenRow ? (JSON.parse(screenRow.p) as ScreenResult) : null;
    const screenCheck = screenRow ? (JSON.parse(screenRow.v) as { opportunities: { hookVerified: boolean; alreadyPresent: string | null }[] }) : null;
    screen?.opportunities.forEach((o, i) => {
      const ck = screenCheck?.opportunities[i];
      let ev: EvidenceItem = { kind: 'none', text: '' };
      if (ck?.hookVerified && o.hook_type === 'quote') ev = { kind: 'quote', text: `«${o.hook}»`, url: o.hook_page_url || undefined };
      if (ck?.hookVerified && o.hook_type === 'finding') {
        const st = findingStatus(o.hook);
        ev = { kind: st === 'verified' ? 'finding_verified' : 'finding_likely', text: `находка ${o.hook}` };
      }
      opportunities.push({ source: 'screen', title: o.title, proposal: o.title, category: o.category, value: [o.why], evidence: [ev], openQuestions: screen.unknowns, duplicates: ck?.alreadyPresent ?? null });
    });

    const deepRow = db
      .prepare(`SELECT payload_json AS p, validation_json AS v FROM assessments WHERE company_id = ? AND stage = 'deep' ORDER BY created_at DESC LIMIT 1`)
      .get(c.id) as { p: string; v: string } | undefined;
    const deep = deepRow ? (JSON.parse(deepRow.p) as DeepResult) : null;
    const eligible = deepRow ? ((JSON.parse(deepRow.v) as { eligible?: boolean[] }).eligible ?? []) : [];
    deep?.opportunities.forEach((o, i) => {
      opportunities.push({
        source: 'deep',
        title: o.title,
        proposal: o.proposal,
        category: o.category,
        value: o.value.map((v) => v.text),
        evidence: o.observed.map((s) => statementEvidence(s, presentCaps)),
        openQuestions: o.open_questions,
        projectSize: o.project_size,
        alreadyExists: o.already_exists,
        eligible: eligible[i],
      });
    });

    const emails = ins
      ? emailRisks(db, c.id, ins)
      : (db.prepare(`SELECT email, is_freemail, found_on_url, NULL AS risk FROM contacts WHERE company_id = ? AND status = 'ok' AND mx_ok = 1 ORDER BY email`).all(c.id) as {
          email: string;
          is_freemail: number;
          found_on_url: string;
          risk: string | null;
        }[]);
    const best = emails.find((e) => !e.is_freemail) ?? emails[0];
    const rr = ins ? recipientRisk(db, c.id, ins) : null;
    const level = (rr?.risk ?? best?.risk ?? null) as CompanyInput['risk']['level'];
    const riskNote = rr ? rr.reason : best?.risk ? 'риск адреса по правилам до 2026-10-23.2 — пересчитать перепроверкой' : legacy ? 'не оценён: проверка фазы 1' : 'не определён';

    return {
      domain: c.domain,
      name: c.name ?? c.domain,
      website: c.website_url ?? `https://${c.domain}/`,
      market: c.market,
      business: screen
        ? {
            summary: screen.business_summary,
            type: screen.business_type,
            customers: screen.customers,
            activity: screen.commercial_activity,
            size: screen.size,
            isIt: screen.is_it_or_web_agency,
            decision: (db.prepare(`SELECT decision FROM assessments WHERE company_id = ? AND stage = 'screen' ORDER BY created_at DESC LIMIT 1`).get(c.id) as { decision: BusinessDecision }).decision,
            decisionReason: screen.decision_reason,
          }
        : null,
      deepRecommendation: deep?.recommendation ?? null,
      opportunities,
      technical: findings.map((f) => ({ code: f.code, status: f.status, url: f.evidence_url })),
      email: best ? { address: best.email!, freemail: !!best.is_freemail, source: best.found_on_url ?? '' } : null,
      emailHiddenOn: ins ? protectedEmailPages(db, ins) : [],
      risk: { level, note: riskNote },
      legacy,
    };
  });
}

type BusinessDecision = 'deep' | 'maybe' | 'skip';
