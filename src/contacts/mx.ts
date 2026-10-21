import { resolveMx } from 'node:dns/promises';

export type MxChecker = (domain: string) => Promise<boolean>;

/** DNS MX lookup only — never SMTP RCPT probing (spec 8.5). */
export const dnsMxChecker: MxChecker = async (domain) => {
  try {
    const records = await resolveMx(domain);
    return records.some((r) => r.exchange && r.exchange !== '.');
  } catch {
    return false;
  }
};
