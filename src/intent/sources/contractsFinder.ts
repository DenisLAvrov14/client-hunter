// UK Contracts Finder: public procurement notices via the documented OCDS search API (Open
// Government Licence; robots.txt checked by the caller). Tenders are formal requests for
// proposals. Status comes from the notice itself (tender status + deadline), never from the page
// being online. A notice republished several times is kept once, at its latest release.
import type { Fetcher } from '../../inspect/fetcher.js';
import type { RawRequest } from '../types.js';

export const CF_API = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const MAX_PAGES = 40;

interface OcdsRelease {
  id: string;
  date: string;
  buyer?: { name?: string };
  parties?: { name?: string; roles?: string[]; contactPoint?: { name?: string; email?: string } }[];
  tender: {
    id: string;
    title?: string;
    description?: string;
    status?: string;
    value?: { amount?: number; currency?: string };
    tenderPeriod?: { endDate?: string };
    classification?: { id?: string; description?: string };
    additionalClassifications?: { id?: string }[];
    documents?: { documentType?: string; url?: string }[];
  };
}

export function noticeUrl(r: OcdsRelease): string {
  const doc = r.tender.documents?.find((d) => d.documentType === 'tenderNotice' && d.url);
  // The notice id is the release id without its trailing "-<version>".
  return doc?.url ?? `https://www.contractsfinder.service.gov.uk/Notice/${r.id.replace(/-\d+$/, '')}`;
}

/** Raw request from one OCDS release, or null when it is not in one of the CPV groups. */
export function releaseToRequest(r: OcdsRelease, cpvPrefixes: string[], now = new Date()): RawRequest | null {
  const t = r.tender;
  const cpvs = [t.classification?.id, ...(t.additionalClassifications ?? []).map((a) => a.id)].filter((c): c is string => !!c);
  if (!cpvs.some((c) => cpvPrefixes.some((p) => c.startsWith(p)))) return null;
  const deadline = t.tenderPeriod?.endDate ?? null;
  const description = (t.description ?? '').replace(/\r/g, '').trim();
  let open: boolean | null = null;
  let basis = 'статус в уведомлении не указан';
  if (/^\s*awarded\b/i.test(description) || t.status === 'complete' || t.status === 'cancelled' || t.status === 'unsuccessful') {
    open = false;
    basis = `уведомление: ${t.status === 'active' ? 'контракт присуждён (Awarded)' : `статус ${t.status}`}`;
  } else if (t.status === 'active' && deadline) {
    open = new Date(deadline) > now;
    basis = open ? `уведомление активно, приём заявок до ${deadline.slice(0, 10)}` : `срок подачи истёк ${deadline.slice(0, 10)}`;
  }
  const buyer = r.parties?.find((p) => p.roles?.includes('buyer'));
  const v = t.value;
  return {
    source: 'uk_contracts_finder',
    itemId: t.id,
    url: noticeUrl(r),
    publishedAt: new Date(r.date).toISOString(),
    author: buyer?.contactPoint?.name ?? null,
    organisation: r.buyer?.name ?? buyer?.name ?? null,
    title: t.title ?? null,
    text: [t.title ?? '', description].filter(Boolean).join('\n'),
    header: t.title ?? '',
    sourceStatus: { open, basis },
    deadline,
    budget: v?.amount ? `${v.amount} ${v.currency ?? ''}`.trim() : null,
    contact: buyer?.contactPoint?.email ?? null,
    cpv: `${t.classification?.id ?? ''} ${t.classification?.description ?? ''}`.trim(),
  };
}

/** Tender notices published in the last `days` days (cursor-paginated, polite: one page at a time). */
export async function fetchContractsFinder(fetcher: Fetcher, days: number, cpvPrefixes: string[], now = new Date()): Promise<{ requests: RawRequest[]; scanned: number }> {
  const from = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 19);
  let url: string | null = `${CF_API}?publishedFrom=${from}&stages=tender&limit=100`;
  const latest = new Map<string, RawRequest>();
  let scanned = 0;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetcher.fetch(url);
    if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
    if (res.truncated) throw new Error(`${url}: response larger than the size limit`);
    const body = JSON.parse(res.body) as { releases?: OcdsRelease[]; links?: { next?: string } };
    for (const r of body.releases ?? []) {
      scanned++;
      const req = releaseToRequest(r, cpvPrefixes, now);
      if (!req) continue;
      const prev = latest.get(req.itemId);
      if (!prev || (req.publishedAt ?? '') > (prev.publishedAt ?? '')) latest.set(req.itemId, req);
    }
    url = body.links?.next ?? null;
  }
  return { requests: [...latest.values()], scanned };
}
