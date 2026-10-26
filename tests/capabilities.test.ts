// Service Capability Profile (config/capabilities.yaml) and buyer categories on forum posts: a
// commissioned deliverable vs staffing, provider recommendations, technology-neutral requests,
// mandatory unsupported platforms, migrations, i18n, payments, stale / closed / local-only posts.
// Cases are shaped like real posts from UK Business Forums, HigherLevel, Shopify Community and the
// Bubble / n8n / Make forums (October 2026). No network, no LLM.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import type { Fetcher, FetchResult } from '../src/inspect/fetcher.js';
import { titleLooksLikeRequest } from '../src/intent/buyer.js';
import { techFit } from '../src/intent/capabilities.js';
import { classify } from '../src/intent/classify.js';
import { rankRequests } from '../src/intent/rank.js';
import { fetchDiscourse, parseRss, threadStartFromHtml } from '../src/intent/sources/forums.js';
import { saveRequests } from '../src/intent/store.js';
import type { RawRequest } from '../src/intent/types.js';
import { intentMarkdown } from '../src/reports/intent.js';

const config = loadConfig();
const NOW = new Date('2026-10-26T12:00:00Z');

let seq = 0;
const post = (title: string, text = '', over: Partial<RawRequest> = {}): RawRequest => ({
  source: 'ukbf_looking_for',
  itemId: String(++seq),
  url: `https://www.ukbusinessforums.co.uk/threads/t.${seq}/`,
  publishedAt: '2026-10-22T10:00:00.000Z',
  author: 'owner',
  organisation: null,
  title,
  text,
  header: title,
  context: "UK Business Forums — I'm Looking For A...",
  ...over,
});
const c = (title: string, text = '', over: Partial<RawRequest> = {}) => classify(post(title, text, over), config, { now: NOW });

