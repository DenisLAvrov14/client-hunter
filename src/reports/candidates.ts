import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MarketCode } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import type { Capabilities } from '../inspect/capabilities.js';

interface CompanyReportRow {
  id: string;
  name: string | null;
  domain: string;
  website_url: string | null;
  city: string | null;
  segment: string | null;
  platform: string | null;
  entity_type: string | null;
  entity_evidence: string | null;
  registry_id: string | null;
  last_inspection_id: string | null;
  capabilities_json: string | null;
  contact_status: string | null;
}

interface ObservationRow {
  code: string;
  status: string;
  description: string;
  evidence_url: string | null;
  evidence_detail: string | null;
  screenshot_path: string | null;
}

interface RiskRow {
  email: string | null;
  is_freemail: number | null;
  risk: string;
  reason: string;
  recipient_type: string;
}

export interface CompanyReport extends CompanyReportRow {
  observations: ObservationRow[];
  /** Risk for the recipient as such (market + recipient type); null for inspections before rules 2026-10-23.2. */
  recipientRisk: RiskRow | null;
  /** Per-address refinements, lowest risk first. */
  emailRisks: RiskRow[];
  capabilities: string[];
}

export interface CandidatesReport {
  companies: CompanyReport[];
  funnel: { status: string; count: number }[];
  rejectReasons: { reason: string; count: number }[];
}

const RISK_ORDER = "CASE r.risk WHEN 'low' THEN 0 WHEN 'review_required' THEN 1 ELSE 2 END";
// Under rules 2026-10-23.1 a row without contact meant "no email found", not the recipient's risk.
const LEGACY_NO_EMAIL_RULES = '2026-10-23.1';

/**
 * Every usable inspected company of a market with the evidence of its latest inspection.
 * Companies inspected before migration 002 (status contact_found) are included until re-inspected.
 */
