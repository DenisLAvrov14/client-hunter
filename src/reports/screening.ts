// Markdown report of a screening run, for the operator's review of the experiment (plan §12).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import {
  currentContactChannels,
  inspectionContactStatus,
  latestSuccessfulInspection,
  recipientRisk,
  unconfirmedEmails,
} from '../db/repo.js';
import { channelLines, UNCONFIRMED_EMAIL_NOTE } from './candidates.js';
import { SAMPLE_GROUP_LABELS, type SampleGroup } from '../llm/sample.js';
import type { ScreenResult } from '../llm/schemas.js';
import type { OpportunityCheck } from '../llm/validate.js';

export interface ScreenedRef {
  id: string;
  group?: SampleGroup;
}

interface Row {
  id: string;
  name: string | null;
  domain: string;
  market: string;
  website_url: string | null;
  status: string;
  reject_reason: string | null;
  decision: string;
  payload_json: string;
  validation_json: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

const DECISION_ORDER = ['deep', 'maybe', 'skip'];
const RISK_LABEL: Record<string, string> = { low: '🟢 low', review_required: '🟡 review_required', high: '🔴 high' };
const CATEGORY_LABEL: Record<string, string> = { website_rescue: 'A · сайт', business_improvement: 'B · бизнес' };

export function buildScreeningReport(db: Db, refs: ScreenedRef[], meta: { runCost: number; runCalls: number }): string {
  const groups = new Map(refs.map((r) => [r.id, r.group]));
  const rows: Row[] = [];
  for (const { id } of refs) {
    const row = db
      .prepare(
        `SELECT c.id, c.name, c.domain, c.market, c.website_url, c.status, c.reject_reason, a.decision, a.payload_json, a.validation_json,
                l.cost_usd, l.input_tokens, l.output_tokens
         FROM assessments a JOIN companies c ON c.id = a.company_id LEFT JOIN llm_calls l ON l.id = a.llm_call_id
         WHERE a.company_id = ? AND a.stage = 'screen' ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(id) as Row | undefined;
    if (row) rows.push(row);
  }
  rows.sort((a, b) => DECISION_ORDER.indexOf(a.decision) - DECISION_ORDER.indexOf(b.decision) || a.domain.localeCompare(b.domain));

  const count = (d: string, g?: SampleGroup) =>
    rows.filter((r) => r.decision === d && (g === undefined || groups.get(r.id) === g)).length;
  const allOpps = rows.flatMap((r) => (JSON.parse(r.validation_json) as { opportunities: OpportunityCheck[] }).opportunities);
  const verified = allOpps.filter((o) => o.hookVerified).length;
  const duplicates = allOpps.filter((o) => o.alreadyPresent).length;
  const withIssues = rows.filter((r) => (JSON.parse(r.validation_json) as { issues: string[] }).issues.length > 0).length;

  const lines: string[] = [
    '# Эксперимент: отбор компаний через Claude Haiku (этап B)',
    '',
    `Сформировано: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · компаний: **${rows.length}**` +
      ` · вызовов API в прогоне: ${meta.runCalls} · стоимость прогона: **$${meta.runCost.toFixed(4)}**`,
    '',
    '## Итог',
    '',
    `| Решение | Всего | ${Object.values(SAMPLE_GROUP_LABELS).join(' | ')} |`,
    `|---|---|${Object.keys(SAMPLE_GROUP_LABELS).map(() => '---').join('|')}|`,
    ...DECISION_ORDER.map(
      (d) => `| ${d} | ${count(d)} | ${(Object.keys(SAMPLE_GROUP_LABELS) as SampleGroup[]).map((g) => count(d, g)).join(' | ')} |`,
    ),
    '',
    `- Предложений всего: ${allOpps.length}; с проверенной зацепкой (цитата найдена на сайте или настоящая находка): **${verified}**`,
    `- Похоже на то, что на сайте уже есть: ${duplicates}`,
    `- Компаний с замечаниями проверки: ${withIssues}`,
    '',
    '**Как оценивать:** у каждой компании отметь, полезно ли главное предложение (`полезно` / `шаблонно` / `не подходит`) и верно ли модель поняла бизнес. ✓ — зацепка проверена кодом на сайте, ✗ — не проверена или её нет.',
    '',
  ];

  for (const r of rows) {
    const p = JSON.parse(r.payload_json) as ScreenResult;
    const v = JSON.parse(r.validation_json) as { opportunities: OpportunityCheck[]; issues: string[] };
    const g = groups.get(r.id);
    // Contacts and risk come from the latest SUCCESSFUL inspection: a failed one says nothing about them.
    const lastOk = latestSuccessfulInspection(db, r.id);
    // Recipient-level risk only; availability is separate.
    const risk = recipientRisk(db, r.id, lastOk);
    const contactStatus = inspectionContactStatus(db, lastOk);

    lines.push(`### ${r.decision.toUpperCase()} · ${r.name ?? r.domain} — ${r.domain} (${r.market})`, '');
    lines.push(
      `${p.business_type} · клиенты: ${p.customers} · размер: ${p.size} · коммерческая активность: ${p.commercial_activity}` +
        (g ? ` · группа: ${SAMPLE_GROUP_LABELS[g]}` : ''),
    );
    lines.push(`Сайт: ${r.website_url ?? r.domain}`, '');
    if (r.status !== 'inspected') {
      lines.push(`⚠ При последней проверке сайт был непригоден (${r.reject_reason ?? r.status}); оценка ниже — по более ранним данным.`, '');
    }
    lines.push(`**Что делает:** ${p.business_summary}`, '');
    if (p.commercial_signals.length) {
      lines.push('**Признаки коммерции:**');
      for (const s of p.commercial_signals) lines.push(`- ${s.signal} — «${s.quote}»`);
      lines.push('');
    }
    lines.push('**Возможности:**');
    if (p.opportunities.length === 0) lines.push('- —');
    p.opportunities.forEach((o, i) => {
      const check = v.opportunities[i];
      const mark = check?.hookVerified ? '✓' : '✗';
      const hook = o.hook_type === 'quote' ? `«${o.hook}»` : o.hook_type === 'finding' ? `находка ${o.hook}` : 'без зацепки';
      lines.push(`${i + 1}. **${o.title}** (${CATEGORY_LABEL[o.category] ?? o.category}) — ${mark} ${hook}`);
      lines.push(`   ${o.why}`);
      if (check?.alreadyPresent) lines.push(`   ⚠ на сайте, похоже, уже есть: ${check.alreadyPresent}`);
    });
    lines.push('', `**Решение:** ${r.decision} — ${p.decision_reason}`);
    if (p.unknowns.length) lines.push(`**Неизвестно:** ${p.unknowns.join('; ')}`);
    if (v.issues.length) lines.push(`**Замечания проверки:** ${v.issues.join('; ')}`);
    lines.push(`**Риск обращения:** ${risk ? `${RISK_LABEL[risk.risk] ?? risk.risk} — ${risk.reason}` : 'не определён (проверка по старым правилам)'}`);
    lines.push(`**Доступность контакта:** ${contactStatus ?? 'не определена'}`);
    // Emails seen in that inspection (each has an outreach_risk row there), as in the candidates report.
    const emails = db
      .prepare(
        `SELECT k.email, k.found_on_url FROM outreach_risk o JOIN contacts k ON k.id = o.contact_id
         WHERE o.company_id = ? AND o.inspection_id IS ? ORDER BY k.email`,
      )
      .all(r.id, lastOk) as { email: string; found_on_url: string }[];
    for (const e of emails) lines.push(`- email: ${e.email} — источник: ${e.found_on_url}`);
    for (const e of unconfirmedEmails(db, r.id)) lines.push(`- email: ${e.email} — источник: ${e.found_on_url} · ${UNCONFIRMED_EMAIL_NOTE}`);
    for (const l of channelLines(currentContactChannels(db, r.id))) lines.push(`- ${l}`);
    lines.push(
      `<sub>токены: ${r.input_tokens ?? '?'} вход / ${r.output_tokens ?? '?'} выход · $${(r.cost_usd ?? 0).toFixed(4)}</sub>`,
      '',
      'Оценка оператора: полезно / шаблонно / не подходит · бизнес понят верно: да / нет',
      '',
      '---',
      '',
    );
  }
  return lines.join('\n');
}

export function writeScreeningReport(db: Db, refs: ScreenedRef[], meta: { runCost: number; runCalls: number }, dataDir: string): string {
  const dir = path.resolve(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `screening-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.md`);
  writeFileSync(file, buildScreeningReport(db, refs, meta));
  return file;
}