describe('buyer category: who wants what', () => {
  it('a business owner commissioning a defined deliverable is a project buyer', () => {
    const r = c('Looking for a developer to build a booking system for our salon', 'We need online booking with Stripe deposits. Budget is £3,000.');
    expect(r).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core', qualified: true, budget: '£3,000' });
    expect(r.fitAreas).toEqual(expect.arrayContaining(['Full-stack веб-разработка', 'Платежи, авторизация, аккаунты']));
    expect(r.evidenceQuote).toBe('Looking for a developer to build a booking system for our salon');
  });

  it('asking for a provider recommendation is a service recommendation; recommending hosting is not development', () => {
    const r = c('Can anyone recommend a web developer for a Shopify store redesign?', 'Our theme is old and slow on mobile.');
    expect(r).toMatchObject({ buyerCategory: 'SERVICE_RECOMMENDATION', techFit: 'core', qualified: true });
    const host = c('Recommendations please for a reliable UK web host', 'I have a small ecommerce website and need 5 mailboxes.');
    expect(host).toMatchObject({ buyerCategory: 'IRRELEVANT', techFit: 'poor', qualified: false });
    // "Can anyone recommend a bundle app?" asks for software to install, not for someone to build.
    expect(c('Can anyone recommend a great Bundle app?', 'Looking for bundles on product pages.').buyerCategory).not.toBe('SERVICE_RECOMMENDATION');
  });

  it('staff augmentation is staffing, even with our exact stack', () => {
    const r = c('Looking for a Shopify developer to join our team', '20 hours per week, ongoing, Liquid and Klaviyo.');
    expect(r).toMatchObject({ buyerCategory: 'STAFFING', techFit: 'core', qualified: false });
    expect(c('Hiring: full-time React developer', 'Salary £55k, hybrid in Leeds.').buyerCategory).toBe('STAFFING');
  });

  it('a technology-neutral business request still matches through the problem it describes', () => {
    const r = c('Need someone to build a customer portal', 'Our clients should log in and see their orders and invoices. Happy to pay for a fixed price.');
    expect(r).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core', qualified: true });
    expect(r.technologies).toEqual(expect.arrayContaining(['customer portal']));
    const automate = c('Looking for someone to automate our order processing', 'Orders come by email and we type them into our accounts by hand.');
    expect(automate).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core' });
  });

  it('real secondary-forum cases: a 50% part-time role is staffing; "[Available]" posts are providers', () => {
    expect(c('Digital Projects & AI Assistant — remote freelance, minimum 50%', 'Remote freelance · Part-time, minimum 50%. We are looking for a resourceful freelancer to build landing pages and dashboards.', { source: 'make_hire' }).buyerCategory).toBe('STAFFING');
    expect(c('• [Available] Hardened n8n & AI Engineer: Database Idempotency', 'Looking for an agency or client.', { source: 'n8n_jobs' }).buyerCategory).toBe('SERVICE_PROVIDER');
    expect(c('Need Help With Your Bubble App? I’m Available to Help', 'I need a client.', { source: 'bubble_jobs' }).buyerCategory).toBe('SERVICE_PROVIDER');
  });

  it('developers and app makers advertising themselves are service providers; equity-only asks are not buyers', () => {
    expect(c('[FOR HIRE] Shopify developer available', 'I build custom themes.').buyerCategory).toBe('SERVICE_PROVIDER');
    expect(c('Looking for Shopify merchants to test a free shipping tool', 'I built an app.').buyerCategory).toBe('SERVICE_PROVIDER');
    expect(c('Looking for a technical co-founder', 'I need someone to build the MVP for equity.')).toMatchObject({ buyerCategory: 'IRRELEVANT', qualified: false });
  });

  it('an agency looking for a white-label developer is a partnership, reported apart from buyers', () => {
    const r = c('Looking for a white-label Shopify developer', 'We are a UK agency and need a developer for our clients, paid per project.');
    expect(r).toMatchObject({ buyerCategory: 'AGENCY_PARTNERSHIP', qualified: false });
  });

  it('a need without stated willingness to hire is only a potential buyer', () => {
    const r = c('How can I add a customer portal to my website?', 'We want customers to see past orders.');
    expect(r).toMatchObject({ buyerCategory: 'POTENTIAL_BUYER', qualified: false, intentConfidence: 'low' });
  });

  it('real UKBF cases (2026-10-26 run): a founder weighing a freelancer vs a "development partner" is a buyer, not an agency', () => {
    const saas = c(
      'Freelance developer or development company for a SaaS build?',
      'I’m weighing up two options for my own SaaS project. So, I could hire a good freelance developer. The other is to work with a development partner that can cover more of the process. The product itself will have subscription billing, a few third-party integrations, and different user roles.',
      { source: 'ukbf_it' },
    );
    expect(saas).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core', qualified: true });
    const small = c('website design and publication', 'I know next to nothing about web development so will need to hire someone to design and publish the website.', { source: 'ukbf_startup' });
    expect(small).toMatchObject({ buyerCategory: 'PROJECT_BUYER', qualified: true });
    // An integration gap described by a merchant, without asking for anyone: potential buyer only.
    const gap = c("Shopify sales into FreeAgent - what's everyone doing since they killed the integration?", 'We used the integration to sync orders.', { source: 'ukbf_websites' });
    expect(gap).toMatchObject({ buyerCategory: 'POTENTIAL_BUYER', qualified: false });
    // "How do I…" deep inside an article is not the author's need.
    const article = c('The Biggest SEO Opportunity for UK Businesses Right Now: AI Search', `${'AI search is changing everything. '.repeat(30)}How do I get my web development business found?`);
    expect(article.buyerCategory).not.toBe('POTENTIAL_BUYER');
  });

  it('real Shopify Community cases: a feature named "Get a Quote" is not a quote request; an SEO specialist role is not development', () => {
    const feature = c('How to turn a "Add to Cart" button on the product page to: "Get a Quote" leading to a contact form?', 'In Glamour theme.', { source: 'shopify_community' });
    expect(feature.buyerCategory).not.toBe('PROJECT_BUYER');
    const seo = c('[HIRING] Bark UK Online - Shopify SEO Specialist - Remote (UK/Contract)', 'Budget: £250 – £400 per month (depending on hours/experience)', { source: 'shopify_community' });
    expect(seo).toMatchObject({ techFit: 'poor', qualified: false });
  });

  it('real HigherLevel case: "will pay" a registration fee is not buying development; a budget range is kept whole', () => {
    const ppwr = c('Versturen naar België - PPWR', 'Ik ben gestopt met verzenden binnen de EU vanwege de nieuwe PPWR. Ik snap dat je je bedrijf moet registreren; I will pay €100 per year. Mijn webshop mist bestellingen.', { source: 'higherlevel' });
    expect(ppwr.buyerCategory).not.toBe('PROJECT_BUYER');
    const store = c('US WooCommerce developer, hourly: new store project', 'I need a developer for the parts I cannot do. BUDGET: $3,000 to $4,000 for the developer work.', { source: 'wp_jobs', replyHint: 'по инструкции в объявлении' });
    expect(store.budget).toBe('$3,000 to $4,000');
    expect(store.contactChannel).toMatch(/^по инструкции в объявлении: /);
  });

  it('a tender whose subject does not clearly match our services is not shortlisted', () => {
    const r = classify(
      { ...post('GDPR Data Audit', 'The council requires a GDPR data audit of its records.'), source: 'uk_contracts_finder', sourceStatus: { open: true, basis: 'срок подачи до 2026-11-10' } },
      config,
      { now: NOW },
    );
    expect(r).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'conditional', qualified: false });
  });

  it('Dutch business owners (HigherLevel): "ik zoek een ontwikkelaar" for a webshop', () => {
    const r = c('Ik zoek een ontwikkelaar voor mijn webshop', 'Ik wil een koppeling tussen de webshop en ons voorraadsysteem.', { source: 'higherlevel' });
    expect(r).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core', qualified: true });
  });
});

