// Code-side verification of a stage C answer. The model labels its claims; code checks the
// labels against the digest and downgrades anything the evidence does not carry.
import type { CopyRulesConfig } from '../config/schema.js';
import { resolveCapabilityRef } from '../inspect/capabilities.js';
import { checkDraft } from '../outreach/copyCheck.js';
import { normalizeLink, type DeepInput } from './deepInput.js';
import type { DeepResult, StatementT } from './schemas.js';
import { DUPLICATES, NUMBERS_IN_CLAIM, quoteSource } from './validate.js';

/** Extra pages the model may have read on its first pass. */
export const MAX_EXTRA_PAGES = 3;

export interface DeepContext {
  rules: CopyRulesConfig;
  expectedLanguage: string;
  mode: 'offer' | 'permission_request';
  companyDomain: string;
  companyName: string | null;
  /** First pass only: the model may ask for extra pages. */
  allowExtraPages: boolean;
}

export interface DeepValidation {
  result: DeepResult;
  issues: string[];
  /** Problems the model can fix in one more attempt. */
  retry: boolean;
  feedback: string;
  /** Per opportunity: grounded in observed evidence and not something the site already has. */
  eligible: boolean[];
  /** Copy-rule problems of the draft (config/copy-rules.yaml). */
  draftRuleIssues: string[];
  /** Copy-rule and grounding problems; non-empty after the final attempt means the draft is unusable. */
  outreachIssues: string[];
  /** Validated URLs to read before the second pass. */
  needPages: string[];
}

type Strength = 'strong' | 'weak' | 'invalid';

const CONFIRMED_WORDS = /подтвержд|проверен|confirmed|verified|точно установлен/i;

type Evidence = StatementT['evidence'][number];

interface Graded {
  e: Evidence;
  strength: Strength;
  /** A quote found on another page: the URL the model gave (e.page_url is the real one). */
  miscitedAs?: string;
  /** A capability the code sees as absent, cited for "the site has it". */
  contradicts?: boolean;
}

/**
 * strong: verified finding, quote on the cited page, capability present; weak: likely finding,
 * capability absent, quote found only on another page. A miscited quote is kept with its real
 * page URL, never with the wrong one. A capability ref is stored as its canonical key.
 * `claimsPresence` (statements about what the site already has): an absent capability
 * contradicts the claim instead of weakly supporting it.
 */
function gradeEvidence(e: Evidence, input: DeepInput, claimsPresence: boolean): Graded {
  const d = input.digest;
  switch (e.type) {
    case 'finding': {
      const o = d.observations.find((x) => x.id === e.ref.trim());
      if (!o) return { e, strength: 'invalid' };
      return { e, strength: o.status === 'verified' ? 'strong' : 'weak' };
    }
    case 'quote': {
      const src = quoteSource(e.ref, e.page_url, d);
      if (!src) return { e, strength: 'invalid' };
      if (src.onCitedPage) return { e, strength: 'strong' };
      return { e: { ...e, page_url: src.url }, strength: 'weak', miscitedAs: e.page_url };
    }
    case 'capability': {
      const key = resolveCapabilityRef(e.ref);
      const cap = key ? d.capabilities?.flags[key] : undefined;
      if (!key || !cap) return { e, strength: 'invalid' };
      const canonical = { ...e, ref: key, page_url: '' };
      if (!cap.present && claimsPresence) return { e: canonical, strength: 'invalid', contradicts: true };
      // Code can miss a widget, so "the site has no X" is weaker than "the site has X".
      return { e: canonical, strength: cap.present ? 'strong' : 'weak' };
    }
    default:
      return { e, strength: 'invalid' };
  }
}

