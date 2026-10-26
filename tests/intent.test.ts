// Buyer-intent discovery: parsing of the public sources, deterministic classification, ranking,
// storage and the optional LLM check. Fixtures are shaped like the real HN Algolia and Contracts
// Finder OCDS responses (cases taken from the October 2026 run). No network, no LLM.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadConfig, type Config } from '../src/config/load.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import type { Fetcher, FetchResult } from '../src/inspect/fetcher.js';
import { classify as classifyAt } from '../src/intent/classify.js';
import { checkAmbiguous } from '../src/intent/llmCheck.js';
import { contentHash, rankRequests } from '../src/intent/rank.js';
import { fetchContractsFinder, releaseToRequest } from '../src/intent/sources/contractsFinder.js';
import { commentsOf, hnThreads } from '../src/intent/sources/hn.js';
import { saveRequests } from '../src/intent/store.js';
import { htmlToText } from '../src/intent/text.js';
import type { RawRequest } from '../src/intent/types.js';
import { Budget } from '../src/llm/budget.js';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../src/llm/client.js';
import { intentCsv, intentMarkdown } from '../src/reports/intent.js';

const config = loadConfig();
const cfg = config.intent;
const NOW = new Date('2026-10-25T12:00:00Z');
const classify = (r: RawRequest, c: Config) => classifyAt(r, c, { now: NOW });

class JsonFetcher implements Fetcher {
  readonly urls: string[] = [];
  constructor(private readonly routes: [RegExp, unknown][]) {}
  async fetch(url: string): Promise<FetchResult> {
    this.urls.push(url);
    const hit = this.routes.find(([re]) => re.test(url));
    return { requestedUrl: url, finalUrl: url, status: hit ? 200 : 404, contentType: 'application/json', body: hit ? JSON.stringify(hit[1]) : '', truncated: false };
  }
}

const hn = (source: RawRequest['source'], text: string, over: Partial<RawRequest> = {}): RawRequest => ({
  source,
  itemId: String(Math.floor(Math.random() * 1e9)),
  url: 'https://news.ycombinator.com/item?id=1',
  publishedAt: '2026-10-05T10:00:00.000Z',
  author: 'someone',
  organisation: source === 'hn_hiring' ? (text.split('|')[0]?.trim() ?? null) : null,
  title: null,
  text,
  header: text.split('\n')[0]!,
  ...over,
});

describe('HN source', () => {
  it('turns HN comment HTML into plain text lines', () => {
    expect(htmlToText('SEEKING FREELANCER | Remote<p>We&#x27;ve built a platform &amp; need help: <a href="x">https:&#x2F;&#x2F;a.io</a>')).toBe(
      "SEEKING FREELANCER | Remote\nWe've built a platform & need help: https://a.io",
    );
  });

  it('one thread per month: the most discussed one with the exact title (Sept 2026 had a same-titled repost)', async () => {
    const f = new JsonFetcher([
      [
        /search_by_date/,
        {
          hits: [
            { objectID: '49521942', title: 'Ask HN: Freelancer? Seeking freelancer? (September 2026)', created_at: '2026-09-01T13:43:44Z', author: 'jbeard4', num_comments: 2 },
            { objectID: '49522905', title: 'Ask HN: Freelancer? Seeking freelancer? (September 2026)', created_at: '2026-09-01T15:01:55Z', author: 'jon_north', num_comments: 24 },
            { objectID: '49922572', title: 'Ask HN: Freelancer? Seeking freelancer? (October 2026)', created_at: '2026-10-01T15:02:19Z', author: 'jon_north', num_comments: 22 },
            { objectID: '1', title: 'Show HN: my freelancer tool', created_at: '2026-10-02T00:00:00Z', author: 'x', num_comments: 3 },
          ],
        },
      ],
    ]);
    expect((await hnThreads(f, 'hn_freelance', 2, NOW)).map((t) => t.objectID)).toEqual(['49922572', '49522905']);
  });

  it('top-level comments only; deleted ones skipped; the company comes from a job-post header', () => {
    const reqs = commentsOf(
      {
        id: 49922569,
        created_at: '2026-10-01T15:02:07Z',
        author: 'whoishiring',
        text: null,
        title: 'Ask HN: Who is hiring? (October 2026)',
        children: [
          { id: 49961551, created_at: '2026-10-05T10:00:00Z', author: 'a', text: 'AssumeAI | AI Engineer (£30/hr) | Contract | REMOTE (UK)<p>Details', children: [{ id: 9, created_at: '', author: 'b', text: 'reply' }] },
          { id: 2, created_at: '2026-10-05T10:00:00Z', author: null, text: null },
        ],
      },
      'hn_hiring',
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ itemId: '49961551', url: 'https://news.ycombinator.com/item?id=49961551', organisation: 'AssumeAI', context: 'Ask HN: Who is hiring? (October 2026)' });
  });
});

