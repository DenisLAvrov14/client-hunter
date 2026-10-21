import { readFileSync } from 'node:fs';
import { normalizeWebsite, type CandidateCompany } from './types.js';

const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

/**
 * Parses an operator CSV. Accepted columns (header row, case-insensitive): website|domain|url (required),
 * name, city. A headerless file with one domain per line also works.
 */
export function parseCandidatesCsv(content: string): CandidateCompany[] {
  const lines = content
    .replace(BOM, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const split = (line: string) => line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]!).map((h) => h.toLowerCase());
  const siteCol = header.findIndex((h) => ['website', 'domain', 'url', 'site'].includes(h));
  const hasHeader = siteCol !== -1;
  const nameCol = header.indexOf('name');
  const cityCol = header.indexOf('city');

  const out: CandidateCompany[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cols = split(line);
    const raw = cols[hasHeader ? siteCol : 0];
    const websiteUrl = raw ? normalizeWebsite(raw) : null;
    if (!websiteUrl) continue;
    out.push({
      name: hasHeader && nameCol !== -1 ? cols[nameCol] || null : null,
      websiteUrl,
      city: hasHeader && cityCol !== -1 ? cols[cityCol] || null : null,
      sourceRef: null,
      query: null,
    });
  }
  return out;
}

export function readCandidatesCsv(file: string): CandidateCompany[] {
  return parseCandidatesCsv(readFileSync(file, 'utf8'));
}
