import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MarketCode } from '../config/schema.js';
import type { Db } from '../db/connection.js';

interface CandidateRow {
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
}

interface ObservationRow {
  code: string;
  status: string;
  description: string;
  evidence_url: string | null;
  evidence_detail: string | null;
  screenshot_path: string | null;
}

export interface CandidatesReport {
  candidates: (CandidateRow & { observations: ObservationRow[]; contacts: string[] })[];
  funnel: { status: string; count: number }[];
  rejectReasons: { reason: string; count: number }[];
}

export function buildCandidatesReport(db: Db, market: MarketCode): CandidatesReport {
  const candidates = (
    db
      .prepare(
        `SELECT id, name, domain, website_url, city, segment, platform, entity_type, entity_evidence, registry_id
         FROM companies WHERE market = ? AND status = 'contact_found' ORDER BY segment, domain`,
      )
      .all(market) as CandidateRow[]
  ).map((c) => ({
    ...c,
    observations: db
      .prepare(
        `SELECT code, status, description, evidence_url, evidence_detail, screenshot_path FROM observations
         WHERE company_id = ? ORDER BY CASE status WHEN 'verified' THEN 0 WHEN 'likely' THEN 1 ELSE 2 END, code`,
      )
      .all(c.id) as ObservationRow[],
    contacts: (
      db
        .prepare(
          `SELECT email FROM contacts WHERE company_id = ? AND mx_ok = 1
           ORDER BY CASE role_hint WHEN 'sales' THEN 0 WHEN 'enquiries' THEN 1 WHEN 'info' THEN 2 WHEN 'named' THEN 3 ELSE 4 END`,
        )
        .all(c.id) as { email: string }[]
    ).map((r) => r.email),
  }));

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

  return { candidates, funnel, rejectReasons };
}

function csvCell(v: string | null | undefined): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(report: CandidatesReport): string {
  const header = ['domain', 'name', 'city', 'segment', 'platform', 'entity', 'contact', 'verified', 'likely', 'website'];
  const rows = report.candidates.map((c) =>
    [
      c.domain,
      c.name,
      c.city,
      c.segment,
      c.platform,
      c.entity_type,
      c.contacts[0] ?? '',
      c.observations.filter((o) => o.status === 'verified').map((o) => o.code).join(' '),
      c.observations.filter((o) => o.status === 'likely').map((o) => o.code).join(' '),
      c.website_url,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

export function toMarkdown(report: CandidatesReport, market: MarketCode, generatedAt = new Date()): string {
  const lines: string[] = [
    `# Кандидаты — ${market}`,
    '',
    `Сформировано: ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · кандидатов: **${report.candidates.length}**`,
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
  lines.push('## Кандидаты', '');
  for (const c of report.candidates) {
    lines.push(`### ${c.name ?? c.domain} — ${c.domain}`, '');
    lines.push(
      `${c.segment ?? '?'} · ${c.city ?? '—'} · платформа: ${c.platform ?? '?'} · юрлицо: ${c.entity_type ?? '?'}` +
        (c.registry_id ? ` (№ ${c.registry_id})` : ''),
    );
    if (c.entity_evidence) lines.push(`Признак юрлица: ${c.entity_evidence}`);
    lines.push(`Контакт: ${c.contacts.join(', ') || '—'} · сайт: ${c.website_url ?? '—'}`, '');
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

export function writeCandidatesReport(db: Db, market: MarketCode, dataDir: string): { md: string; csv: string; report: CandidatesReport } {
  const report = buildCandidatesReport(db, market);
  const dir = path.resolve(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const md = path.join(dir, `candidates-${market}-${stamp}.md`);
  const csv = path.join(dir, `candidates-${market}-${stamp}.csv`);
  writeFileSync(md, toMarkdown(report, market));
  writeFileSync(csv, toCsv(report));
  return { md, csv, report };
}
