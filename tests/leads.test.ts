// Commercial lead qualification: a lead is a project worth selling, not a website defect.
// Cases modelled on the stored results (A1, JNH, Freza, PRO-POTOLOK, kazbelmebel, phase 1
// companies with only PDF catalogues or broken links). No network, no LLM.
import { describe, expect, it } from 'vitest';
import { loadLeadInputs } from '../src/leads/load.js';
import {
  projectTypeOf,
  qualify,
  rank,
  relevanceOf,
  type BusinessInput,
  type CompanyInput,
  type OpportunityInput,
} from '../src/leads/qualify.js';
import { leadsCsv, leadsMarkdown } from '../src/reports/leads.js';
import { a1Answer, a1Site, freshDb, inspected } from './fixtures/deep-sites.js';

const business = (over: Partial<BusinessInput> = {}): BusinessInput => ({
  summary: 'Поставщик режущего инструмента.',
  type: 'поставщик инструмента',
  customers: 'both',
  activity: 'clear',
  size: 'small',
  isIt: false,
  decision: 'deep',
  decisionReason: 'Реальный бизнес.',
  ...over,
});

const company = (over: Partial<CompanyInput> = {}): CompanyInput => ({
  domain: 'example.ru',
  name: 'Example',
  website: 'https://example.ru/',
  market: 'RU',
  business: business(),
  deepRecommendation: null,
  opportunities: [],
  technical: [],
  email: { address: 'info@example.ru', freemail: false, source: 'https://example.ru/' },
  emailHiddenOn: [],
  risk: { level: 'low', note: 'тест' },
  legacy: false,
  ...over,
});

/** Freza-like: pre-orders from brand catalogues are collected by email — stage C, two facts. */
const deepQuote = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  source: 'deep',
  title: 'Заявка на позиции под заказ прямо с сайта вместо письма на почту',
  proposal: 'Выбор позиций под заказ с артикулом и количеством и отправка заявки на КП с сайта.',
  category: 'business_improvement',
  value: ['Клиенту может быть проще собрать заявку без письма.'],
  evidence: [
    { kind: 'fact', text: 'Для предзаказа клиент отправляет список артикулов на почту — «Соберите список с артикулами и количеством;»', url: 'https://example.ru/katalogi/' },
    { kind: 'fact', text: 'Каталоги опубликованы как PDF' },
  ],
  openQuestions: ['Сколько заявок приходит по почте?'],
  projectSize: 'medium',
  alreadyExists: 'partially',
  eligible: true,
  ...over,
});

describe('project types (Cyrillic titles from stages B/C)', () => {
  it('labels workflows, and everything of category website_rescue as a technical fix', () => {
    expect(projectTypeOf('Форма заявки и запроса цены вместо адреса почты', 'business_improvement')).toBe('quote_system');
    expect(projectTypeOf('Заявка на позиции под заказ прямо с сайта', 'business_improvement')).toBe('quote_system');
    expect(projectTypeOf('Заявка на мебель на заказ с указанием размеров', 'business_improvement')).toBe('quote_system');
    expect(projectTypeOf('Предварительный калькулятор цены для индивидуальных вывесок', 'business_improvement')).toBe('calculator');
    expect(projectTypeOf('Онлайн-запись на бесплатный замер с выбором времени', 'business_improvement')).toBe('booking');
    expect(projectTypeOf('Кабинет клиента со статусом заказа', 'business_improvement')).toBe('portal');
    expect(projectTypeOf('Интеграция заявок с 1С и складом', 'business_improvement')).toBe('integration');
    expect(projectTypeOf('Маршрутизация заявок к нужному сотруднику', 'business_improvement')).toBe('order_flow');
    expect(projectTypeOf('Исправить мобильную версию и HTTPS', 'website_rescue')).toBe('website_fix');
  });
});

