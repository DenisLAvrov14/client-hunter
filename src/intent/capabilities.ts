// Technology fit against the Service Capability Profile (config/capabilities.yaml). Judges the
// requested deliverable, not keywords alone: a mandatory Bubble / n8n / native-mobile requirement
// is a poor fit, a passing mention of one is only conditional, and a request that names no
// technology still matches through the business problem it describes ("need a customer portal").
import type { CapabilitiesConfig } from '../config/schema.js';
import { hasTerm, hasTermOrPlural } from './text.js';

/**
 * core — our own work; adjacent — conditional capability (WordPress, an unfamiliar CRM with an API);
 * conditional — our kind of work, but with an optional poor-fit platform or an unclear deliverable;
 * poor — a mandatory platform / stack we do not offer, or not development at all.
 */
export type TechFit = 'core' | 'adjacent' | 'conditional' | 'poor';

export interface FitResult {
  fit: TechFit;
  /** Labels of the matched capability areas (core first). */
  areas: string[];
  core: string[];
  adjacent: string[];
  /** Poor-fit terms that the request makes a requirement. */
  mandatory: string[];
  /** Poor-fit terms mentioned without being required. */
  optional: string[];
  alternativesOk: boolean;
  /** The title asks for design / marketing / content / hosting, not for something to be built. */
  nonDev: boolean;
  /** Operator-facing explanation (Russian). */
  reason: string;
}

type PoorKind = Exclude<keyof CapabilitiesConfig['poor_fit'], 'alternatives_ok' | 'non_dev'>;
const POOR_KINDS: PoorKind[] = ['platforms', 'native_mobile', 'games', 'specialist_platforms', 'enterprise_stack', 'data_science'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A term reads as a requirement when the text asks for it, not when it merely mentions it. */
const requirement = (term: string) =>
  new RegExp(
    `(?:must|required|requires?|need(?:s|ed)?|expert (?:in|with)|experience (?:in|with)|proficient (?:in|with)|skilled in|built (?:in|on|with)|build (?:it )?(?:in|on|with)|using)\\s+(?:an?\\s+|the\\s+)?${esc(term)}(?![\\p{L}\\p{N}])` +
      `|(?<![\\p{L}\\p{N}])${esc(term)}\\s+(?:developer|developers|expert|experts|specialist|builder|consultant|freelancer|agency|engineer)s?\\b`,
    'u',
  );
/** The platform the buyer is moving away from ("migrate from Wix", "replace our Bubble app") is not a requirement. */
const leaving = (term: string) =>
  new RegExp(
    `(?:from|off|away from|out of|replace|replacing|leaving|leave|migrate|migrating|move|moving|rebuild|rebuilding)\\s+(?:of\\s+)?(?:our\\s+|my\\s+|the\\s+|an?\\s+)?(?:existing\\s+|current\\s+|old\\s+)?${esc(term)}(?![\\p{L}\\p{N}])`,
    'u',
  );
/** A title asking for something to be made, so "logo and website built" is not pure design work. */
const BUILD = /\b(build|built|develop|developer|development|create|make|redesign|rebuild|programmer|coder|app|software)\b/;

const found = (textLower: string, terms: readonly string[]) => terms.filter((t) => hasTermOrPlural(textLower, t));

export function techFit(header: string, text: string, profile: CapabilitiesConfig): FitResult {
  const h = header.toLowerCase();
  const t = `${header}\n${text}`.toLowerCase();
  const coreAreas: string[] = [];
  const adjacentAreas: string[] = [];
  const core = new Set<string>();
  const adjacent = new Set<string>();
  for (const area of Object.values(profile.areas)) {
    const hits = found(t, [...area.technologies, ...area.services]);
    if (!hits.length) continue;
    (area.fit === 'core' ? coreAreas : adjacentAreas).push(area.label);
    for (const x of hits) (area.fit === 'core' ? core : adjacent).add(x);
  }
  const alternativesOk = found(t, profile.poor_fit.alternatives_ok).length > 0;
  const mandatory: string[] = [];
  const optional: string[] = [];
  for (const kind of POOR_KINDS) {
    for (const term of found(t, profile.poor_fit[kind])) {
      // The platform being replaced does not lower the fit: the new build is ours.
      if (leaving(term).test(t)) continue;
      (hasTerm(h, term) || requirement(term).test(t) ? mandatory : optional).push(term);
    }
  }
  const nonDevTitle = found(h, profile.poor_fit.non_dev);
  const nonDev = nonDevTitle.length > 0 && !BUILD.test(h);
  const base = { areas: [...coreAreas, ...adjacentAreas], core: [...core], adjacent: [...adjacent], mandatory, optional, alternativesOk, nonDev };

  if (nonDev) return { ...base, fit: 'poor', reason: `не разработка: «${nonDevTitle.join(', ')}»` };
  if (mandatory.length && !alternativesOk) return { ...base, fit: 'poor', reason: `обязательна платформа / стек, который мы не предлагаем: ${mandatory.join(', ')}` };
  if (core.size) {
    if (mandatory.length || optional.length) {
      return { ...base, fit: 'conditional', reason: `наша работа (${coreAreas.join(', ')}), но упомянуто: ${[...mandatory, ...optional].join(', ')}${alternativesOk ? ' — автор допускает альтернативу' : ''}` };
    }
    // The buyer fixed an adjacent platform ("WooCommerce store"): we can do it, not as core expertise.
    const adjacentRequired = [...adjacent].filter((x) => !leaving(x).test(t) && (hasTerm(h, x) || requirement(x).test(t)));
    if (adjacentRequired.length) return { ...base, fit: 'adjacent', reason: `смежная платформа: ${adjacentRequired.join(', ')} (${coreAreas.join(', ')})` };
    return { ...base, fit: 'core', reason: `наши услуги: ${coreAreas.join(', ')} (${[...core].slice(0, 6).join(', ')})` };
  }
  if (adjacent.size) return { ...base, fit: 'adjacent', reason: `только смежные технологии: ${[...adjacent].join(', ')}` };
  if (mandatory.length || optional.length) {
    return { ...base, fit: 'conditional', reason: `упомянуто: ${[...mandatory, ...optional].join(', ')}${alternativesOk ? ' — автор допускает альтернативу' : ' (не как требование)'}` };
  }
  return { ...base, fit: 'conditional', reason: 'не указаны ни технология, ни понятный тип решения — нужно уточнение' };
}
