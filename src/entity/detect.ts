import type { MarketCode, MarketConfig } from '../config/schema.js';
import type { PageContext } from '../inspect/types.js';

export type EntityType = 'ltd' | 'plc' | 'llp' | 'dac' | 'bv' | 'nv' | 'ooo' | 'ao' | 'too' | 'sole_trader' | 'unknown';

export interface EntityResult {
  entityType: EntityType;
  evidence: string | null;
  evidenceUrl: string | null;
  registryId: string | null;
}

const MARKER_TYPES: Record<string, EntityType> = {
  ltd: 'ltd',
  limited: 'ltd',
  teoranta: 'ltd',
  teo: 'ltd',
  plc: 'plc',
  llp: 'llp',
  dac: 'dac',
  'b.v.': 'bv',
  bv: 'bv',
  'n.v.': 'nv',
  nv: 'nv',
  ооо: 'ooo',
  ао: 'ao',
  пао: 'ao',
  тоо: 'too',
};

// Registration numbers near their usual labels (spec 8.6).
const REGISTRY_ID: Partial<Record<MarketCode, RegExp>> = {
  UK: /(?:company\s*(?:registration\s*)?(?:no\.?|number|reg(?:istration)?\.?\s*no\.?)|registered\s+in\s+(?:england|wales|scotland|northern ireland)[^.\d]{0,60}?(?:no\.?|number)?)\s*:?\s*([A-Z]{2}\d{6}|\d{8})\b/i,
  IE: /\bCRO\s*(?:no\.?|number)?\s*:?\s*(\d{4,7})\b/i,
  NL: /\bK\.?v\.?K\.?\s*(?:-?nummer|nr\.?|number|no\.?)?\s*:?\s*(\d{8})\b/i,
  // \b is ASCII-only in JS, so Cyrillic labels use explicit lookarounds.
  RU: /(?<!\p{L})ОГРН\s*:?\s*(\d{13})(?!\d)|(?<!\p{L})ИНН\s*:?\s*(\d{10})(?!\d)/u,
  KZ: /(?<!\p{L})БИН\s*:?\s*(\d{12})(?!\d)/u,
};

// Sole-trader identifiers that are only detectable by number length (RU: 12-digit ИНН / 15-digit ОГРНИП).
const SOLE_TRADER_ID: Partial<Record<MarketCode, RegExp>> = {
  RU: /(?<!\p{L})ОГРНИП\s*:?\s*\d{15}(?!\d)|(?<!\p{L})ИНН\s*:?\s*\d{12}(?!\d)/u,
};

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Marker regex: Latin markers need a capitalised name before them ("Acme Supplies Ltd"); Cyrillic ones precede the name. */
function markerRegex(marker: string): RegExp {
  const m = escape(marker);
  if (/[а-яё]/i.test(marker)) {
    return new RegExp(`(?:^|[^\\p{L}])(${m}\\s*(?:[«"“][^»"”]{1,60}[»"”]|\\p{Lu}[\\p{L}0-9-]*))`, 'u');
  }
  // Name words may be wrapped in parentheses: "Emerson Developments (Holdings) Limited".
  return new RegExp(
    `\\b(\\p{Lu}[\\p{L}0-9&'’.-]*(?:\\s+\\(?[\\p{Lu}&][\\p{L}0-9&'’.-]*\\)?){0,6}\\s+${m})(?=$|[^\\p{L}])`,
    'u',
  );
}

/** Detects the legal form from site text. Footer/legal/contact pages are searched first. */
export function detectEntity(pages: PageContext[], market: MarketConfig): EntityResult {
  const order = ['legal', 'contact', 'about', 'home'];
  const sorted = [...pages].sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  let registryId: string | null = null;
  const idRe = REGISTRY_ID[market.code];
  for (const page of sorted) {
    const m = idRe ? page.text.match(idRe) : null;
    if (m) {
      registryId = (m[1] ?? m[2] ?? null)?.toUpperCase() ?? null;
      break;
    }
  }

  for (const page of sorted) {
    for (const deny of market.entity_markers_deny) {
      // "ИП" alone appears in boilerplate ("юрлица и ИП"); require a surname after it: "ИП Иванов И.И.".
      const re = /[а-яё]/i.test(deny)
        ? new RegExp(`(?:^|[^\\p{L}])${escape(deny)}\\s+\\p{Lu}\\p{Ll}+(?:\\s+\\p{Lu}\\.\\s*(?:\\p{Lu}\\.)?|\\s+\\p{Lu}\\p{Ll}+){0,2}`, 'u')
        : new RegExp(`(?:^|[^\\p{L}])${escape(deny)}(?=$|[^\\p{L}])`, 'iu');
      const m = page.text.match(re);
      if (m) return { entityType: 'sole_trader', evidence: m[0].trim(), evidenceUrl: page.url, registryId };
    }
    const soleId = SOLE_TRADER_ID[market.code];
    const sm = soleId ? page.text.match(soleId) : null;
    if (sm) return { entityType: 'sole_trader', evidence: sm[0], evidenceUrl: page.url, registryId };
  }

  for (const page of sorted) {
    for (const marker of market.entity_markers_allow) {
      const m = page.text.match(markerRegex(marker));
      if (m) {
        return {
          entityType: MARKER_TYPES[marker.toLowerCase()] ?? 'unknown',
          evidence: m[1]!.trim().slice(0, 120),
          evidenceUrl: page.url,
          registryId,
        };
      }
    }
  }
  return { entityType: 'unknown', evidence: null, evidenceUrl: null, registryId };
}