export function validateDeep(raw: DeepResult, input: DeepInput, ctx: DeepContext): DeepValidation {
  const result: DeepResult = structuredClone(raw);
  const issues: string[] = [];
  const fixable: string[] = [];

  const checkStatement = (s: StatementT, where: string, claimsPresence = false): StatementT => {
    const graded = s.evidence.map((e) => gradeEvidence(e, input, claimsPresence));
    for (const g of graded.filter((x) => x.miscitedAs !== undefined)) {
      issues.push(`${where}: quote "${g.e.ref.slice(0, 60)}" is on ${g.e.page_url}, not on the cited ${g.miscitedAs || '(none)'}`);
      fixable.push(`The quote "${g.e.ref.slice(0, 60)}" is on ${g.e.page_url}, not on ${g.miscitedAs || 'the page you cited'}. Cite the page the quote is on.`);
    }
    for (const g of graded.filter((x) => x.contradicts)) {
      issues.push(`${where}: "${s.text.slice(0, 60)}" says the site has ${g.e.ref}, but code does not detect it`);
      fixable.push(`"${s.text.slice(0, 60)}": code does not detect ${g.e.ref} on the site (marked "no"). Do not list it as something the site already has.`);
    }
    for (const g of graded.filter((x) => x.strength === 'invalid' && !x.contradicts && x.e.type !== 'none')) {
      issues.push(`${where}: unverifiable evidence (${g.e.type}: "${g.e.ref.slice(0, 60)}")`);
      if (g.e.type === 'quote') fixable.push(`The quote "${g.e.ref.slice(0, 60)}" is not in the page text. Copy quotes exactly or drop them.`);
      if (g.e.type === 'finding') fixable.push(`"${g.e.ref}" is not a finding id from the digest.`);
      if (g.e.type === 'capability') {
        fixable.push(`"${g.e.ref.slice(0, 40)}" is not a capability key. Cite the key exactly as listed, e.g. cart_checkout, inquiry_form, prices_visible.`);
      }
    }
    const kept = graded.filter((x) => x.strength !== 'invalid');
    const strong = kept.some((x) => x.strength === 'strong');
    let kind = s.kind;
    if (kind === 'fact' && !strong) {
      kind = kept.length ? 'inference' : 'hypothesis';
      issues.push(`${where}: "${s.text.slice(0, 60)}" fact → ${kind} (no strong evidence)`);
    } else if (kind === 'inference' && kept.length === 0) {
      kind = 'hypothesis';
      issues.push(`${where}: "${s.text.slice(0, 60)}" inference → hypothesis (no evidence)`);
    }
    if (!strong && CONFIRMED_WORDS.test(s.text)) {
      issues.push(`${where}: "${s.text.slice(0, 60)}" calls something confirmed without strong evidence`);
      fixable.push(`"${s.text.slice(0, 60)}" says confirmed/verified, but its evidence is only a heuristic ("likely") or absent. Do not call it confirmed.`);
    }
    return { ...s, kind, evidence: kept.map((x) => x.e) };
  };

  result.customer_journey = result.customer_journey.map((s) => checkStatement(s, 'journey'));
  result.existing_capabilities = result.existing_capabilities.map((s) => checkStatement(s, 'capabilities', true));

  if (result.opportunities.length > 3) {
    issues.push(`${result.opportunities.length} opportunities returned, kept the first 3`);
    result.opportunities = result.opportunities.slice(0, 3);
  }
  const eligible = result.opportunities.map((o, i) => {
    o.observed = o.observed.map((s) => checkStatement(s, `opportunity ${i + 1} observed`));
    o.value = o.value.map((s) => checkStatement(s, `opportunity ${i + 1} value`));
    for (const s of o.value) if (NUMBERS_IN_CLAIM.test(s.text)) issues.push(`opportunity ${i + 1}: numbers in a value claim`);

    const grounded = o.observed.some((s) => s.kind === 'fact' || s.kind === 'inference');
    let duplicate = o.already_exists === 'yes';
    for (const [re, key] of DUPLICATES) {
      // "unknown" is not an excuse: code already knows the site has it.
      if (re.test(o.title) && input.digest.capabilities?.flags[key]?.present && (o.already_exists === 'no' || o.already_exists === 'unknown')) {
        issues.push(`opportunity ${i + 1} "${o.title}": code detects ${key} on the site, but already_exists = ${o.already_exists}`);
        fixable.push(`"${o.title}": the site already shows ${key}. Either set already_exists and describe what is missing, or drop it.`);
        duplicate = true;
      }
    }
    if (!grounded) issues.push(`opportunity ${i + 1} "${o.title}": nothing observed on the site supports it`);
    return grounded && !duplicate;
  });

  const best = result.best_opportunity_index;
  const bestOk = Number.isInteger(best) && best >= 0 && best < result.opportunities.length && eligible[best] === true;
  if (!bestOk && eligible.some(Boolean)) {
    fixable.push('best_opportunity_index must point to an opportunity grounded in observed evidence that the site does not already have.');
  }
  if (result.recommendation === 'pursue' && !eligible.some(Boolean)) {
    fixable.push('"pursue" needs at least one opportunity grounded in observed evidence. Otherwise answer "maybe" or "drop" — that is a fine result.');
  }

  const draftRuleIssues = checkDraft(ctx.rules, {
    subject: result.outreach.subject,
    body: result.outreach.body,
    language: result.outreach.language,
    expectedLanguage: ctx.expectedLanguage,
    mode: ctx.mode,
    companyDomain: ctx.companyDomain,
    companyName: ctx.companyName,
  });
  if (draftRuleIssues.length) fixable.push(`The outreach draft breaks these rules: ${draftRuleIssues.join('; ')}. Rewrite it.`);
  const grounding = draftGrounding(result, eligible);
  fixable.push(...grounding.map((g) => g.fix));

  for (const [where, text] of russianTexts(result)) {
    if (mixedLanguage(text)) {
      issues.push(`${where}: English words in Russian text: "${text.slice(0, 60)}"`);
      fixable.push(`Write "${text.slice(0, 60)}" fully in Russian (only quotes stay in the site's language).`);
    }
  }

  const needPages: string[] = [];
  if (ctx.allowExtraPages) {
    for (const p of result.need_pages) {
      const key = normalizeLink(p.url);
      if (!input.knownLinks.has(key)) issues.push(`need_pages: ${p.url} is not a known internal link, ignored`);
      else if (needPages.length < MAX_EXTRA_PAGES && !needPages.includes(key)) needPages.push(key);
    }
  }

  return {
    result,
    issues,
    retry: fixable.length > 0,
    feedback: fixable.length ? `Your previous answer had problems:\n- ${[...new Set(fixable)].join('\n- ')}\nAnswer again, fixing them.` : '',
    eligible,
    draftRuleIssues,
    outreachIssues: [...draftRuleIssues, ...grounding.map((g) => g.issue)],
    needPages,
  };
}

