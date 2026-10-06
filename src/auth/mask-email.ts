/**
 * An address written so the person can recognise it and a bystander cannot
 * use it: the first letter, three dots, then the domain (`ada@example.com`
 * becomes `a•••@example.com`). Shown on A4 ("Sent to a•••@example.com").
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  const first = Array.from(email.slice(0, at))[0];
  return `${first}•••${email.slice(at)}`;
}
