import { mailtoAddresses } from '../inspect/page.js';
import type { PageContext } from '../inspect/types.js';
import { emailOnDomain } from '../util/domain.js';

export type RoleHint = 'sales' | 'enquiries' | 'info' | 'support' | 'named';

export interface ContactCandidate {
  email: string;
  kind: 'role' | 'named';
  roleHint: RoleHint;
  /** Public mailbox provider (gmail, outlook, ISP mail): usually an individual, see outreach risk. */
  isFreemail: boolean;
  foundOnUrl: string;
}

// Public mailbox providers and ISP mail across our markets.
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.ie', 'hotmail.com', 'hotmail.co.uk', 'hotmail.nl',
  'outlook.com', 'outlook.ie', 'outlook.nl', 'live.com', 'live.co.uk', 'live.ie', 'live.nl', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net', 'eircom.net',
  'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'home.nl', 'hetnet.nl', 'xs4all.nl', 'protonmail.com', 'proton.me',
  'gmx.com', 'gmx.net', 'mail.ru', 'yandex.ru', 'yandex.kz', 'ya.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'rambler.ru',
  'mail.kz',
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

/**
 * Visible text with a space between text nodes. page.text joins adjacent elements directly,
 * so "<span>0161 456026</span><a>enquiries@x.co.uk</a>" would read as "456026enquiries@…".
 */
function spacedText(page: PageContext): string {
  const parts: string[] = [];
  page.$('body')
    .find('*')
    .not('script, style, noscript, template')
    .contents()
    .each((_, node) => {
      if (node.type === 'text') parts.push(node.data);
    });
  return parts.join(' ');
}

function roleOf(local: string): RoleHint {
  for (const [hint, re] of ROLE_LOCALS) if (re.test(local)) return hint;
  return 'named';
}

/**
 * Every publicly advertised business address on the site: the company's own domain, or a public
 * mailbox (gmail etc., common for independents). Addresses on unrelated domains (e.g. the web
 * agency's) are ignored. Whether an address may be cold-emailed is decided separately by
 * outreach risk, not here. Own-domain first, then by role.
 */
export function extractContacts(pages: PageContext[], companyDomain: string): ContactCandidate[] {
  const found = new Map<string, ContactCandidate>();
  for (const page of pages) {
    const raw = [...mailtoAddresses(page), ...(spacedText(page).match(EMAIL_IN_TEXT) ?? [])];
    for (const r of raw) {
      const email = normalize(r);
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || found.has(email)) continue;
      const [local, host] = email.split('@') as [string, string];
      const isFreemail = FREEMAIL.has(host);
      if (!isFreemail && !emailOnDomain(email, companyDomain)) continue;
      if (BLOCKED_LOCAL.test(local)) continue;
      const roleHint = roleOf(local);
      found.set(email, { email, kind: roleHint === 'named' ? 'named' : 'role', roleHint, isFreemail, foundOnUrl: page.url });
    }
  }
  return [...found.values()].sort(
    (a, b) => Number(a.isFreemail) - Number(b.isFreemail) || PRIORITY[a.roleHint] - PRIORITY[b.roleHint],
  );
}
