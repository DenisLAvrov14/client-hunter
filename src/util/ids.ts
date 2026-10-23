import { customAlphabet } from 'nanoid';

// Lowercase alphanumerics keep ids safe in file paths and Telegram callback data.
const random = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

export const ID_PREFIXES = {
  company: 'cmp',
  companySource: 'src',
  page: 'pg',
  observation: 'obs',
  trigger: 'trg',
  contact: 'ctc',
  dossier: 'dos',
  outreach: 'out',
  reply: 'rpl',
  decision: 'dec',
  deal: 'deal',
  suppression: 'sup',
  llmCall: 'llm',
  run: 'run',
  event: 'evt',
  inspection: 'ins',
  outreachRisk: 'ork',
  assessment: 'asm',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${random()}`;
}
