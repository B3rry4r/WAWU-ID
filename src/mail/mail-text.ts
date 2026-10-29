/**
 * The plain-text part of a mail (EMAIL-01), made from the same html the layout
 * builds, so the two cannot drift apart. It only has to read the layout's own
 * markup well: paragraphs and the headline become lines, a button becomes
 * "Label: address", a facts row (`<tr data-fact="1">`) becomes "Label: value",
 * and the hidden inbox preview and the header picture are left out.
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&copy;': '©',
};

function decode(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos|nbsp|copy|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)));
}

export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    // Source whitespace is not layout.
    .replace(/\s+/g, ' ')
    // Left out: the inbox preview, the header picture, scripts and styles.
    .replace(/<span style="display:none[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    // A facts row: "Label: value".
    .replace(
      /<tr data-fact="1">\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<\/tr>/gi,
      (_m, label: string, value: string) =>
        `${label.trim()}: ${value.trim()}\n`,
    )
    // A button or link: "Label: address".
    .replace(
      /<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => `${label.trim()}: ${href}`,
    )
    .replace(/<li(?=[\s>])[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(p|h1|h2|h3|ul|ol|table)>|<(p|h1|h2|h3|table|ul|ol)(?=[\s>])[^>]*>/gi,
      '\n\n',
    )
    .replace(/<\/(li|tr|td|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(text)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