/**
 * Is the draft about the chosen proposal, and does it present its observation no more strongly
 * than the evidence allows? `issue` is operator-facing (Russian), `fix` is feedback for the model.
 * A fact may be stated; an inference only asked about; a hypothesis is no basis for a message.
 */
export function draftGrounding(result: DeepResult, eligible: boolean[]): { issue: string; fix: string }[] {
  const d = result.outreach;
  const best = result.opportunities[result.best_opportunity_index];
  const opp = result.opportunities[d.opportunity_index];
  if (!opp) {
    return [{ issue: 'черновик не привязан ни к одному предложению', fix: 'outreach.opportunity_index must point to the proposal the draft makes (best_opportunity_index).' }];
  }
  const out: { issue: string; fix: string }[] = [];
  if (d.opportunity_index !== result.best_opportunity_index) {
    out.push({
      issue: `черновик предлагает «${opp.title}», а выбранное предложение — «${best?.title ?? '?'}»`,
      fix: `The draft is about "${opp.title}" but best_opportunity_index is "${best?.title ?? '?'}". Write the draft about the best opportunity.`,
    });
  }
  if (!eligible[d.opportunity_index]) {
    out.push({
      issue: `предложение черновика «${opp.title}» не подтверждено наблюдениями или уже есть на сайте`,
      fix: `"${opp.title}" is not grounded or already exists; the draft must be about an eligible opportunity.`,
    });
  }
  const s = opp.observed[d.observation_index];
  if (!s) {
    out.push({
      issue: 'наблюдение, на котором строится черновик, не указано среди наблюдений предложения',
      fix: "outreach.observation_index must point to the observation in that opportunity's `observed` that the body mentions.",
    });
  } else if (s.kind === 'inference' && d.framing !== 'question') {
    out.push({
      issue: `черновик подаёт как наблюдение то, что является только выводом: «${s.text.slice(0, 80)}»`,
      fix: `"${s.text.slice(0, 60)}" is only an inference: the draft must ask about it (framing "question"), not state it as seen.`,
    });
  } else if (s.kind === 'hypothesis' || s.kind === 'unknown') {
    out.push({
      issue: `черновик опирается на непроверенное предположение: «${s.text.slice(0, 80)}»`,
      fix: `"${s.text.slice(0, 60)}" is not shown by any evidence; base the draft on a fact or an inference from the observed list.`,
    });
  }
  return out;
}

