import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MarketCode } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import {
  currentContactChannels,
  emailRisks,
  recipientRisk,
  unconfirmedEmails,
  type ContactChannelRow,
  type RiskRow,
} from '../db/repo.js';
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

export interface CompanyReport extends CompanyReportRow {
  observations: ObservationRow[];
  /** Risk for the recipient as such (market + recipient type); null for inspections before rules 2026-10-23.2. */
  recipientRisk: RiskRow | null;
  /** Per-address refinements, lowest risk first. */
  emailRisks: RiskRow[];
  /** Current non-email channels (form page, phone, WhatsApp, Telegram), see currentContactChannels. */
  channels: ContactChannelRow[];
  /** Emails from earlier inspections whose page was not re-checked by the latest successful one. */
  unconfirmedEmails: { email: string; found_on_url: string }[];
  capabilities: string[];
}

export interface CandidatesReport {
  companies: CompanyReport[];
  funnel: { status: string; count: number }[];
  rejectReasons: { reason: string; count: number }[];
}

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
      recipientRisk: recipientRisk(db, c.id, c.last_inspection_id),
      emailRisks: emailRisks(db, c.id, c.last_inspection_id),
      channels: currentContactChannels(db, c.id),
      unconfirmedEmails: unconfirmedEmails(db, c.id),
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
    'best_email', 'best_email_risk', 'other_channels', 'verified', 'likely', 'capabilities', 'website',
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
      c.channels.map((ch) => `${ch.channel}:${ch.value}${ch.uncertain || !ch.confirmed ? '?' : ''}`).join(' '),
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

const CHANNEL_LABEL: Record<string, string> = { form: 'форма', phone: 'телефон', whatsapp: 'WhatsApp', telegram: 'Telegram' };

/** "телефон: +441614960000 (0161 496 0000) — источник: https://…" plus uncertainty / not re-checked marks. */
export function channelLine(ch: ContactChannelRow): string {
  const shown = ch.channel === 'phone' && ch.display && ch.display !== ch.value ? `${ch.value} (${ch.display})` : ch.value;
  const marks = [
    ch.uncertain && ch.note ? `⚠ ${ch.note}` : '',
    ch.confirmed ? '' : '⚠ не подтверждён последней проверкой (страница-источник не загружалась)',
  ].filter(Boolean);
  return `${CHANNEL_LABEL[ch.channel] ?? ch.channel}: ${shown} — источник: ${ch.source_url}${marks.length ? ` · ${marks.join(' · ')}` : ''}`;
}

const CONTACT_PAGE = /contact|kontakt|контакт|quote|offerte|zayavk|заявк/i;

/**
 * Report lines for a company's channels. A site-wide form (footer or header) is recorded once per
 * page it appears on; confirmed forms are shown as ONE line — the contact-like page first, the other
 * pages by path — instead of one line per page. Data stays as stored; this is presentation only.
 */
export function channelLines(channels: ContactChannelRow[]): string[] {
  const forms = channels.filter((c) => c.channel === 'form' && c.confirmed);
  const lines = channels.filter((c) => !forms.includes(c)).map(channelLine);
  if (forms.length === 1) lines.unshift(channelLine(forms[0]!));
  if (forms.length > 1) {
    const main = forms.find((f) => CONTACT_PAGE.test(new URL(f.value).pathname)) ?? forms[0]!;
    const others = forms.filter((f) => f !== main).map((f) => new URL(f.value).pathname);
    lines.unshift(`форма: ${main.value} — форма обращения есть на ${forms.length} страницах сайта (также ${others.join(', ')})`);
  }
  return lines;
}

export const UNCONFIRMED_EMAIL_NOTE = '⚠ не подтверждён последней проверкой (страница-источник не загружалась)';

export const RISK_LABEL: Record<string, string> = { low: '🟢 low', review_required: '🟡 review_required', high: '🔴 high' };

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
      lines.push(
        `- email: ${r.email}${r.is_freemail ? ' (публичная почта)' : ''} — источник: ${r.found_on_url ?? '—'}` +
          ` · риск адреса: ${RISK_LABEL[r.risk] ?? r.risk} — ${r.reason}`,
      );
    }
    for (const e of c.unconfirmedEmails) lines.push(`- email: ${e.email} — источник: ${e.found_on_url} · ${UNCONFIRMED_EMAIL_NOTE}`);
    for (const l of channelLines(c.channels)) lines.push(`- ${l}`);
    if (c.emailRisks.length === 0 && c.unconfirmedEmails.length === 0 && c.channels.length === 0) {
      lines.push('- каналов связи на сайте не найдено');
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
