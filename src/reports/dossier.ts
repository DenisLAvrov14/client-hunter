// Business opportunity dossiers from stage C, for human review. The outreach draft is shown
// for review only: nothing in this project sends it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/load.js';
import type { MarketCode } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import {
  currentContactChannels,
  emailRisks,
  inspectionContactStatus,
  latestSuccessfulInspection,
  observationById,
  recipientRisk,
  unconfirmedEmails,
} from '../db/repo.js';
import type { DeepMeta } from '../llm/deep.js';
import type { DeepResult, StatementT } from '../llm/schemas.js';
import { withOptOut } from '../outreach/copyCheck.js';
import { channelLines, RISK_LABEL, UNCONFIRMED_EMAIL_NOTE } from './candidates.js';

const KIND_LABEL: Record<StatementT['kind'], string> = {
  fact: '✅ факт',
  inference: '🔹 вывод',
  hypothesis: '💭 гипотеза',
  unknown: '❓ неизвестно',
};
const RECOMMENDATION_LABEL = { pursue: '🟢 стоит предложить', maybe: '🟡 возможно', drop: '⚪ не предлагать' } as const;
// Russian labels for model/code enum values, so the dossier reads in one language. Risk classes
// (low / review_required / high) stay as defined terms (docs/decisions.md).
const EXISTS_LABEL: Record<string, string> = { no: 'нет', partially: 'частично', yes: 'да', unknown: 'неизвестно' };
const SIZE_LABEL: Record<string, string> = { small: 'небольшой', medium: 'средний', large: 'большой' };
const CONTACT_STATUS_LABEL: Record<string, string> = {
  email: 'есть email',
  form_only: 'только форма (email не найден)',
  phone_or_messenger: 'только телефон или мессенджер',
  none: 'контактов не найдено',
};
const MODE_LABEL: Record<string, string> = { offer: 'предложение', permission_request: 'запрос разрешения' };
const FRAMING_LABEL: Record<string, string> = { observation: 'как наблюдение', question: 'как вопрос' };
const PORTFOLIO: Record<string, string> = {
  pinpinpin: 'https://pinpinpin.it (Shopify, интерфейсы, каталоги)',
  cryptovigil: 'https://cryptovigil.net (бэкенд, API, уведомления, дашборды)',
  both: 'https://pinpinpin.it и https://cryptovigil.net',
  none: '—',
};

function evidenceText(db: Db, e: StatementT['evidence'][number]): string {
  if (e.type === 'quote') return `«${e.ref}» (${e.page_url})`;
  if (e.type === 'capability') return `признак сайта: ${e.ref}`;
  if (e.type === 'finding') {
    const o = observationById(db, e.ref);
    return o ? `находка ${o.code} (${o.status})${o.evidence_url ? ` ${o.evidence_url}` : ''}` : `находка ${e.ref}`;
  }
  return '';
}

function statementLines(db: Db, items: StatementT[], indent = ''): string[] {
  if (items.length === 0) return [`${indent}- —`];
  return items.map((s) => {
    const ev = s.evidence.map((e) => evidenceText(db, e)).filter(Boolean);
    return `${indent}- ${KIND_LABEL[s.kind]}: ${s.text}${ev.length ? ` — ${ev.join('; ')}` : ''}`;
  });
}

/** A fence longer than any backtick run in the text, so model output cannot close it early. */
function codeFence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

interface CompanyRow {
  id: string;
  name: string | null;
  domain: string;
  market: string;
  city: string | null;
  website_url: string | null;
}

