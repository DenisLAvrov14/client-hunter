// How the business can be reached, independent of whether cold outreach would be lawful
// (that is outreach risk, src/outreach/risk.ts). Nothing is sent or submitted anywhere.

export type ContactStatus = 'email' | 'form_only' | 'phone_or_messenger' | 'none';

export interface ContactChannels {
  /** Public addresses on the site whose domain has an MX record (company domain or public mailbox). */
  usableEmails: number;
  inquiryForm: boolean;
  phone: boolean;
  messenger: boolean;
}

/** The best channel available: email, otherwise a form, otherwise phone/messenger. */
export function contactStatusOf(c: ContactChannels): ContactStatus {
  if (c.usableEmails > 0) return 'email';
  if (c.inquiryForm) return 'form_only';
  if (c.phone || c.messenger) return 'phone_or_messenger';
  return 'none';
}
