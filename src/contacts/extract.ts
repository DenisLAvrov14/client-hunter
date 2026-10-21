import type { MarketConfig, SegmentCode } from '../config/schema.js';
import { mailtoAddresses } from '../inspect/page.js';
import type { PageContext } from '../inspect/types.js';
import { emailOnDomain } from '../util/domain.js';

export type RoleHint = 'sales' | 'enquiries' | 'info' | 'support' | 'named';

export interface ContactCandidate {
  email: string;
  kind: 'role' | 'named';
  roleHint: RoleHint;
  foundOnUrl: string;
}

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'live.com', 'live.co.uk', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'btinternet.com', 'sky.com',
  'virginmedia.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.ru', 'yandex.ru', 'ya.ru', 'bk.ru',
  'list.ru', 'inbox.ru', 'rambler.ru',
]);

// spec 8.5: never write to these.
const BLOCKED_LOCAL = /^(no-?reply|do-?not-?reply|privacy|dpo|gdpr|data-?protection|jobs|careers|recruitment|hr|accounts|invoices?|billing|finance|webmaster|postmaster|abuse|unsubscribe)$/;

const ROLE_LOCALS: [RoleHint, RegExp][] = [
  ['sales', /^(sales|trade|trade-?sales|orders?)$/],
  ['enquiries', /^(enquir(y|ies)|inquir(y|ies)|quotes?|quotations?|estimating|estimates)$/],
  ['info', /^(info|hello|contact|office|admin|mail|general|reception|team|shop|store)$/],
  ['support', /^(support|help|customer-?service|customerservices?|cs|care)$/],
];

const PRIORITY: Record<RoleHint, number> = { sales: 0, enquiries: 1, info: 2, named: 3, support: 4 };

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+\s*(?:@|\[at\]|\(at\)|\{at\})\s*[a-z0-9.-]+\s*(?:\.|\[dot\]|\(dot\))\s*[a-z]{2,}(?:\s*(?:\.|\[dot\]|\(dot\))\s*[a-z]{2,})?/gi;

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*(?:\[at\]|\(at\)|\{at\})\s*/g, '@')
    .replace(/\s*(?:\[dot\]|\(dot\))\s*/g, '.')
    .replace(/\s+/g, '')
    .replace(/\.$/, '');
}

function roleOf(local: string): RoleHint {
  for (const [hint, re] of ROLE_LOCALS) if (re.test(local)) return hint;
  return 'named';
}

/** Extracts candidate addresses on the company's own domain, filtered by the market profile, best first. */
export function extractContacts(
  pages: PageContext[],
  companyDomain: string,
  market: MarketConfig,
  segment: SegmentCode,
): ContactCandidate[] {
  const found = new Map<string, ContactCandidate>();
  for (const page of pages) {
    const raw = [...mailtoAddresses(page), ...(page.text.match(EMAIL_IN_TEXT) ?? [])];
    for (const r of raw) {
      const email = normalize(r);
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || found.has(email)) continue;
      const [local, host] = email.split('@') as [string, string];
      if (FREEMAIL.has(host)) {
        if (!market.allow_freemail_addresses) continue;
      } else if (!emailOnDomain(email, companyDomain)) {
        continue;
      }
      if (BLOCKED_LOCAL.test(local)) continue;
      const roleHint = roleOf(local);
      // support@ is only a fallback for Shopify stores (spec 8.5).
      if (roleHint === 'support' && segment !== 'S1') continue;
      if (roleHint === 'named' && !market.allow_named_business_address) continue;
      found.set(email, { email, kind: roleHint === 'named' ? 'named' : 'role', roleHint, foundOnUrl: page.url });
    }
  }
  return [...found.values()].sort((a, b) => PRIORITY[a.roleHint] - PRIORITY[b.roleHint]);
}
