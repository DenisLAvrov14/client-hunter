// Commercial lead report (npm run leads): companies ranked by a project worth selling, with
// technical website quality, contact availability and outreach risk shown apart. For human review:
// nothing is sent. Operator-facing text is Russian.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_LABEL, type EvidenceItem, type Qualification, type Tier } from '../leads/qualify.js';

const TIER_TITLE: Record<Exclude<Tier, 'no_signal'>, string> = {
  strong: 'Сильные коммерческие возможности',
  investigate: 'Возможности, требующие проверки',
  minor_technical: 'Только мелкие технические дефекты — проекта не видно',
  exclude: 'Исключить',
};
const EVIDENCE_LABEL: Record<EvidenceItem['kind'], string> = {
  fact: '✅ факт (этап C)',
  inference: '🔹 вывод (этап C)',
  hypothesis: '💭 гипотеза',
  quote: '📝 цитата есть на сайте (этап B; связь с проблемой не проверена)',
  finding_verified: '🔧 техническая находка (проверена)',
  finding_likely: '❔ вероятная находка',
  none: '—',
};
const RISK_LABEL: Record<string, string> = { low: '🟢 low', review_required: '🟡 review_required', high: '🔴 high' };
const COUNTRY: Record<string, string> = { UK: 'Великобритания', IE: 'Ирландия', NL: 'Нидерланды', RU: 'Россия', KZ: 'Казахстан' };

function contactLine(q: Qualification): string {
  const c = q.company;
  if (c.email) return `${c.email.address} (${c.email.freemail ? 'публичная почта' : 'на домене компании'}) — источник: ${c.email.source}`;
  if (c.emailHiddenOn.length) return `не найден — адрес скрыт защитой от сбора на ${c.emailHiddenOn[0]}, посмотреть вручную`;
  return 'не найден — нужен ручной поиск контакта';
}

function riskLine(q: Qualification): string {
  const r = q.company.risk;
  return r.level ? `${RISK_LABEL[r.level] ?? r.level} — ${r.note}` : r.note;
}

function nextStep(q: Qualification): string {
  const c = q.company;
  if (q.tier === 'strong') {
    if (c.risk.level === 'high') return 'не писать холодный email (высокий риск); решить, есть ли законный путь (согласие, входящий запрос)';
    if (!c.email) return 'найти контакт вручную, затем проверить вопросы ниже до первого письма';
    return 'ручная проверка вопросов ниже, затем решение о первом письме';
  }
  if (q.tier === 'investigate') {
    const deep = q.best?.source === 'deep';
    if (c.legacy) return 'перепроверить сайт текущим кодом (бесплатно), затем этап B/C';
    return deep ? 'проект подтверждён этапом C, но мал или частично есть — уточнить объём' : 'этап C для этой компании (~$0.004), чтобы проверить связь доказательства с проблемой';
  }
  return '';
}

function opportunityBlock(q: Qualification): string[] {
  const b = q.best!;
  const ev = b.evidence.filter((e) => e.kind !== 'none');
  const weak = [
    ...b.evidence.filter((e) => e.absenceOnly).map((e) => `«${e.text.slice(0, 90)}» — вывод только из того, что на сайте этого не видно`),
    ...(b.duplication <= -1 ? ['на сайте это частично уже есть — уточнить, чего именно не хватает'] : []),
  ];
  return [
    `- **Что можно построить:** ${PROJECT_LABEL[b.type]} — ${b.proposal}`,
    `- **Почему это может быть важно (гипотезы, не факты):** ${b.value.join(' ') || '—'}`,
    `- **Доказательства:**`,
    ...(ev.length ? ev.map((e) => `  - ${EVIDENCE_LABEL[e.kind]}: ${e.text}${e.url ? ` (${e.url})` : ''}`) : ['  - нет']),
    `- **Что ещё нужно проверить:** ${[...weak, ...b.openQuestions].join('; ') || '—'}`,
    `- **Оценка:** значимость ${b.relevance}/3 · доказательство ${b.evidenceScore}/3 · масштаб ${b.scope}/3${b.duplication ? ` · дублирование ${b.duplication}` : ''} · итого ${b.total}/9 (источник: этап ${b.source === 'deep' ? 'C' : 'B'})`,
  ];
}

