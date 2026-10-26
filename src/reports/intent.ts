// Buyer-intent report (npm run intent): public requests ranked by explicit intent to commission work
// and by fit with our services (config/capabilities.yaml), with the exact original URL, date, honest
// status, evidence quote and the reasons for each decision. For human review only — nothing is sent.
// Operator-facing text is Russian.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuyerCategory } from '../intent/buyer.js';
import { ageDays, FIT_LABEL } from '../intent/classify.js';
import type { RankedRequest } from '../intent/rank.js';
import type { IntentSource } from '../intent/types.js';

const BUILTIN_LABEL: Record<string, string> = {
  hn_freelance: 'Hacker News — «Freelancer? Seeking freelancer?»',
  hn_hiring: 'Hacker News — «Who is hiring?» (вакансии и контрактные роли)',
  uk_contracts_finder: 'UK Contracts Finder (госзакупки)',
};
export const CATEGORY_LABEL: Record<BuyerCategory, string> = {
  PROJECT_BUYER: 'прямой заказчик',
  SERVICE_RECOMMENDATION: 'просит порекомендовать исполнителя',
  POTENTIAL_BUYER: 'возможный заказчик (готовность нанять не подтверждена)',
  AGENCY_PARTNERSHIP: 'агентство ищет субподрядчика',
  STAFFING: 'найм / усиление команды',
  SERVICE_PROVIDER: 'исполнитель предлагает услуги',
  IRRELEVANT: 'нерелевантно',
};
const STATUS_LABEL = { open: '🟢 OPEN', closed: '⚫ CLOSED', unknown: '❔ UNKNOWN' } as const;
const LEVEL = { high: 'высокая', medium: 'средняя', low: 'низкая' } as const;
const REMOTE = { permitted: 'разрешена', prohibited: 'запрещена', unknown: 'не указано' } as const;

export interface IntentRunInfo {
  generatedAt: Date;
  sources: { source: IntentSource; label?: string; scanned: number; requests: number; note: string }[];
  unavailable: string[];
  llm: string;
}

const sourceLabel = (info: IntentRunInfo, s: IntentSource) => info.sources.find((x) => x.source === s)?.label ?? BUILTIN_LABEL[s] ?? s;
const localIso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
const date = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const who = (r: RankedRequest) => r.organisation ?? r.author ?? 'автор не указан';

function detail(r: RankedRequest, n: number, info: IntentRunInfo): string[] {
  const age = ageDays(r.publishedAt, info.generatedAt);
  return [
    `### ${n}. ${r.title ?? r.header.slice(0, 90)}`,
    `- **Оригинал:** ${r.url}`,
    `- **Заказчик / источник:** ${who(r)} · ${sourceLabel(info, r.source)}${r.context && !r.context.startsWith(sourceLabel(info, r.source)) ? ` · ${r.context}` : ''}`,
    `- **Опубликовано:** ${date(r.publishedAt)}${age !== null ? ` (${age} дн. назад)` : ''} · **Статус:** ${STATUS_LABEL[r.status]} — ${r.statusBasis}${r.replies != null ? ` · ответов: ${r.replies}` : ''}`,
    `- **Категория:** ${CATEGORY_LABEL[r.buyerCategory]} · **Совпадение:** ${FIT_LABEL[r.techFit]}${r.fitAreas.length ? ` (${r.fitAreas.join(', ')})` : ''}`,
    `- **Цитата намерения:** «${r.evidenceQuote}»`,
    `- **Что нужно:** ${r.workRequested}`,
    `- **Технологии:** ${r.technologies.join(', ') || 'не указаны'}${r.mandatoryTech.length ? ` · обязательные чужие: ${r.mandatoryTech.join(', ')}` : ''}${r.optionalTech.length ? ` · упомянуты: ${r.optionalTech.join(', ')}` : ''}`,
    `- **Бюджет:** ${r.budget ?? 'не указан'} · **Срок:** ${r.deadline ?? 'не указан'} · **Удалённая работа из-за рубежа:** ${REMOTE[r.remote]}${r.location ? ` («${r.location}»)` : ''}`,
    `- **Как ответить (как позволяет источник):** ${r.contactChannel ?? 'канал не указан'}`,
    `- **Почему:** ${r.reasons.join('; ')}${r.classifier === 'llm' ? ' · тип уточнён Haiku (цитата проверена кодом)' : ''}`,
    `- **Не хватает:** ${r.missing.join(', ') || '—'} · **Уверенность в намерении:** ${LEVEL[r.intentConfidence]} · **Оценка:** ${r.score.total.toFixed(1)}`,
    ...(r.seenBefore ? [`- **Уже был в отчёте:** ${r.seenBefore} — не новый лид`] : []),
    ...(r.reposts.length ? [`- **Повторы того же запроса:** ${r.reposts.join(' ')}`] : []),
    '',
  ];
}