describe('minor website defects never make a lead on their own', () => {
  it('broken links, old copyright, PDF catalogue and mobile issues only → "minor technical", whatever their number', () => {
    const q = qualify(
      company({
        technical: ['BROKEN_INTERNAL_LINKS', 'OUTDATED_COPYRIGHT', 'PDF_CATALOG', 'NO_VIEWPORT_META', 'SSL_ERROR'].map((code) => ({ code, status: 'verified' as const, url: 'https://example.ru/' })),
        opportunities: [
          { ...deepQuote(), source: 'screen', title: 'Исправить битую навигационную ссылку', proposal: 'Исправить ссылку', category: 'website_rescue', evidence: [{ kind: 'finding_verified', text: 'находка' }], projectSize: undefined, alreadyExists: undefined, eligible: undefined },
        ],
      }),
    );
    expect(q.tier).toBe('minor_technical');
    expect(q.best).toBeNull();
    expect(q.reasons[0]).toContain('только мелкие технические дефекты');
  });

  it('a business proposal backed only by a technical finding (catalogue "instead of PDF") is weak evidence, never strong', () => {
    const q = qualify(company({ opportunities: [deepQuote({ source: 'screen', title: 'Поисковый каталог вместо PDF-прайса', proposal: 'Поисковый каталог', evidence: [{ kind: 'finding_verified', text: 'PDF_CATALOG' }], projectSize: undefined, alreadyExists: undefined, eligible: undefined })] }));
    expect(q.best?.evidenceScore).toBe(1);
    expect(q.tier).toBe('investigate');
  });
});

describe('evidence strength', () => {
  it('strong needs a stage C fact: the same proposal from a stage B quote only is "investigate"', () => {
    expect(qualify(company({ opportunities: [deepQuote()] })).tier).toBe('strong');
    const fromScreen = deepQuote({ source: 'screen', evidence: [{ kind: 'quote', text: '«Отправьте на электронную почту»' }], projectSize: undefined, alreadyExists: undefined, eligible: undefined });
    const q = qualify(company({ opportunities: [fromScreen] }));
    expect(q.tier).toBe('investigate');
    expect(q.reasons.join(' ')).toContain('доказательство слабое');
  });

  it('"the site does not show X" alone is weak: no software need is assumed from a missing feature', () => {
    const q = qualify(company({ opportunities: [deepQuote({ evidence: [{ kind: 'inference', text: 'Калькулятора на сайте нет', absenceOnly: true }] })] }));
    expect(q.best?.evidenceScore).toBe(1);
    expect(q.tier).not.toBe('strong');
  });

  it('a stage C proposal that was not eligible is capped at weak evidence', () => {
    expect(qualify(company({ opportunities: [deepQuote({ eligible: false })] })).best?.evidenceScore).toBe(1);
  });

  it('a small project stays "investigate" even with facts (kazbelmebel / PRO-POTOLOK case)', () => {
    const q = qualify(company({ opportunities: [deepQuote({ projectSize: 'small', title: 'Онлайн-запись на бесплатный замер с выбором времени', proposal: 'Запись на замер' })] }));
    expect(q.best?.type).toBe('booking');
    expect(q.tier).toBe('investigate');
    expect(q.reasons.join(' ')).toContain('проект небольшой');
  });
});

describe('duplication and exclusions', () => {
  it('a proposal duplicating what the site already has is not a project', () => {
    const q = qualify(company({ opportunities: [deepQuote({ source: 'screen', duplicates: 'cart_checkout', projectSize: undefined, alreadyExists: undefined, eligible: undefined })] }));
    expect(q.best).toBeNull();
    expect(qualify(company({ opportunities: [deepQuote({ alreadyExists: 'yes' })] })).best).toBeNull();
  });

  it('IT companies, large chains, stage B "skip" and stage C "drop" are excluded with the reason', () => {
    expect(qualify(company({ business: business({ isIt: true }), opportunities: [deepQuote()] })).tier).toBe('exclude');
    expect(qualify(company({ business: business({ size: 'large_or_chain' }), opportunities: [deepQuote()] })).reasons[0]).toContain('крупная');
    expect(qualify(company({ business: business({ decision: 'skip', decisionReason: 'государственное учреждение' }) })).reasons[0]).toContain('государственное учреждение');
    expect(qualify(company({ deepRecommendation: 'drop', opportunities: [deepQuote()] })).tier).toBe('exclude');
  });

  it('a one-person business gets lower business relevance', () => {
    expect(relevanceOf(business({ size: 'solo_or_micro' }))).toBe(2);
    expect(relevanceOf(business({ activity: 'unclear' }))).toBe(1);
    expect(relevanceOf(null)).toBeNull();
  });
});