describe('classification: buyer intent vs everything else', () => {
  it('"SEEKING FREELANCER" is a direct request; "SEEKING WORK" is a developer offering services', () => {
    const want = classify(hn('hn_freelance', 'SEEKING FREELANCER | Remote (US+EU only)\nStack: Vue3, Ruby+Sinatra, Postgres. We need a full-stack developer for our platform.'), config);
    expect(want).toMatchObject({ requestType: 'direct_request', engagement: 'contractor', qualified: true, intentConfidence: 'high' });
    expect(want.evidenceQuote).toBe('SEEKING FREELANCER | Remote (US+EU only)');
    expect(want.contactChannel).toContain('ответ на комментарий в HN');
    const offer = classify(hn('hn_freelance', 'SEEKING WORK | Remote | React, Node, TypeScript developer'), config);
    expect(offer).toMatchObject({ requestType: 'service_offer', qualified: false });
  });

  it('a contract role is staffing, not a commissioned deliverable; a permanent job is a vacancy', () => {
    const contract = classify(hn('hn_hiring', 'Obi9 | Full-Stack Engineer | REMOTE (US time zones) | Contract or Full-time\nReact, Node, TypeScript, Python'), config);
    expect(contract).toMatchObject({ requestType: 'contract_role', engagement: 'contractor', geo: 'open', buyerCategory: 'STAFFING', techFit: 'core', qualified: false });
    const job = classify(hn('hn_hiring', 'HiO | Senior Engineer | REMOTE | Full-time\nReact, Node'), config);
    expect(job).toMatchObject({ requestType: 'vacancy', engagement: 'employee', buyerCategory: 'STAFFING', qualified: false });
  });

  it('closed only on an explicit marker; otherwise "unknown", never assumed open', () => {
    const closed = classify(hn('hn_hiring', 'OpenSanctions | Product Engineer | REMOTE | Freelance / employment | CLOSED NOW - STOP SENDING\nPython, React'), config);
    expect(closed).toMatchObject({ status: 'closed', qualified: false });
    const open = classify(hn('hn_hiring', 'Jawa.gg | Software Engineer | remote | Contract or Full Time\nFull-stack: Next.js, Node, TypeScript, Postgres'), config);
    expect(open.status).toBe('unknown');
    expect(open.statusBasis).toContain('судить только по дате');
  });

  it('geography: on-site only, or remote limited to named countries outside our markets, is not reachable', () => {
    expect(classify(hn('hn_hiring', 'Workday | AI Creative Technologist | Pleasanton, CA | ONSITE | Contract\nAPIs, integrations'), config)).toMatchObject({ geo: 'restricted_other', qualified: false });
    expect(classify(hn('hn_hiring', 'Vistulo | Senior React engineers | REMOTE (Poland or Romania) | B2B contract\nReact, TypeScript'), config).geo).toBe('restricted_other');
    expect(classify(hn('hn_hiring', 'Revieve Oy | Senior Product Engineer | REMOTE [Europe / (GMT+2)] | Contract\nbackend, react, typescript'), config).geo).toBe('target');
  });

  it('job posts: the role in the header decides, not the company stack in the body', () => {
    const pm = classify(hn('hn_hiring', 'ODK | Senior Product Manager | Remote (Worldwide) | Long-term contract\nOur SaaS uses React and Node.'), config);
    expect(pm).toMatchObject({ techFit: 'poor', qualified: false });
    const negated = classify(hn('hn_hiring', 'Search Atlas | Product Engineer (Product Manager role, not a Full-stack role) | REMOTE (anywhere) | Full-time contractor\nReact, Django, Python, API'), config);
    expect(negated).toMatchObject({ techFit: 'poor', qualified: false });
    const swift = classify(hn('hn_hiring', 'Pairio | Senior Swift Engineer | REMOTE (Europe) | Employee or freelance\nOur backend is Rails.'), config);
    // Swift in the role line is a requirement for native iOS work we do not offer.
    expect(swift).toMatchObject({ techFit: 'poor', mandatoryTech: ['swift'], qualified: false });
  });

  it('recruiters: a marker at the start of the post, not "our recruiter" further down', () => {
    expect(classify(hn('hn_hiring', 'Virtasant (1099 contractor for a client of ours) | Remote (USA) | full-time\nReact'), config).requestType).toBe('recruiter');
    const own = classify(hn('hn_hiring', `Discord | Engineer | REMOTE | Contract\nReact, TypeScript, Node.${' x'.repeat(200)} Email our recruiter.`), config);
    expect(own.requestType).toBe('contract_role');
  });

  it('contract work that is not development (business development, commission-only) does not qualify', () => {
    const bd = classify(hn('hn_hiring', 'Irash Tech | Business Development Manager (Freelance, Commission-only) | REMOTE (Worldwide) | Contract'), config);
    expect(bd.qualified).toBe(false);
    expect(bd.reasons.join(' ')).toContain('не наша работа');
  });

  it('a "contract" mention only in the body is ambiguous — left to the optional LLM check', () => {
    expect(classify(hn('hn_hiring', 'Acme | Engineer | REMOTE\nWe also take contractors. React, Node.'), config)).toMatchObject({ requestType: 'vacancy', ambiguous: true });
  });
});