export function leadsMarkdown(list: Qualification[], generatedAt: Date, poolSize: number): string {
  const count = (t: Tier) => list.filter((q) => q.tier === t).length;
  const lines = [
    '# Коммерческие лиды Client Hunter',
    '',
    `Сформировано ${localIso(generatedAt).slice(0, 10)} из сохранённых данных, без вызовов LLM. Компаний с проверкой сайта: ${poolSize}.`,
    `Сильных возможностей: **${count('strong')}** · требуют проверки: ${count('investigate')} · только мелкие дефекты: ${count('minor_technical')} · исключить: ${count('exclude')} · без сигналов: ${count('no_signal')}.`,
    '',
    '**Как ранжировано.** Лид — это проект, который можно продать (B2B-каталог с запросом цены, калькулятор, запись, кабинет клиента, обработка заказов, интеграции), а не дефект сайта. Оценка: значимость для бизнеса (этап B) + сила доказательства + масштаб проекта − дублирование того, что уже есть. «Сильный» лид требует доказательства этапа C (факт или вывод, проверенные кодом): цитата этапа B лишь показывает, что текст есть на сайте. Технические находки, email и юридический риск показаны отдельно и на оценку не влияют. Ничего не отправлялось.',
    '',
  ];
  let n = 0;
  for (const tier of ['strong', 'investigate'] as const) {
    lines.push(`## ${TIER_TITLE[tier]}`, '');
    for (const q of list.filter((x) => x.tier === tier)) {
      const c = q.company;
      n++;
      lines.push(
        `### ${n}. ${c.name} — ${c.website} (${COUNTRY[c.market] ?? c.market})`,
        c.business ? `*${c.business.type}* — ${c.business.summary}` : '*Бизнес не оценивался (этап B не проводился).*',
        '',
        ...opportunityBlock(q),
        `- **Следующий шаг:** ${nextStep(q)}`,
        `- **Контакт:** ${contactLine(q)}`,
        `- **Юридический риск обращения (отдельно):** ${riskLine(q)}`,
        `- **Качество сайта (отдельно, на оценку не влияет):** ${q.technicalSummary}`,
        '',
      );
    }
  }
  lines.push(
    `## ${TIER_TITLE.minor_technical}`,
    '',
    'Проблемы реальные, но это мелкие правки, а не проект для продажи. Можно упомянуть при контакте по другому поводу.',
    '',
    '| Компания | Страна | Находки | Email | Бизнес оценён |',
    '|---|---|---|---|---|',
    ...list
      .filter((q) => q.tier === 'minor_technical')
      .map((q) => `| ${q.company.name} — ${q.company.domain} | ${COUNTRY[q.company.market] ?? q.company.market} | ${q.technicalSummary} | ${q.company.email?.address ?? '—'} | ${q.company.business ? 'да' : q.company.legacy ? 'нет (фаза 1)' : 'нет'} |`),
    '',
    `## ${TIER_TITLE.exclude}`,
    '',
    ...list.filter((q) => q.tier === 'exclude').map((q) => `- ${q.company.name} — ${q.company.domain}: ${q.reasons.join('; ')}`),
    '',
  );
  return lines.join('\n');
}

/** Operator's local date and time in ISO shape (report names and headers are read by a person). */
const localIso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function leadsCsv(list: Qualification[]): string {
  const header = [
    'tier', 'company', 'domain', 'country', 'project_type', 'proposal', 'evidence', 'evidence_url', 'relevance', 'evidence_strength', 'scope', 'duplication', 'score',
    'source_stage', 'to_verify', 'email', 'email_source', 'outreach_risk', 'ready_for_contact_review', 'technical_quality', 'reasons',
  ];
  const rows = list
    .filter((q) => q.tier !== 'no_signal')
    .map((q) => {
      const b = q.best;
      const ev = b?.evidence.filter((e) => e.kind !== 'none') ?? [];
      return [
        q.tier, q.company.name, q.company.domain, q.company.market, b ? PROJECT_LABEL[b.type] : '', b?.proposal ?? '',
        ev.map((e) => `${e.kind}: ${e.text}`).join(' | '), ev.map((e) => e.url).filter(Boolean).join(' '),
        b?.relevance ?? '', b?.evidenceScore ?? '', b?.scope ?? '', b?.duplication ?? '', b?.total ?? '', b ? (b.source === 'deep' ? 'C' : 'B') : '',
        b?.openQuestions.join('; ') ?? '', q.company.email?.address ?? '', q.company.email?.source ?? '', q.company.risk.level ?? '',
        q.readyForContactReview ? 'yes' : 'no', q.technicalSummary, q.reasons.join('; '),
      ]
        .map(csvCell)
        .join(',');
    });
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

export function writeLeads(dataDir: string, list: Qualification[], poolSize: number, now = new Date()): { md: string; csv: string } {
  const dir = path.resolve(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const stamp = localIso(now).slice(0, 16).replace(/[-:T]/g, '');
  const md = path.join(dir, `leads-${stamp}.md`);
  const csv = path.join(dir, `leads-${stamp}.csv`);
  writeFileSync(md, leadsMarkdown(list, now, poolSize));
  writeFileSync(csv, String.fromCharCode(0xfeff) + leadsCsv(list)); // BOM: Excel opens Cyrillic correctly
  return { md, csv };
}
