import { parse } from 'tldts';

/**
 * Normalizes a URL, host or email domain to its registrable domain (eTLD+1),
 * the dedup and suppression key (spec 7.4, 12.5). Returns null for IPs and
 * anything without a public suffix.
 */
export function registrableDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at !== -1 && !value.includes('/')) value = value.slice(at + 1);
  const result = parse(value);
  if (result.isIp || !result.domain || !result.isIcann) return null;
  return result.domain;
}

/** True if `email` belongs to `domain` or one of its subdomains. */
export function emailOnDomain(email: string, domain: string): boolean {
  return registrableDomain(email) === registrableDomain(domain);
}
