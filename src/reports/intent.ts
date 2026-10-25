// Buyer-intent report (npm run intent): public requests ranked by explicit intent to hire, with the
// exact original URL, date, honest status, evidence quote and the reasons for each decision.
// For human review only — nothing is sent. Operator-facing text is Russian.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ageDays, type RankedRequest } from '../intent/rank.js';
import type { IntentSource, RequestType } from '../intent/types.js';

export const SOURCE_LABEL: Record<IntentSource, string> = {
  hn_freelance: 'Hacker News — «Freelancer? Seeking freelancer?»',
  hn_hiring: 'Hacker News — «Who is hiring?» (только контракт / фриланс)',
  uk_contracts_finder: 'UK Contracts Finder (госзакупки)',
};
const TYPE_LABEL: Record<RequestType, string> = {
  direct_request: 'прямой заказ',
  contract_role: 'контрактная роль',
  rfp: 'тендер',
  vacancy: 'штатная вакансия',
  service_offer: 'предложение услуг',
  recruiter: 'рекрутер / посредник',
  advice_only: 'только совет',
  irrelevant: 'нерелевантно',
};
const STATUS_LABEL = { open: '🟢 открыт', closed: '⚫ закрыт', unknown: '❔ неизвестно' } as const;
const LEVEL = { high: 'высокое', medium: 'среднее', low: 'низкое', none: 'нет' } as const;
const GEO = { open: 'удалённо, без ограничений', target: 'наш рынок / регион', restricted_other: 'ограничено другим регионом', unknown: 'не указано' } as const;

export interface IntentRunInfo {
  generatedAt: Date;
  sources: { source: IntentSource; scanned: number; requests: number; note: string }[];
  unavailable: string[];
  llm: string;
}

const localIso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
const date = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

function detail(r: RankedRequest, n: number, now: Date): string[] {
  const age = ageDays(r, now);
  return [
    `### ${n}. ${r.organisation ?? r.author ?? 'автор не указан'} — ${TYPE_LABEL[r.requestType]}`,
    `- **Оригинал:** ${r.url}`,
    `- **Источник:** ${SOURCE_LABEL[r.source]}${r.context ? ` · ${r.context}` : ''}`,
    `- **Опубликовано:** ${date(r.publishedAt)}${age !== null ? ` (${age} дн. назад)` : ''} · **Статус:** ${STATUS_LABEL[r.status]} — ${r.statusBasis}`,
    `- **Автор / заказчик:** ${[r.author, r.organisation].filter(Boolean).join(' / ') || '—'} · **Формат:** ${{ contractor: 'подрядчик / фрилансер', agency: 'компания-исполнитель (тендер)', employee: 'сотрудник', unknown: 'не указан' }[r.engagement]}`,
    `- **Цитата намерения:** «${r.evidenceQuote}»`,
    `- **Что нужно:** ${r.workRequested}`,
    `- **Технологии:** ${r.technologies.join(', ') || '—'} · **Бюджет:** ${r.budget ?? 'не указан'} · **Срок:** ${r.deadline ?? 'не указан'}`,
    `- **География:** ${GEO[r.geo]}${r.location ? ` («${r.location}»)` : ''}`,
    `- **Как ответить (как указано в источнике):** ${r.contactChannel ?? 'канал не указан'}`,
    `- **Уверенность в намерении:** ${LEVEL[r.intentConfidence]} · **Совпадение с нашими услугами:** ${LEVEL[r.skillFit]} · **Оценка:** ${r.score.total.toFixed(1)} (готовность ${r.score.willingness}, свежесть ${r.score.recency}, навыки ${r.score.skill}, доступ ${r.score.access}, ясность ${r.score.clarity}, канал ${r.score.channel})`,
    `- **Почему:** ${r.reasons.join('; ')}${r.classifier === 'llm' ? ' · тип уточнён Haiku (цитата проверена кодом)' : ''}`,
    ...(r.reposts.length ? [`- **Повторы того же запроса:** ${r.reposts.join(' ')}`] : []),
    '',
  ];
}

export function intentMarkdown(list: RankedRequest[], info: IntentRunInfo): string {
  const now = info.generatedAt;
  const qualified = list.filter((r) => r.qualified);
  const byType = new Map<RequestType, RankedRequest[]>();
  for (const r of list.filter((x) => !x.qualified)) byType.set(r.requestType, [...(byType.get(r.requestType) ?? []), r]);
  const lines = [
    '# Запросы с явным намерением заказать разработку',
    '',
    `Сформировано ${localIso(now).slice(0, 16).replace('T', ' ')} · ${info.llm}. Только публичные запросы, где автор сам ищет исполнителя; ничего не выведено из недостатков сайтов. Ничего не отправлялось.`,
    '',
    '**Источники:**',
    ...info.sources.map((s) => `- ${SOURCE_LABEL[s.source]}: просмотрено ${s.scanned}, запросов в разборе ${s.requests}. ${s.note}`),
    ...(info.unavailable.length ? ['', '**Недоступно / не подключено:**', ...info.unavailable.map((u) => `- ${u}`)] : []),
    '',
    `**Итого:** уникальных запросов ${list.length}, квалифицировано **${qualified.length}**.`,
    '',
    'Статус «открыт» — только если источник сам это сообщает (срок тендера). У постов HN статус «неизвестно», если автор не написал, что закрыто: смотрите на дату.',
    '',
    '## Лучшие для ручной проверки',
    '',
    ...(qualified.length
      ? qualified.slice(0, 5).map((r, i) => `${i + 1}. [${r.organisation ?? r.author ?? r.url}](${r.url}) — ${TYPE_LABEL[r.requestType]}, ${date(r.publishedAt)}, ${STATUS_LABEL[r.status]}: «${r.evidenceQuote.slice(0, 140)}»`)
      : ['Квалифицированных запросов нет.']),
    '',
    '## Квалифицированные запросы',
    '',
  ];
  qualified.forEach((r, i) => lines.push(...detail(r, i + 1, now)));
  lines.push('## Не квалифицированы', '');
  for (const [type, items] of byType) {
    lines.push(`### ${TYPE_LABEL[type]} — ${items.length}`, '');
    for (const r of items.slice(0, 15)) lines.push(`- ${date(r.publishedAt)} · [${(r.organisation ?? r.author ?? r.header).slice(0, 60)}](${r.url}) — ${r.reasons.join('; ')}`);
    if (items.length > 15) lines.push(`- … ещё ${items.length - 15} (полный список в CSV)`);
    lines.push('');
  }
  return lines.join('\n');
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function intentCsv(list: RankedRequest[]): string {
  const header = [
    'qualified', 'score', 'url', 'source', 'published_at', 'author', 'organisation', 'request_type', 'engagement', 'status', 'status_basis',
    'evidence_quote', 'work_requested', 'technologies', 'budget', 'deadline', 'geo', 'location', 'contact_channel', 'intent_confidence', 'skill_fit', 'reasons', 'reposts',
  ];
  const rows = list.map((r) =>
    [
      r.qualified ? 'yes' : 'no', r.score.total.toFixed(1), r.url, r.source, r.publishedAt, r.author, r.organisation, r.requestType, r.engagement, r.status, r.statusBasis,
      r.evidenceQuote, r.workRequested, r.technologies.join(', '), r.budget, r.deadline, r.geo, r.location, r.contactChannel, r.intentConfidence, r.skillFit,
      r.reasons.join('; '), r.reposts.join(' '),
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
