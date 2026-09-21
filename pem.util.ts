/**
 * Normalises a PEM key read from an environment variable.
 *
 * Railway lets you paste a multi-line PEM directly (real newlines), while a
 * local `.env` typically stores it on one line with `\n` escapes. This accepts
 * either form and returns a PEM with real newlines, which Node's crypto and
 * jsonwebtoken expect.
 */
export function normalizePem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}