describe('technology fit against the capability profile', () => {
  it('a mandatory specialist platform (Bubble, n8n) is a poor fit; native iOS too', () => {
    const bubble = c('Looking for an experienced Bubble developer to finish our app', 'Our live SaaS is built on Bubble; paid milestones.');
    expect(bubble).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'poor', mandatoryTech: ['bubble'], qualified: false });
    expect(c('n8n expert needed: AI WhatsApp support agent', 'Must have n8n experience.').techFit).toBe('poor');
    expect(c('Looking for a developer to build an iOS app in Swift', 'Native app for the App Store.').techFit).toBe('poor');
  });

  it('an optional unfamiliar tool, or one the buyer will swap, is conditional — still a lead', () => {
    const r = c('Looking for a developer to automate our lead follow-ups', 'We tried Zapier but are open to suggestions. Budget £1,500.');
    expect(r).toMatchObject({ techFit: 'conditional', qualified: true });
    expect(r.optionalTech).toEqual(['zapier']);
    expect(r.missing).toContain('технология / объём работ');
  });

  it('the platform being replaced does not lower the fit: rebuilding a Bubble app in Next.js is core', () => {
    expect(c('Need a developer to rebuild our Bubble app in Next.js', 'Moving off Bubble, Postgres backend.').techFit).toBe('core');
  });

  it('website migrations: moving from WooCommerce or Wix to Shopify is core', () => {
    const woo = c('Quote for migrating our WooCommerce store to Shopify', 'About 800 products, customers and orders.');
    expect(woo).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core', qualified: true });
    expect(woo.fitAreas).toEqual(expect.arrayContaining(['Shopify и e-commerce', 'Миграция и модернизация']));
    expect(techFit('Move from Wix to Shopify', 'Need help moving our store.', config.capabilities).fit).toBe('core');
  });

  it('a fixed adjacent platform (WordPress) is an adjacent fit, never claimed as core expertise', () => {
    const r = c('Looking for a developer to build a WordPress website for my bakery', 'Five pages and a contact form.');
    expect(r).toMatchObject({ techFit: 'adjacent', qualified: true });
  });

  it('i18n: a multilingual Next.js site is core; translating copy is not our work', () => {
    const r = c('Need a developer to add multiple languages to our Next.js site', 'German and French, with hreflang and a language switcher.');
    expect(r).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core' });
    expect(r.fitAreas).toContain('Мультиязычность и локализация');
    expect(c('Looking for a translator for our website content', 'English to German.')).toMatchObject({ techFit: 'poor', buyerCategory: 'IRRELEVANT' });
  });

  it('Shopify + Klaviyo integration and Stripe subscriptions for a SaaS are core', () => {
    const k = c('Looking for a freelancer to connect Klaviyo flows with our Shopify store', 'Abandoned cart and post-purchase emails.');
    expect(k).toMatchObject({ buyerCategory: 'PROJECT_BUYER', techFit: 'core', qualified: true });
    const s = c('Need someone to build Stripe subscription billing for our SaaS', 'Monthly and annual plans with a billing portal.');
    expect(s).toMatchObject({ techFit: 'core', qualified: true });
    expect(s.fitAreas).toContain('Платежи, авторизация, аккаунты');
  });
});