export function buildCandidatesReport(db: Db, market: MarketCode): CandidatesReport {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.domain, c.website_url, c.city, c.segment, c.platform, c.entity_type, c.entity_evidence,
              c.registry_id, c.last_inspection_id, i.capabilities_json, i.contact_status
       FROM companies c LEFT JOIN inspections i ON i.id = c.last_inspection_id
       WHERE c.market = ? AND c.status IN ('inspected', 'contact_found')
       ORDER BY c.segment, c.domain`,
    )
    .all(market) as CompanyReportRow[];

  const companies = rows.map((c): CompanyReport => {
    const caps = c.capabilities_json ? (JSON.parse(c.capabilities_json) as Capabilities) : null;
    return {
      ...c,
      observations: db
        .prepare(
          `SELECT code, status, description, evidence_url, evidence_detail, screenshot_path FROM observations
           WHERE company_id = ? AND inspection_id IS ?
           ORDER BY CASE status WHEN 'verified' THEN 0 WHEN 'likely' THEN 1 ELSE 2 END, code`,
        )
        .all(c.id, c.last_inspection_id) as ObservationRow[],
      recipientRisk:
        (db
          .prepare(
            `SELECT NULL AS email, NULL AS is_freemail, r.risk, r.reason, r.recipient_type FROM outreach_risk r
             WHERE r.company_id = ? AND r.inspection_id IS ? AND r.contact_id IS NULL AND r.rules_version != ?
             ORDER BY r.created_at DESC LIMIT 1`,
          )
          .get(c.id, c.last_inspection_id, LEGACY_NO_EMAIL_RULES) as RiskRow | undefined) ?? null,
      emailRisks: db
        .prepare(
          `SELECT k.email, k.is_freemail, r.risk, r.reason, r.recipient_type FROM outreach_risk r
           JOIN contacts k ON k.id = r.contact_id
           WHERE r.company_id = ? AND r.inspection_id IS ? ORDER BY ${RISK_ORDER}`,
        )
        .all(c.id, c.last_inspection_id) as RiskRow[],
      capabilities: caps ? Object.entries(caps.flags).filter(([, v]) => v.present).map(([k]) => k) : [],
    };
  });

  const funnel = db
    .prepare('SELECT status, COUNT(*) AS count FROM companies WHERE market = ? GROUP BY status ORDER BY count DESC')
    .all(market) as { status: string; count: number }[];

  // Group "site_unreachable: <details>" style reasons by their code.
  const rejectReasons = db
    .prepare(
      `SELECT CASE WHEN instr(reject_reason, ':') > 0 THEN substr(reject_reason, 1, instr(reject_reason, ':') - 1)
                   ELSE reject_reason END AS reason, COUNT(*) AS count
       FROM companies WHERE market = ? AND status = 'rejected_auto' GROUP BY reason ORDER BY count DESC`,
    )
    .all(market) as { reason: string; count: number }[];

  return { companies, funnel, rejectReasons };
}

function csvCell(v: string | null | undefined): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(report: CandidatesReport): string {
  const header = [
    'domain', 'name', 'city', 'segment', 'platform', 'entity', 'outreach_risk', 'contact_status',
    'best_email', 'best_email_risk', 'verified', 'likely', 'capabilities', 'website',
  ];
  const rows = report.companies.map((c) =>
    [
      c.domain,
      c.name,
      c.city,
      c.segment,
      c.platform,
      c.entity_type,
      c.recipientRisk?.risk ?? '',
      c.contact_status ?? '',
      c.emailRisks[0]?.email ?? '',
      c.emailRisks[0]?.risk ?? '',
      c.observations.filter((o) => o.status === 'verified').map((o) => o.code).join(' '),
      c.observations.filter((o) => o.status === 'likely').map((o) => o.code).join(' '),
      c.capabilities.join(' '),
      c.website_url,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

const RISK_LABEL: Record<string, string> = { low: '🟢 low', review_required: '🟡 review_required', high: '🔴 high' };

export function toMarkdown(report: CandidatesReport, market: MarketCode, generatedAt = new Date()): string {
  const withFindings = report.companies.filter((c) => c.observations.some((o) => o.status === 'verified')).length;
  const lines: string[] = [
    `# Проверенные компании — ${market}`,
    '',
    `Сформировано: ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · компаний: **${report.companies.length}**` +
      ` · с проверенными техническими находками: **${withFindings}**`,
    '',
    'Риск обращения (законность холодного письма) и доступность контакта — отдельная информация; на отбор компаний они не влияют.',
    '',
    '## Воронка',
    '',
    '| Статус | Компаний |',
    '|---|---|',
    ...report.funnel.map((f) => `| ${f.status} | ${f.count} |`),
    '',
  ];
  if (report.rejectReasons.length > 0) {
    lines.push('## Причины автоотказа', '', '| Причина | Компаний |', '|---|---|');
    lines.push(...report.rejectReasons.map((r) => `| ${r.reason} | ${r.count} |`), '');
  }
  lines.push('## Компании', '');
  for (const c of report.companies) {
    lines.push(`### ${c.name ?? c.domain} — ${c.domain}`, '');
    lines.push(
      `${c.segment ?? '?'} · ${c.city ?? '—'} · платформа: ${c.platform ?? '?'} · юрлицо: ${c.entity_type ?? '?'}` +
        (c.registry_id ? ` (№ ${c.registry_id})` : '') +
        ` · сайт: ${c.website_url ?? '—'}`,
    );
    if (c.entity_evidence) lines.push(`Признак юрлица: ${c.entity_evidence}`);
    lines.push(`Уже есть на сайте: ${c.capabilities.join(', ') || '—'}`);
    lines.push(
      c.recipientRisk
        ? `Риск обращения: ${RISK_LABEL[c.recipientRisk.risk] ?? c.recipientRisk.risk} — ${c.recipientRisk.reason}`
        : 'Риск обращения: не определён (проверка по старым правилам)',
    );
    lines.push(`Доступность контакта: ${c.contact_status ?? 'не определена (проверка до миграции 004)'}`);
    for (const r of c.emailRisks) {
      lines.push(`Email: ${r.email}${r.is_freemail ? ' (публичная почта)' : ''} · риск адреса: ${RISK_LABEL[r.risk] ?? r.risk} — ${r.reason}`);
    }
    lines.push('');
    for (const o of c.observations) {
      const mark = o.status === 'verified' ? '✅' : o.status === 'likely' ? '❔' : '·';
      lines.push(`- ${mark} **${o.code}** — ${o.description}${o.evidence_url ? ` ([страница](${o.evidence_url}))` : ''}`);
      if (o.evidence_detail) lines.push(`  - ${o.evidence_detail.split('\n').slice(0, 3).join(' · ')}`);
      if (o.screenshot_path) lines.push(`  - скриншот: \`${o.screenshot_path}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeCandidatesReport(
  db: Db,
  market: MarketCode,
  dataDir: string,
): { md: string; csv: string; report: CandidatesReport } {
  const report = buildCandidatesReport(db, market);
  const dir = path.resolve(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const md = path.join(dir, `companies-${market}-${stamp}.md`);
  const csv = path.join(dir, `companies-${market}-${stamp}.csv`);
  writeFileSync(md, toMarkdown(report, market));
  writeFileSync(csv, toCsv(report));
  return { md, csv, report };
}
