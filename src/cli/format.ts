import type { ProcessResult } from '../pipeline/processCompany.js';

/** One console line per inspected company (operator-facing, Russian). */
export function describeResult(r: ProcessResult): string {
  if (r.status === 'inspected') {
    const findings = r.verified.length ? `находки: ${r.verified.join(', ')}` : 'без проверенных находок';
    const browser = r.browserIssues.length ? ` · ⚠ браузер: ${r.browserIssues[0]}` : '';
    const contact = r.contact ? `${r.contact} (риск адреса: ${r.contactRisk})` : 'нет email';
    return `✔ ${findings} · контакт: ${r.contactStatus ?? '—'} · ${contact} · риск обращения: ${r.risk ?? '—'}${browser}`;
  }
  if (r.status === 'rejected_auto') return `✖ ${r.reason}`;
  return `⚠ ошибка: ${r.reason}`;
}