describe('freshness, status and geography', () => {
  it('older than the window is reported but not shortlisted; an explicit [SOLVED] title is closed', () => {
    const old = c('Looking for a developer to build our company website', '', { publishedAt: '2026-08-20T10:00:00.000Z' });
    expect(old.qualified).toBe(false);
    expect(old.reasons.join(' ')).toContain('старше 30 дн.');
    expect(c('[SOLVED] Looking for a Shopify developer', 'Thanks all.')).toMatchObject({ status: 'closed', qualified: false });
    // Never assumed open just because the thread is online.
    expect(c('Looking for a developer to build our company website').status).toBe('unknown');
  });

  it('US-only or in-person-only requests are not reachable for a remote team abroad', () => {
    expect(c('US WooCommerce developer, hourly: new store project', 'WHO CAN APPLY: a United States-based person or small firm.')).toMatchObject({ remote: 'prohibited', qualified: false });
    expect(c('Looking for a web developer in Manchester', 'Must be local, I want to meet face to face.')).toMatchObject({ remote: 'prohibited', qualified: false });
    expect(c('Looking for a developer to build our company website', 'Remote is fine.').remote).toBe('permitted');
  });
});

describe('forum sources', () => {
  const XENFORO = `<?xml version="1.0"?><rss><channel>
    <item><title>PHP/MySQL Web Developer to Build &amp; Host a New Site</title><pubDate>Sat, 10 Oct 2026 16:31:08 +0000</pubDate>
      <link>https://www.ukbusinessforums.co.uk/threads/php-mysql-web-developer-to-build-host-a-new-site.429816/</link>
      <guid isPermaLink="false">urn:xenforo:thread:429816</guid><dc:creator>bizowner</dc:creator>
      <content:encoded><![CDATA[<div class="bbWrapper">We need a developer to build our new site.<br /><blockquote>quoted reply</blockquote>Budget £2k.</div>]]></content:encoded>
      <slash:comments>7</slash:comments></item>
    <item><title>Old thread</title><pubDate>Mon, 01 Jun 2026 10:00:00 +0000</pubDate><link>https://www.ukbusinessforums.co.uk/threads/old.1/</link></item>
  </channel></rss>`;
  const INVISION = `<rss><channel><item><title>Ik zoek een webbouwer</title><link><![CDATA[https://www.higherlevel.nl/forums/topic/1-ik-zoek-een-webbouwer/?do=findComment&comment=9]]></link>
    <description>Wie kan een webshop bouwen?</description><pubDate>Fri, 23 Oct 2026 09:17:00 +0000</pubDate></item></channel></rss>`;

  it('RSS (XenForo, Invision): the thread and its opening post; quotes dropped, window applied, topic URL kept', () => {
    const since = new Date('2026-09-26T00:00:00Z');
    const [x] = parseRss(XENFORO, { id: 'ukbf_websites', label: 'UKBF' }, since);
    expect(parseRss(XENFORO, { id: 'ukbf_websites', label: 'UKBF' }, since)).toHaveLength(1);
    expect(x).toMatchObject({ itemId: '429816', title: 'PHP/MySQL Web Developer to Build & Host a New Site', author: 'bizowner', replies: 7, publishedAt: '2026-10-10T16:31:08.000Z' });
    expect(x!.text).toBe('We need a developer to build our new site.\nBudget £2k.');
    const [h] = parseRss(INVISION, { id: 'higherlevel', label: 'HigherLevel' }, since);
    expect(h!.url).toBe('https://www.higherlevel.nl/forums/topic/1-ik-zoek-een-webbouwer/');
    // Feed dates are the last reply: flagged until the thread page is checked.
    expect([x!.dateIsActivity, h!.dateIsActivity]).toEqual([true, true]);
  });

  it('the thread start date comes from the thread page; an activity-dated thread is never shortlisted', () => {
    // UKBF, 2026-10-26: the RSS item said 10 Oct 2026, the thread was started on 9 Sep 2025.
    const xenforo = '<span class="u-srOnly">Start date</span> <a href="/threads/x.429816/"><time class="u-dt" dir="auto" datetime="2025-09-09T10:00:55+0100" data-timestamp="1757408455">';
    expect(threadStartFromHtml(xenforo)).toBe('2025-09-09T09:00:55.000Z');
    expect(threadStartFromHtml("<time datetime='2026-09-17T11:44:07Z' title='17-09-2026'>")).toBe('2026-09-17T11:44:07.000Z');
    expect(threadStartFromHtml('<p>no dates</p>')).toBeNull();
    const unchecked = c('Looking for a developer to build a booking system for our salon', 'Budget is £3,000.', { dateIsActivity: true });
    expect(unchecked.qualified).toBe(false);
    expect(unchecked.reasons.join(' ')).toContain('когда тема создана, не проверено');
  });

  class Routes implements Fetcher {
    readonly urls: string[] = [];
    constructor(private readonly routes: [RegExp, unknown][]) {}
    async fetch(url: string): Promise<FetchResult> {
      this.urls.push(url);
      const hit = this.routes.find(([re]) => re.test(url));
      return { requestedUrl: url, finalUrl: url, status: hit ? 200 : 404, contentType: 'application/json', body: hit ? JSON.stringify(hit[1]) : '', truncated: false };
    }
  }

  it('Discourse: busy categories read only request-like titles; topics before the window skipped', async () => {
    const topic = (id: number, title: string, created: string) => ({ id, slug: `t-${id}`, title, created_at: created, bumped_at: created, posts_count: 3 });
    const f = new Routes([
      [/\/c\/store-design\/133\.json\?page=0/, { topic_list: { topics: [topic(1, 'Need a developer for a custom product page section', '2026-10-20T00:00:00Z'), topic(2, 'How to change font colour', '2026-10-21T00:00:00Z'), topic(3, 'Looking for a developer', '2026-08-01T00:00:00Z')] } }],
      [/\/t\/1\.json/, { title: 'Need a developer for a custom product page section', created_at: '2026-10-20T00:00:00Z', post_stream: { posts: [{ username: 'merchant', cooked: '<p>Happy to pay, send your rate.</p>' }] } }],
    ]);
    const feed = config.intent.sources.forums.feeds.find((x) => x.id === 'shopify_community')!;
    const { requests, listed } = await fetchDiscourse(f, { ...feed, categories: [{ path: 'store-design/133', all: false }], max_pages: 1 }, new Date('2026-09-26T00:00:00Z'), (t) => titleLooksLikeRequest(t, config.intent));
    expect(listed).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://community.shopify.com/t/t-1/1', author: 'merchant', replies: 2, source: 'shopify_community' });
    expect(f.urls.some((u) => /\/t\/2\.json/.test(u))).toBe(false);
  });
});