export function dossierMarkdown(db: Db, config: Config, companyId: string, result: DeepResult, meta: DeepMeta, cost: number): string {
  const c = db.prepare('SELECT id, name, domain, market, city, website_url FROM companies WHERE id = ?').get(companyId) as CompanyRow;
  const market = config.markets.get(c.market as MarketCode);
  const lastOk = latestSuccessfulInspection(db, companyId);
  // Contacts and risk come from the latest SUCCESSFUL inspection; risk is kept apart from availability.
  const risk = recipientRisk(db, companyId, lastOk);
  const contactStatus = inspectionContactStatus(db, lastOk);
  const emails = emailRisks(db, companyId, lastOk);

  const bestIdx = result.opportunities[result.best_opportunity_index] ? result.best_opportunity_index : 0;
  const best = result.opportunities[bestIdx];
  const lines: string[] = [
    `## ${c.name ?? c.domain} — ${c.domain} (${c.market}${c.city ? `, ${c.city}` : ''})`,
    '',
    `**Рекомендация:** ${RECOMMENDATION_LABEL[result.recommendation]} — ${result.recommendation_reason}`,
    `Сайт: ${c.website_url ?? c.domain}`,
    '',
    '### О бизнесе',
    result.business_summary,
    '',
    `**Как продаёт:** ${result.business_model}`,
    `**Что предлагает:** ${result.offering.join('; ') || '—'}`,
    '',
    '### Как клиент взаимодействует сейчас',
    ...statementLines(db, result.customer_journey),
    '',
    '### Что уже есть на сайте',
    ...statementLines(db, result.existing_capabilities),
    '',
  ];

  if (best) {
    lines.push(
      `### Лучшее предложение: ${best.title}`,
      `${best.category === 'website_rescue' ? 'A · исправление сайта' : 'B · улучшение бизнеса'} · объём: ${SIZE_LABEL[best.project_size] ?? best.project_size}` +
        ` · уже есть на сайте: ${EXISTS_LABEL[best.already_exists] ?? best.already_exists}` +
        (best.already_exists_note ? ` (${best.already_exists_note})` : ''),
      '',
      '**Что видно на сайте:**',
      ...statementLines(db, best.observed),
      '',
      `**Что предлагаем:** ${best.proposal}`,
      '',
      '**Возможная польза:**',
      ...statementLines(db, best.value),
      '',
      `**Почему именно это:** ${result.best_reason}`,
      `**Пример из портфолио:** ${PORTFOLIO[best.portfolio] ?? best.portfolio}`,
      `**Что уточнить у клиента:** ${best.open_questions.join('; ') || '—'}`,
      '',
    );
  }
  const others = result.opportunities.filter((_, i) => i !== bestIdx);
  if (others.length) {
    lines.push('### Другие варианты');
    others.forEach((o) => {
      const i = result.opportunities.indexOf(o);
      lines.push(
        `- **${o.title}** — ${o.proposal} (уже есть: ${EXISTS_LABEL[o.already_exists] ?? o.already_exists}${meta.eligible[i] ? '' : ' · ⚠ не подтверждено наблюдениями или уже есть'})`,
      );
    });
    lines.push('');
  }
  if (result.unknowns.length) lines.push('### Неизвестно', ...result.unknowns.map((u) => `- ${u}`), '');

  lines.push('### Контакты', `Доступность контакта: ${contactStatus ? `${CONTACT_STATUS_LABEL[contactStatus] ?? contactStatus} (${contactStatus})` : 'не определена'}`);
  for (const e of emails) {
    lines.push(`- email: ${e.email}${e.is_freemail ? ' (публичная почта)' : ''} — источник: ${e.found_on_url} · риск адреса: ${RISK_LABEL[e.risk] ?? e.risk}`);
  }
  for (const e of unconfirmedEmails(db, companyId)) lines.push(`- email: ${e.email} — источник: ${e.found_on_url} · ${UNCONFIRMED_EMAIL_NOTE}`);
  for (const l of channelLines(currentContactChannels(db, companyId))) lines.push(`- ${l}`);
  lines.push(
    `**Риск обращения (отдельно от доступности):** ${risk ? `${RISK_LABEL[risk.risk] ?? risk.risk} — ${risk.reason}` : 'не определён'}`,
    '',
    '### Черновик первого письма — ТОЛЬКО ДЛЯ ПРОСМОТРА, НЕ ОТПРАВЛЕНО',
  );
  if (meta.outreachIssues.length) {
    lines.push(`⚠ Черновик не прошёл проверку (правила текста или опора на доказательства), использовать его нельзя: ${meta.outreachIssues.join('; ')}`, '');
  }
  // What the draft rests on: the one observed statement it mentions, and how it presents it.
  const basis = result.outreach.opportunity_index !== undefined ? result.opportunities[result.outreach.opportunity_index]?.observed[result.outreach.observation_index] : undefined;
  if (basis) {
    lines.push(`Основа письма: ${KIND_LABEL[basis.kind]}: ${basis.text} · подано ${FRAMING_LABEL[result.outreach.framing] ?? result.outreach.framing}`);
  }
  const draft = [
    `Subject: ${result.outreach.subject}`,
    '',
    withOptOut(config.copyRules, `${result.outreach.body.trim()}\n\n[Имя отправителя]\n[Сайт отправителя]`, result.outreach.language),
  ].join('\n');
  const fence = codeFence(draft);
  lines.push(
    `Режим: ${market ? `${MODE_LABEL[market.first_touch_mode] ?? market.first_touch_mode} (${market.first_touch_mode})` : '?'} · язык письма: ${result.outreach.language}`,
    '',
    `${fence}text`,
    draft,
    fence,
    '',
    '### Проверка',
    `Вызовов API: ${meta.calls} · стоимость: $${cost.toFixed(4)}` +
      (meta.extraPages.length ? ` · дополнительно прочитаны: ${meta.extraPages.join(', ')}` : '') +
      (meta.skippedPages.length ? ` · не прочитаны: ${meta.skippedPages.map((s) => `${s.url} (${s.reason})`).join(', ')}` : ''),
  );
  if (meta.issues.length) lines.push(`Технический журнал проверки кодом (на английском): ${meta.issues.join('; ')}`);
  lines.push('', '---', '');
  return lines.join('\n');
}

export function writeDossiers(dataDir: string, sections: string[], summary: string): string {
  const dir = path.resolve(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dossiers-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.md`);
  writeFileSync(
    file,
    [
      '# Досье бизнес-возможностей (этап C)',
      '',
      summary,
      '',
      'Подписи: ✅ факт — подтверждено доказательством; 🔹 вывод — следует из наблюдаемого; 💭 гипотеза — не проверено; ❓ неизвестно.',
      'Черновики писем — только для просмотра человеком. Ничего не отправлено и не будет отправлено автоматически.',
      '',
      ...sections,
    ].join('\n'),
  );
  return file;
}