const line = (r: RankedRequest) => `- ${date(r.publishedAt)} · [${(r.title ?? r.header).slice(0, 80)}](${r.url}) — ${FIT_LABEL[r.techFit]}; ${r.reasons.join('; ')}`;

/** The first reason a request is not on the shortlist, for the funnel. */
function rejection(r: RankedRequest): string {
  if (r.buyerCategory === 'STAFFING') return 'найм / вакансия, а не готовый результат';
  if (r.buyerCategory === 'SERVICE_PROVIDER') return 'исполнители рекламируют свои услуги / продукты';
  if (r.buyerCategory === 'IRRELEVANT') return 'не запрос на разработку';
  if (r.buyerCategory === 'POTENTIAL_BUYER') return 'потребность без подтверждённой готовности нанять';
  if (r.buyerCategory === 'AGENCY_PARTNERSHIP') return 'агентство-посредник (отдельный раздел)';
  if (r.techFit === 'poor') return 'не наш стек / обязательная чужая платформа';
  if (r.status === 'closed') return 'закрыт';
  if (r.remote === 'prohibited') return 'только местный исполнитель / ограничение по стране';
  return 'старый или иное ограничение';
}

export function intentMarkdown(list: RankedRequest[], info: IntentRunInfo): string {
  const fresh = list.filter((r) => !r.seenBefore);
  const shortlist = fresh.filter((r) => r.qualified);
  const direct = shortlist.filter((r) => r.buyerCategory === 'PROJECT_BUYER');
  const recommendations = shortlist.filter((r) => r.buyerCategory === 'SERVICE_RECOMMENDATION');
  const potential = fresh.filter((r) => r.buyerCategory === 'POTENTIAL_BUYER' && r.techFit !== 'poor' && r.status !== 'closed' && !r.stale);
  const agencies = fresh.filter((r) => r.buyerCategory === 'AGENCY_PARTNERSHIP');
  const explicit = fresh.filter((r) => r.buyerCategory === 'PROJECT_BUYER' || r.buyerCategory === 'SERVICE_RECOMMENDATION');
  const rejectedBuyers = explicit.filter((r) => !r.qualified);
  const staffing = fresh.filter((r) => r.buyerCategory === 'STAFFING');
  const reasons = new Map<string, number>();
  for (const r of fresh.filter((x) => !x.qualified)) reasons.set(rejection(r), (reasons.get(rejection(r)) ?? 0) + 1);

  const lines = [
    '# Заказчики разработки — публичные запросы',
    '',
    `Сформировано ${localIso(info.generatedAt).slice(0, 16).replace('T', ' ')} · ${info.llm}. Только публичные запросы, где автор сам хочет заказать работу; совпадение — по профилю услуг (config/capabilities.yaml). Ничего не отправлялось.`,
    '',
    '## Воронка',
    '',
    `- **Источников:** ${info.sources.length} (недоступно: ${info.unavailable.length})`,
    ...info.sources.map((s) => `  - ${s.label ?? BUILTIN_LABEL[s.source] ?? s.source}: просмотрено ${s.scanned}, в разборе ${s.requests}. ${s.note}`),
    `- **Запросов рассмотрено:** ${list.length}${list.length !== fresh.length ? ` (из них ${list.length - fresh.length} уже были в прошлых отчётах)` : ''}`,
    `- **Явных запросов покупателей** (прямой заказ или просьба порекомендовать исполнителя): ${explicit.length}`,
    `- **Из них CORE_FIT:** ${explicit.filter((r) => r.techFit === 'core').length}`,
    `- **Готовы к ответу (шорт-лист):** ${shortlist.length} — прямых ${direct.length}, рекомендаций ${recommendations.length}`,
    `- **Возможные заказчики:** ${potential.length} · **агентства-субподряд:** ${agencies.length}`,
    '- **Основные причины отказа:**',
    ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  - ${k}: ${v}`),
    ...(info.unavailable.length ? ['', '**Недоступно / не подключено:**', ...info.unavailable.map((u) => `- ${u}`)] : []),
    '',
    'Статус OPEN — только если источник сам это сообщает. Пост, который просто ещё виден, имеет статус UNKNOWN: смотрите на дату.',
    '',
    `## 1. Прямые заказчики — ${direct.length}`,
    '',
  ];
  direct.forEach((r, i) => lines.push(...detail(r, i + 1, info)));
  if (!direct.length) lines.push('Нет.', '');
  lines.push(`## 2. Просят порекомендовать исполнителя — ${recommendations.length}`, '');
  recommendations.forEach((r, i) => lines.push(...detail(r, i + 1, info)));
  if (!recommendations.length) lines.push('Нет.', '');
  lines.push(`## 3. Возможные заказчики — нужна проверка (${potential.length})`, '', 'Описана потребность в нашем типе работы, но автор не сказал, что готов нанять. Не считать подтверждённым заказом. Только свежие темы; старые — в CSV.', '');
  for (const r of potential.slice(0, 25)) lines.push(line(r));
  lines.push('', `## 4. Агентства ищут субподрядчика — ${agencies.length}`, '');
  agencies.forEach((r, i) => lines.push(...detail(r, i + 1, info)));
  if (!agencies.length) lines.push('Нет.', '');
  lines.push(`## 5. Отклонены: найм и запросы под чужие платформы / ограничения`, '');
  lines.push(`### Явные запросы покупателей, не прошедшие отбор — ${rejectedBuyers.length}`, '');
  for (const r of rejectedBuyers.slice(0, 30)) lines.push(line(r));
  lines.push('', `### Найм / усиление команды — ${staffing.length}`, '');
  for (const r of staffing.slice(0, 20)) lines.push(line(r));
  if (staffing.length > 20) lines.push(`- … ещё ${staffing.length - 20} (полный список в CSV)`);
  lines.push('');
  return lines.join('\n');
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function intentCsv(list: RankedRequest[]): string {
  const header = [
    'qualified', 'score', 'url', 'source', 'published_at', 'author', 'organisation', 'title', 'buyer_category', 'tech_fit', 'fit_areas',
    'status', 'status_basis', 'evidence_quote', 'work_requested', 'technologies', 'mandatory_unsupported', 'optional_mentioned', 'budget',
    'deadline', 'remote', 'geo', 'location', 'contact_channel', 'intent_confidence', 'reasons', 'missing', 'seen_before', 'request_type', 'replies', 'reposts',
  ];
  const rows = list.map((r) =>
    [
      r.qualified ? 'yes' : 'no', r.score.total.toFixed(1), r.url, r.source, r.publishedAt, r.author, r.organisation, r.title, r.buyerCategory, FIT_LABEL[r.techFit], r.fitAreas.join(', '),
      r.status, r.statusBasis, r.evidenceQuote, r.workRequested, r.technologies.join(', '), r.mandatoryTech.join(', '), r.optionalTech.join(', '), r.budget,
      r.deadline, r.remote, r.geo, r.location, r.contactChannel, r.intentConfidence, r.reasons.join('; '), r.missing.join('; '), r.seenBefore, r.requestType, r.replies, r.reposts.join(' '),
    ]
      .map(cell)
      .join(','),
  );
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

export function writeIntentReport(dataDir: string, list: RankedRequest[], info: IntentRunInfo): { md: string; csv: string } {
  const dir = path.resolve(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const stamp = localIso(info.generatedAt).slice(0, 16).replace(/[-:T]/g, '');
  const md = path.join(dir, `intent-${stamp}.md`);
  const csv = path.join(dir, `intent-${stamp}.csv`);
  writeFileSync(md, intentMarkdown(list, info));
  writeFileSync(csv, String.fromCharCode(0xfeff) + intentCsv(list));
  return { md, csv };
}