/** Russian-only model text (quotes inside «» or "" may stay in the site's language). */
function russianTexts(r: DeepResult): [string, string][] {
  const st = (where: string, items: StatementT[]) => items.map((s): [string, string] => [where, s.text]);
  return [
    ['summary', r.business_summary],
    ['business model', r.business_model],
    ...r.offering.map((t): [string, string] => ['offering', t]),
    ...st('journey', r.customer_journey),
    ...st('capabilities', r.existing_capabilities),
    ...r.opportunities.flatMap((o, i): [string, string][] => [
      [`opportunity ${i + 1}`, o.title],
      [`opportunity ${i + 1}`, o.proposal],
      [`opportunity ${i + 1}`, o.already_exists_note],
      ...st(`opportunity ${i + 1}`, [...o.observed, ...o.value]),
      ...o.open_questions.map((q): [string, string] => [`opportunity ${i + 1} question`, q]),
    ]),
    ['best reason', r.best_reason],
    ['recommendation', r.recommendation_reason],
    ...r.unknowns.map((u): [string, string] => ['unknowns', u]),
  ];
}

// Common English function words; brand and product names (Shopify, LED, FTL) never match.
const ENGLISH_FUNCTION_WORDS = /(?<![\p{L}])(how|what|which|when|where|why|the|and|with|your|our|is|are|does|do|of|to|for)(?![\p{L}])/iu;

/** Cyrillic text with English function words outside quotes, e.g. "Как клиенты ... и how часто". */
export function mixedLanguage(text: string): boolean {
  if (!/[а-яё]/i.test(text)) return false;
  const unquoted = text.replace(/«[^»]*»|"[^"]*"|“[^”]*”|https?:\/\/\S+/g, ' ');
  return ENGLISH_FUNCTION_WORDS.test(unquoted);
}

/** After the last attempt: settle the decision conservatively instead of trusting the model. */
export function finalizeDeep(v: DeepValidation): DeepValidation {
  const result = structuredClone(v.result);
  const issues = [...v.issues];
  const firstEligible = v.eligible.findIndex(Boolean);
  if (firstEligible === -1) {
    if (result.recommendation === 'pursue') {
      result.recommendation = 'maybe';
      issues.push('pursue → maybe: no opportunity grounded in observed evidence');
    }
  } else if (!v.eligible[result.best_opportunity_index]) {
    issues.push(`best opportunity ${result.best_opportunity_index + 1} → ${firstEligible + 1}: the chosen one was not grounded or already exists`);
    result.best_opportunity_index = firstEligible;
  }
  // "pursue" needs the chosen proposal to rest on at least one fact; inferences alone make it "maybe".
  // Missing internal metrics (volumes, staff) never block it, and code never upgrades to "pursue".
  const best = result.opportunities[result.best_opportunity_index];
  if (result.recommendation === 'pursue' && best && !best.observed.some((s) => s.kind === 'fact')) {
    result.recommendation = 'maybe';
    issues.push('pursue → maybe: the chosen proposal rests on inferences only, no verified fact');
  }
  // The draft is judged against the final choice (the best pick may have moved above).
  const outreachIssues = [...v.draftRuleIssues, ...draftGrounding(result, v.eligible).map((g) => g.issue)];
  if (result.recommendation === 'drop') outreachIssues.push('рекомендация «не предлагать» — черновик не использовать');
  return { ...v, result, issues, outreachIssues, retry: false, feedback: '' };
}
