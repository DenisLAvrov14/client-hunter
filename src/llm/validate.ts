// Checks a screening answer against the digest. The model interprets; code verifies.
import type { CapabilityKey } from '../inspect/capabilities.js';
import type { Digest } from '../inspect/digest.js';
import type { ScreenResult } from './schemas.js';

export interface OpportunityCheck {
  /** The hook is a real finding id or a quote found verbatim on the cited page. */
  hookVerified: boolean;
  /** Capability the site already has that this opportunity seems to duplicate. */
  alreadyPresent: CapabilityKey | null;
}

export interface ScreenValidation {
  result: ScreenResult;
  opportunities: OpportunityCheck[];
  issues: string[];
  /** Worth asking the model once more (problems it can fix). */
  retry: boolean;
  /** Message for the retry, listing what to fix. */
  feedback: string;
}

/** Lowercase, unified quotes/dashes/spaces — so a faithful quote matches despite typography. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteFound(quote: string, pageUrl: string, digest: Digest): 'page' | 'other_page' | false {
  const q = normalizeForMatch(quote);
  if (q.length < 4) return false;
  const page = digest.pageTexts.get(pageUrl);
  if (page && normalizeForMatch(page).includes(q)) return 'page';
  for (const text of digest.pageTexts.values()) if (normalizeForMatch(text).includes(q)) return 'other_page';
  return false;
}

// Opportunity title words → capability that would make it redundant.
const DUPLICATES: [RegExp, CapabilityKey][] = [
  [/брон|запис|booking|appointment|schedul/i, 'online_booking'],
  [/интернет-магазин|корзин|онлайн-продаж|e-?commerce|online shop|checkout/i, 'cart_checkout'],
  [/калькулятор|конфигуратор|calculator|configurator/i, 'calculator_configurator'],
  [/поиск по (сайту|каталогу)|site search/i, 'site_search'],
  [/личный кабинет|кабинет клиента|portal/i, 'customer_login'],
  [/онлайн-чат|чат на сайте|live chat/i, 'live_chat'],
];

const NUMBERS_IN_CLAIM = /\d+\s?%|[£€$₽₸]\s?\d|\d\s?(раз|times)\b/i;

export function validateScreen(raw: ScreenResult, digest: Digest): ScreenValidation {
  const issues: string[] = [];
  const fixable: string[] = [];
  const result: ScreenResult = structuredClone(raw);
  const findingIds = new Set(digest.observations.map((o) => o.id));

  result.commercial_signals = result.commercial_signals.filter((s) => {
    const found = quoteFound(s.quote, s.page_url, digest);
    if (!found) {
      issues.push(`signal quote not found on the site: "${s.quote.slice(0, 80)}"`);
      fixable.push(`The quote "${s.quote.slice(0, 80)}" is not in the page text. Copy quotes exactly or omit them.`);
    } else if (found === 'other_page') {
      issues.push(`signal quote is on a different page than cited: "${s.quote.slice(0, 60)}"`);
    }
    return found !== false;
  });
  if (result.commercial_signals.length > 3) result.commercial_signals = result.commercial_signals.slice(0, 3);

  if (result.opportunities.length > 3) {
    issues.push(`${result.opportunities.length} opportunities returned, kept the first 3`);
    result.opportunities = result.opportunities.slice(0, 3);
  }

  const opportunities: OpportunityCheck[] = result.opportunities.map((o) => {
    let hookVerified = false;
    if (o.hook_type === 'finding') {
      hookVerified = findingIds.has(o.hook.trim());
      if (!hookVerified) {
        issues.push(`unknown finding id "${o.hook}" in "${o.title}"`);
        fixable.push(`"${o.hook}" is not a finding id from the digest. Use only listed ids.`);
      }
    } else if (o.hook_type === 'quote') {
      hookVerified = quoteFound(o.hook, o.hook_page_url, digest) !== false;
      if (!hookVerified) {
        issues.push(`opportunity quote not found on the site: "${o.hook.slice(0, 80)}"`);
        fixable.push(`The quote "${o.hook.slice(0, 80)}" (for "${o.title}") is not in the page text. Copy it exactly.`);
      }
    }
    let alreadyPresent: CapabilityKey | null = null;
    for (const [re, key] of DUPLICATES) {
      if (re.test(o.title) && digest.capabilities?.flags[key]?.present) {
        alreadyPresent = key;
        issues.push(`"${o.title}" may duplicate what the site already has (${key})`);
        break;
      }
    }
    if (NUMBERS_IN_CLAIM.test(o.why)) issues.push(`numbers in the benefit claim of "${o.title}"`);
    return { hookVerified, alreadyPresent };
  });

  // Hard rules owned by code, not the model (spec 5.4).
  const forcedSkip: string[] = [];
  if (result.is_it_or_web_agency) forcedSkip.push('IT/веб-компания (конкурент)');
  if (result.size === 'large_or_chain') forcedSkip.push('крупная компания или сеть');
  if (result.commercial_activity === 'none') forcedSkip.push('нет коммерческой деятельности');
  if (forcedSkip.length && result.decision !== 'skip') {
    issues.push(`decision ${result.decision} → skip by rule: ${forcedSkip.join(', ')}`);
    result.decision = 'skip';
    result.decision_reason = `${forcedSkip.join(', ')}. ${result.decision_reason}`;
  }

  if (result.decision !== 'skip' && result.opportunities.length === 0) {
    fixable.push('Decision is not "skip" but no opportunities were given. Give 1-3 or decide "skip".');
  }
  const strong = opportunities.some((o) => o.hookVerified && !o.alreadyPresent);
  if (result.decision === 'deep' && !strong) {
    fixable.push('Decision "deep" needs at least one opportunity with a verified hook (finding id or exact quote) for something the site does not already have.');
  }

  return {
    result,
    opportunities,
    issues,
    retry: fixable.length > 0,
    feedback: fixable.length ? `Your previous answer had problems:\n- ${fixable.join('\n- ')}\nAnswer again, fixing them.` : '',
  };
}

/** After the last attempt: settle anything still unfixed conservatively. */
export function finalizeScreen(v: ScreenValidation): ScreenValidation {
  const result = structuredClone(v.result);
  const issues = [...v.issues];
  const strong = v.opportunities.some((o) => o.hookVerified && !o.alreadyPresent);
  if (result.decision === 'deep' && !strong) {
    result.decision = 'maybe';
    issues.push('deep → maybe: no verified hook after retry');
  }
  if (result.decision !== 'skip' && result.opportunities.length === 0) {
    result.decision = 'skip';
    issues.push('→ skip: no opportunities after retry');
  }
  return { ...v, result, issues, retry: false, feedback: '' };
}