describe('storage and report', () => {
  it('buyer category, technology fit and remote are stored (migration 007); forum posts have no source-level type', () => {
    const db = openDb(':memory:');
    migrate(db);
    saveRequests(db, [c('Looking for a developer to build a booking system for our salon', 'Remote is fine.')], '2026-10-26T00:00:00.000Z');
    expect(db.prepare('SELECT request_type, buyer_category, tech_fit, remote, skill_fit, qualified FROM intent_leads').all()).toEqual([
      { request_type: 'forum_post', buyer_category: 'PROJECT_BUYER', tech_fit: 'core', remote: 'permitted', skill_fit: 'high', qualified: 1 },
    ]);
  });

  it('the report separates direct buyers, recommendations, potential buyers, agencies and rejected staffing; earlier leads are marked', () => {
    const list = rankRequests(
      [
        c('Looking for a developer to build a booking system for our salon', 'Budget is £3,000.'),
        c('Can anyone recommend a web developer for a Shopify store redesign?'),
        c('How can I add a customer portal to my website?'),
        c('Looking for a white-label Shopify developer', 'An agency, paid per project for our clients.'),
        c('Looking for a Shopify developer to join our team', '20 hours per week.'),
      ],
      NOW,
    ).map((r, i) => ({ ...r, seenBefore: i === 4 ? null : null }));
    const md = intentMarkdown(list, { generatedAt: NOW, sources: [{ source: 'ukbf_looking_for', label: 'UKBF', scanned: 5, requests: 5, note: '' }], unavailable: [], llm: 'только правила, без LLM' });
    expect(md).toContain('## 1. Прямые заказчики — 1');
    expect(md).toContain('## 2. Просят порекомендовать исполнителя — 1');
    expect(md).toContain('## 3. Возможные заказчики — нужна проверка (1)');
    expect(md).toContain('## 4. Агентства ищут субподрядчика — 1');
    expect(md).toContain('### Найм / усиление команды — 1');
    expect(md).toContain('**Явных запросов покупателей** (прямой заказ или просьба порекомендовать исполнителя): 2');
    const seen = rankRequests([c('Looking for a developer to build a booking system for our salon')], NOW).map((r) => ({ ...r, seenBefore: 'discovery-20261025.csv' }));
    expect(intentMarkdown(seen, { generatedAt: NOW, sources: [], unavailable: [], llm: '' })).toContain('уже были в прошлых отчётах');
  });
});