describe('ranking: commercial potential first, contact and legal risk apart', () => {
  it('email and outreach risk never change the tier; they only decide contact readiness and break ties', () => {
    const noEmailHighRisk = qualify(company({ domain: 'b.ru', email: null, risk: { level: 'high', note: '38-ФЗ' }, opportunities: [deepQuote()] }));
    expect(noEmailHighRisk.tier).toBe('strong');
    expect(noEmailHighRisk.readyForContactReview).toBe(false);
    const ready = qualify(company({ domain: 'a.ru', opportunities: [deepQuote()] }));
    expect(ready.readyForContactReview).toBe(true);
    const minor = qualify(company({ domain: 'c.ru', technical: [{ code: 'PDF_CATALOG', status: 'verified', url: null }] }));
    const weak = qualify(company({ domain: 'd.ru', opportunities: [deepQuote({ source: 'screen', evidence: [{ kind: 'quote', text: 'q' }], projectSize: undefined, alreadyExists: undefined, eligible: undefined })] }));
    expect(rank([minor, weak, noEmailHighRisk, ready]).map((q) => q.company.domain)).toEqual(['a.ru', 'b.ru', 'd.ru', 'c.ru']);
  });

  it('the report explains what to build, why, the evidence and what to verify — technical quality shown apart', () => {
    const list = rank([
      qualify(company({ opportunities: [deepQuote()], technical: [{ code: 'PDF_CATALOG', status: 'verified', url: 'https://example.ru/' }] })),
      qualify(company({ domain: 'minor.nl', name: 'Minor', technical: [{ code: 'BROKEN_INTERNAL_LINKS', status: 'verified', url: null }] })),
    ]);
    const md = leadsMarkdown(list, new Date('2026-10-25T00:00:00Z'), 2);
    expect(md).toContain('## Сильные коммерческие возможности');
    expect(md).toContain('**Что можно построить:** B2B-каталог с запросом цены (КП)');
    expect(md).toContain('**Почему это может быть важно (гипотезы, не факты):**');
    expect(md).toContain('✅ факт (этап C): Для предзаказа клиент отправляет список артикулов');
    expect(md).toContain('**Что ещё нужно проверить:** на сайте это частично уже есть');
    expect(md).toContain('**Качество сайта (отдельно, на оценку не влияет):** проверено: PDF_CATALOG');
    expect(md).toMatch(/\| Minor — minor\.nl \| .* \| проверено: BROKEN_INTERNAL_LINKS \|/);
    expect(leadsCsv(list).split('\n')[1]).toMatch(/^strong,Example,example\.ru,RU,B2B-каталог/);
  });
});

describe('loading stored results', () => {
  it('a stored stage B + C analysis becomes a strong lead; nothing is written to the database', () => {
    const db = freshDb();
    const { companyId, input } = inspected(db, a1Site);
    const screen = {
      business_summary: 'Мастерская вывесок.',
      business_type: 'производитель вывесок',
      customers: 'both',
      commercial_activity: 'clear',
      commercial_signals: [],
      size: 'small',
      is_it_or_web_agency: false,
      opportunities: [],
      decision: 'deep',
      decision_reason: 'Реальный бизнес.',
      unknowns: [],
    };
    const add = db.prepare(
      `INSERT INTO assessments (id, company_id, inspection_id, stage, model, prompt_version, input_hash, decision, payload_json, validation_json, llm_call_id, created_at)
       VALUES (?, ?, ?, ?, 'm', 'p', ?, ?, ?, ?, NULL, ?)`,
    );
    add.run('as_1', companyId, input.digest.inspectionId, 'screen', 'h1', 'deep', JSON.stringify(screen), JSON.stringify({ opportunities: [], issues: [] }), '2026-10-24T00:00:00Z');
    const deep = a1Answer();
    deep.opportunities[0]!.project_size = 'medium';
    add.run('as_2', companyId, input.digest.inspectionId, 'deep', 'h2', 'pursue', JSON.stringify(deep), JSON.stringify({ eligible: [true] }), '2026-10-24T01:00:00Z');
    const before = db.prepare('SELECT COUNT(*) AS n FROM assessments').get();

    const [c] = loadLeadInputs(db);
    expect(c!.business?.type).toBe('производитель вывесок');
    expect(c!.opportunities.map((o) => o.source)).toEqual(['deep']);
    const q = qualify(c!);
    expect(q.tier).toBe('strong');
    expect(q.best?.type).toBe('calculator');
    expect(q.best?.evidence.find((e) => e.kind === 'fact')?.url).toBe('https://www.a1designs.co.uk/product-category/led-flex-neon-signs/quote-words/');
    expect(db.prepare('SELECT COUNT(*) AS n FROM assessments').get()).toEqual(before);
  });
});
