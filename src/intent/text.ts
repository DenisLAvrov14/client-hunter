// Plain text from the small HTML subset HN uses in comments (<p>, <a>, <i>, <pre><code>).
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Paragraphs become lines; links keep their visible text (HN shows the URL as the text). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Whole-word / phrase match for lower-case terms, Unicode-aware. */
export function hasTerm(textLower: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(textLower);
}

/** The line of `text` containing the first match of `re`, verbatim (cut at `max` characters, never edited). */
export function quoteAround(text: string, re: RegExp, max = 220): string {
  const m = re.exec(text);
  const line = m ? text.slice(0, m.index).split('\n').length - 1 : 0;
  return (text.split('\n')[line] ?? text).slice(0, max);
}
