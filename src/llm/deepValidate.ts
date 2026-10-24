// Code-side verification of a stage C answer. The model labels its claims; code checks the
// labels against the digest and downgrades anything the evidence does not carry.
import type { CopyRulesConfig } from '../config/schema.js';
import type { CapabilityKey } from '../inspect/capabilities.js';
import { checkDraft } from '../outreach/copyCheck.js';
import { normalizeLink, type DeepInput } from './deepInput.js';
import type { DeepResult, StatementT } from './schemas.js';
import { DUPLICATES, NUMBERS_IN_CLAIM, quoteFound } from './validate.js';

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
  /** Draft problems; non-empty after the final attempt means the draft is withheld. */
  outreachIssues: string[];
  /** Validated URLs to read before the second pass. */
  needPages: string[];
}

type Strength = 'strong' | 'weak' | 'invalid';

const CONFIRMED_WORDS = /подтвержд|проверен|confirmed|verified|точно установлен/i;

/** strong: verified finding, quote on the site, capability present; weak: likely finding, capability absent. */
function evidenceStrength(e: StatementT['evidence'][number], input: DeepInput): Strength {
  const d = input.digest;
  switch (e.type) {
    case 'finding': {
      const o = d.observations.find((x) => x.id === e.ref.trim());
      if (!o) return 'invalid';
      return o.status === 'verified' ? 'strong' : 'weak';
    }
    case 'quote':
      return quoteFound(e.ref, e.page_url, d) !== false ? 'strong' : 'invalid';
    case 'capability': {
      const cap = d.capabilities?.flags[e.ref.trim() as CapabilityKey];
      if (!cap) return 'invalid';
      // Code can miss a widget, so "the site has no X" is weaker than "the site has X".
      return cap.present ? 'strong' : 'weak';
    }
    default:
      return 'invalid';
  }
}

export function validateDeep(raw: DeepResult, input: DeepInput, ctx: DeepContext): DeepValidation {
  const result: DeepResult = structuredClone(raw);
  const issues: string[] = [];
  const fixable: string[] = [];

  const checkStatement = (s: StatementT, where: string): StatementT => {
    const graded = s.evidence.map((e) => ({ e, strength: evidenceStrength(e, input) }));
    for (const g of graded.filter((x) => x.strength === 'invalid' && x.e.type !== 'none')) {
      issues.push(`${where}: unverifiable evidence (${g.e.type}: "${g.e.ref.slice(0, 60)}")`);
      if (g.e.type === 'quote') fixable.push(`The quote "${g.e.ref.slice(0, 60)}" is not in the page text. Copy quotes exactly or drop them.`);
      if (g.e.type === 'finding') fixable.push(`"${g.e.ref}" is not a finding id from the digest.`);
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
  result.existing_capabilities = result.existing_capabilities.map((s) => checkStatement(s, 'capabilities'));

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
      if (re.test(o.title) && input.digest.capabilities?.flags[key]?.present && o.already_exists === 'no') {
        issues.push(`opportunity ${i + 1} "${o.title}": code detects ${key} on the site, but already_exists = no`);
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

  const outreachIssues = checkDraft(ctx.rules, {
    subject: result.outreach.subject,
    body: result.outreach.body,
    language: result.outreach.language,
    expectedLanguage: ctx.expectedLanguage,
    mode: ctx.mode,
    companyDomain: ctx.companyDomain,
    companyName: ctx.companyName,
  });
  if (outreachIssues.length) fixable.push(`The outreach draft breaks these rules: ${outreachIssues.join('; ')}. Rewrite it.`);

  const needPages: string[] = [];
  if (ctx.allowExtraPages) {
    for (const p of result.need_pages) {
      const key = normalizeLink(p.url);
      if (!input.knownLinks.has(key)) issues.push(`need_pages: ${p.url} is not a known internal link, ignored`);
      else if (needPages.length < 3 && !needPages.includes(key)) needPages.push(key);
    }
  }

  return {
    result,
    issues,
    retry: fixable.length > 0,
    feedback: fixable.length ? `Your previous answer had problems:\n- ${[...new Set(fixable)].join('\n- ')}\nAnswer again, fixing them.` : '',
    eligible,
    outreachIssues,
    needPages,
  };
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
  return { ...v, result, issues, retry: false, feedback: '' };
}
