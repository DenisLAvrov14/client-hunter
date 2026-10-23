import type { ProcessResult } from '../pipeline/processCompany.js';

/** One console line per inspected company (operator-facing, Russian). */
export function describeResult(r: ProcessResult): string {
  if (r.status === 'inspected') {
    const findings = r.verified.length ? `находки: ${r.verified.join(', ')}` : 'без проверенных находок';
    return `✔ ${findings} · ${r.contact ?? 'нет email'} · риск контакта: ${r.risk ?? '—'}`;
  }
  if (r.status === 'rejected_auto') return `✖ ${r.reason}`;
  return `⚠ ошибка: ${r.reason}`;
}
