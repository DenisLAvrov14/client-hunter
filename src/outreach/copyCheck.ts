// Code-side checks of a draft outreach message (spec 9.3, 10; config/copy-rules.yaml).
// The LLM writes; code decides whether the draft may be shown to the operator as usable.
import type { CopyRulesConfig } from '../config/schema.js';
import { registrableDomain } from '../util/domain.js';

export interface DraftCheckInput {
  subject: string;
  body: string;
  language: string;
  expectedLanguage: string;
  mode: 'offer' | 'permission_request';
  /** Registrable domain of the recipient's site; links to it are allowed. */
  companyDomain: string;
  /** The recipient's name: digits in a name like "A1deSIGNS" are not a claimed number. */
  companyName?: string | null;
  /** Extra allowed link hosts, e.g. the sender's own site. */
  extraAllowedHosts?: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word / whole-phrase match that also works for Cyrillic. */
function containsTerm(text: string, term: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Problems found in a draft; empty means it passes. Operator-facing (Russian). */
export function checkDraft(rules: CopyRulesConfig, d: DraftCheckInput): string[] {
  const issues: string[] = [];
  if (d.language !== d.expectedLanguage) issues.push(`язык письма ${d.language}, а для рынка нужен ${d.expectedLanguage}`);
  if (words(d.subject) > rules.limits.subject_max_words) issues.push(`тема длиннее ${rules.limits.subject_max_words} слов`);
  if (words(d.body) > rules.limits.first_email_max_words) issues.push(`письмо длиннее ${rules.limits.first_email_max_words} слов`);

  const urls = d.body.match(URL_RE) ?? [];
  const allowed = new Set(
    [...rules.allowed_link_hosts, ...(d.extraAllowedHosts ?? []), d.companyDomain]
      .map((h) => registrableDomain(h) ?? h)
      .filter(Boolean),
  );
  for (const u of urls) {
    const host = registrableDomain(u.startsWith('www.') ? `https://${u}` : u);
    if (!host || !allowed.has(host)) issues.push(`ссылка не из разрешённых: ${u}`);
  }
  if (d.mode === 'permission_request' && urls.some((u) => registrableDomain(u) !== d.companyDomain)) {
    issues.push('в режиме permission_request ссылки на портфолио не допускаются (только во втором письме)');
  }

  let bodyWithoutUrls = `${d.subject}\n${d.body.replace(URL_RE, ' ')}`;
  for (const name of [d.companyName, d.companyDomain]) {
    if (name) bodyWithoutUrls = bodyWithoutUrls.replace(new RegExp(escapeRe(name), 'giu'), ' ');
  }
  for (const term of rules.banned_terms) {
    if (containsTerm(bodyWithoutUrls, term)) issues.push(`запрещённое выражение: «${term}»`);
  }
  for (const pattern of rules.banned_patterns) {
    if (new RegExp(pattern, 'u').test(bodyWithoutUrls)) issues.push(`запрещённый шаблон (${pattern}): цифры, проценты и суммы в письме недопустимы`);
  }
  for (const optOut of Object.values(rules.opt_out)) {
    if (d.body.includes(optOut.slice(0, 25))) issues.push('строку отказа добавляет код, модель не должна её писать');
  }
  if (/!/.test(d.body)) issues.push('восклицательные знаки недопустимы');
  return [...new Set(issues)];
}

/** The final text shown to the operator: draft + opt-out line added by code (spec 10.3). */
export function withOptOut(rules: CopyRulesConfig, body: string, language: string): string {
  const optOut = rules.opt_out[language] ?? rules.opt_out.en ?? '';
  return `${body.trim()}\n\n${optOut}`.trim();
}