describe('UK Contracts Finder', () => {
  const release = (over: Record<string, unknown> = {}, tender: Record<string, unknown> = {}) => ({
    id: 'aeb37bc4-61d8-40de-b087-2908571083bf-919068',
    date: '2026-10-20T10:00:00+01:00',
    buyer: { name: 'Example Council' },
    parties: [{ name: 'Example Council', roles: ['buyer'], contactPoint: { name: 'A. Buyer', email: 'procurement@example.gov.uk' } }],
    tender: {
      id: 'T-1',
      title: 'Website and booking portal redevelopment',
      description: 'We invite quotations to rebuild our website with an online booking portal and API integration.',
      status: 'active',
      value: { amount: 40000, currency: 'GBP' },
      tenderPeriod: { endDate: '2026-11-10T12:00:00Z' },
      classification: { id: '72413000', description: 'World wide web (www) site design services' },
      documents: [{ documentType: 'tenderNotice', url: 'https://www.contractsfinder.service.gov.uk/Notice/aeb37bc4-61d8-40de-b087-2908571083bf' }],
      ...tender,
    },
    ...over,
  });

  it('an open IT tender: status and deadline from the notice, procurement contact as published, notice URL', () => {
    const r = releaseToRequest(release(), cfg.sources.uk_contracts_finder.cpv_prefixes, NOW)!;
    expect(r).toMatchObject({ url: 'https://www.contractsfinder.service.gov.uk/Notice/aeb37bc4-61d8-40de-b087-2908571083bf', organisation: 'Example Council', contact: 'procurement@example.gov.uk', budget: '40000 GBP' });
    const c = classify(r, config);
    expect(c).toMatchObject({ requestType: 'rfp', status: 'open', engagement: 'agency', qualified: true, intentConfidence: 'high' });
    expect(c.statusBasis).toContain('2026-11-10');
  });

  it('expired deadline, "Awarded", or a licence renewal never qualify; other CPV groups are not read', () => {
    const p = cfg.sources.uk_contracts_finder.cpv_prefixes;
    expect(classify(releaseToRequest(release({}, { tenderPeriod: { endDate: '2026-09-01T00:00:00Z' } }), p, NOW)!, config).status).toBe('closed');
    expect(classify(releaseToRequest(release({}, { description: 'Awarded' }), p, NOW)!, config).status).toBe('closed');
    expect(classify(releaseToRequest(release({}, { title: 'Adobe Licenses renewal', description: 'Adobe licences due for renewal.' }), p, NOW)!, config).requestType).toBe('irrelevant');
    expect(releaseToRequest(release({}, { classification: { id: '45233210', description: 'Surface work for highways' } }), p, NOW)).toBeNull();
  });

  it('a notice republished several times is kept once, at its latest version; pagination followed', async () => {
    const f = new JsonFetcher([
      [/cursor=2/, { releases: [release({ date: '2026-10-22T10:00:00+01:00', id: 'x-2' })] }],
      [/Search\?/, { releases: [release({ date: '2026-10-20T10:00:00+01:00' })], links: { next: 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?cursor=2' } }],
    ]);
    const { requests, scanned } = await fetchContractsFinder(f, 30, cfg.sources.uk_contracts_finder.cpv_prefixes, NOW);
    expect(scanned).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.publishedAt).toBe('2026-10-22T09:00:00.000Z');
  });
});

describe('ranking and storage', () => {
  it('a clear recent request outranks an old one; the same post reposted monthly is collapsed', () => {
    const fresh = classify(hn('hn_freelance', 'SEEKING FREELANCER | Remote\nFull-stack React + Node web app, $5k budget', { publishedAt: '2026-10-24T00:00:00.000Z', author: 'new', itemId: '1' }), config);
    const old = classify(hn('hn_freelance', 'SEEKING FREELANCER | Remote\nFull-stack React + Node web app', { publishedAt: '2026-05-01T00:00:00.000Z', author: 'old', itemId: '2' }), config);
    const sept = classify(hn('hn_hiring', 'Obi9 | Full-Stack Engineer | REMOTE | Contract\nReact, Node', { publishedAt: '2026-09-11T00:00:00.000Z', itemId: '3', url: 'https://news.ycombinator.com/item?id=3' }), config);
    const oct = classify(hn('hn_hiring', 'Obi9 | Full-Stack Engineer | REMOTE | Contract\nReact, Node', { publishedAt: '2026-10-02T00:00:00.000Z', itemId: '4', url: 'https://news.ycombinator.com/item?id=4' }), config);
    expect(contentHash(sept)).toBe(contentHash(oct));
    const ranked = rankRequests([old, sept, oct, fresh], NOW);
    // Qualified first; the old direct request outranks the contract role (staffing scores no willingness).
    expect(ranked.map((r) => r.author ?? r.organisation)).toEqual(['new', 'old', 'someone']);
    expect(ranked[0]!.qualified).toBe(true);
    expect(ranked[1]!.reasons.join(' ')).toContain('старше 30 дн.');
    expect(ranked[2]).toMatchObject({ itemId: '4', reposts: ['https://news.ycombinator.com/item?id=3'] });
    expect(fresh.budget).toBe('$5k');
  });

  it('saved once per source item; a later run updates the classification and keeps first_seen_at', () => {
    const db = openDb(':memory:');
    migrate(db);
    const c = classify(hn('hn_freelance', 'SEEKING FREELANCER | Remote\nReact, Node web app', { itemId: '42' }), config);
    expect(saveRequests(db, [c], '2026-10-25T00:00:00.000Z')).toEqual({ inserted: 1, updated: 0 });
    expect(saveRequests(db, [{ ...c, status: 'closed' }], '2026-10-26T00:00:00.000Z')).toEqual({ inserted: 0, updated: 1 });
    expect(db.prepare('SELECT status, first_seen_at, last_seen_at, qualified, request_type FROM intent_leads').all()).toEqual([
      { status: 'closed', first_seen_at: '2026-10-25T00:00:00.000Z', last_seen_at: '2026-10-26T00:00:00.000Z', qualified: 1, request_type: 'direct_request' },
    ]);
  });

  it('the report links every original request and labels status honestly', () => {
    const list = rankRequests([classify(hn('hn_freelance', 'SEEKING FREELANCER | Remote\nReact, Node web app', { url: 'https://news.ycombinator.com/item?id=48361270' }), config)], NOW);
    const md = intentMarkdown(list, { generatedAt: NOW, sources: [{ source: 'hn_freelance', scanned: 1, requests: 1, note: '' }], unavailable: ['Reddit — robots.txt'], llm: 'только правила, без LLM' });
    expect(md).toContain('- **Оригинал:** https://news.ycombinator.com/item?id=48361270');
    expect(md).toContain('❔ UNKNOWN — источник не сообщает');
    expect(md).toContain('## 1. Прямые заказчики — 1');
    expect(md).toContain('**Из них CORE_FIT:** 1');
    expect(md).toContain('Reddit — robots.txt');
    expect(intentCsv(list).split('\n')[1]).toMatch(/^yes,.*,https:\/\/news\.ycombinator\.com\/item\?id=48361270,hn_freelance,/);
  });
});

describe('optional LLM check (paid, off by default)', () => {
  class FakeLlm implements LlmClient {
    readonly requests: LlmRequest<z.ZodType>[] = [];
    constructor(private readonly answers: unknown[]) {}
    async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResponse<z.infer<S>>> {
      this.requests.push(req);
      const a = this.answers.shift();
      if (a instanceof LlmError) throw a;
      return { data: a as z.infer<S>, usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: req.model };
    }
  }
  const ambiguousRaw = hn('hn_hiring', 'Acme | Engineer | REMOTE\nWe also take freelance contractors for our React and Node web app.', { itemId: '77' });
  const clearRaw = hn('hn_hiring', 'Obi9 | Full-Stack Engineer | REMOTE | Contract\nReact, Node', { itemId: '78' });
  const raws = new Map([ambiguousRaw, clearRaw].map((r) => [`${r.source}:${r.itemId}`, r]));

  it('only ambiguous requests are sent; an answer is accepted only with a verbatim quote', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const llm = new FakeLlm([{ request_type: 'contract_role', engagement: 'contractor', evidence_quote: 'We also take freelance contractors', reason: 'r' }]);
    const res = await checkAmbiguous(raws, [classify(ambiguousRaw, config), classify(clearRaw, config)], { config, llm, budget: new Budget(db, config) });
    expect(llm.requests).toHaveLength(1);
    expect(res).toMatchObject({ checked: 1, accepted: 1 });
    expect(res.list[0]).toMatchObject({ requestType: 'contract_role', classifier: 'llm', evidenceQuote: 'We also take freelance contractors' });
    expect(db.prepare("SELECT purpose FROM llm_calls").all()).toEqual([{ purpose: 'intent' }]);
  });

  it('an invented quote is rejected; the budget stops checks before any request', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const invented = await checkAmbiguous(raws, [classify(ambiguousRaw, config)], {
      config,
      llm: new FakeLlm([{ request_type: 'direct_request', engagement: 'contractor', evidence_quote: 'We will pay $10k', reason: 'r' }]),
      budget: new Budget(db, config),
    });
    expect(invented.list[0]).toMatchObject({ requestType: 'vacancy', classifier: 'rules' });
    expect(invented.list[0]!.reasons.join(' ')).toContain('цитаты нет в тексте');
    const broke: Config = { ...config, limits: { ...config.limits, max_llm_cost_usd_per_run: 0 } };
    const llm = new FakeLlm([]);
    const stopped = await checkAmbiguous(raws, [classify(ambiguousRaw, config)], { config: broke, llm, budget: new Budget(db, broke) });
    expect(stopped.stoppedByBudget).toBe(true);
    expect(llm.requests).toHaveLength(0);
  });
});
