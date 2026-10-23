// Stratified sample for the screening experiment (plan §12): every group is represented,
// instead of whatever a random draw over a B2B-heavy database would give.
import type { Db } from '../db/connection.js';

export type SampleGroup = 'local_services' | 'sole_trader' | 'tech_defect' | 'no_defect_unknown_entity' | 'no_defect_company';

export const SAMPLE_GROUP_LABELS: Record<SampleGroup, string> = {
  local_services: 'локальные услуги / независимые (S3)',
  sole_trader: 'ИП / sole trader по сайту',
  tech_defect: 'есть проверенная техническая находка',
  no_defect_unknown_entity: 'без находок, юрлицо неизвестно',
  no_defect_company: 'без находок, компания',
};

const ORDER: SampleGroup[] = ['local_services', 'sole_trader', 'tech_defect', 'no_defect_unknown_entity', 'no_defect_company'];

export interface SampledCompany {
  id: string;
  domain: string;
  market: string;
  group: SampleGroup;
}

/** Group of one inspected company; the first matching group in ORDER wins. */
const GROUP_SQL = `
  CASE
    WHEN c.segment = 'S3' THEN 'local_services'
    WHEN c.entity_type = 'sole_trader' THEN 'sole_trader'
    WHEN EXISTS (SELECT 1 FROM observations o WHERE o.inspection_id = c.last_inspection_id AND o.status = 'verified') THEN 'tech_defect'
    WHEN c.entity_type IS NULL OR c.entity_type = 'unknown' THEN 'no_defect_unknown_entity'
    ELSE 'no_defect_company'
  END`;

/**
 * Up to `n` inspected, not-yet-screened companies, taken round-robin across groups (random
 * within a group, markets alternating), so small groups are fully represented.
 */
export function stratifiedSample(db: Db, n: number, markets: string[]): SampledCompany[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.domain, c.market, ${GROUP_SQL} AS grp FROM companies c
       WHERE c.status = 'inspected' AND c.last_inspection_id IS NOT NULL
         AND c.market IN (${markets.map(() => '?').join(', ')})
         AND NOT EXISTS (SELECT 1 FROM assessments a WHERE a.company_id = c.id AND a.stage = 'screen')
       ORDER BY random()`,
    )
    .all(...markets) as { id: string; domain: string; market: string; grp: SampleGroup }[];

  // Within each group, alternate markets so one country does not dominate.
  const queues = new Map<SampleGroup, SampledCompany[]>();
  for (const g of ORDER) {
    const byMarket = new Map<string, SampledCompany[]>();
    for (const r of rows.filter((x) => x.grp === g)) {
      byMarket.set(r.market, [...(byMarket.get(r.market) ?? []), { id: r.id, domain: r.domain, market: r.market, group: g }]);
    }
    const interleaved: SampledCompany[] = [];
    for (let i = 0; [...byMarket.values()].some((q) => q.length > i); i++) {
      for (const q of byMarket.values()) if (q[i]) interleaved.push(q[i]!);
    }
    queues.set(g, interleaved);
  }

  const out: SampledCompany[] = [];
  while (out.length < n && [...queues.values()].some((q) => q.length > 0)) {
    for (const g of ORDER) {
      const next = queues.get(g)!.shift();
      if (next && out.length < n) out.push(next);
    }
  }
  return out;
}

/** Companies screened before (any prompt/input), with their group — to re-run an experiment on the same set. */
export function previouslyScreened(db: Db, markets: string[]): SampledCompany[] {
  return (
    db
      .prepare(
        `SELECT c.id, c.domain, c.market, ${GROUP_SQL} AS grp FROM companies c
         WHERE c.market IN (${markets.map(() => '?').join(', ')})
           AND EXISTS (SELECT 1 FROM assessments a WHERE a.company_id = c.id AND a.stage = 'screen')
         ORDER BY c.market, c.domain`,
      )
      .all(...markets) as { id: string; domain: string; market: string; grp: SampleGroup }[]
  ).map((r) => ({ id: r.id, domain: r.domain, market: r.market, group: r.grp }));
}
