/**
 * How the notice mails write money and time (EMAIL-01). The Hub sends minor
 * units with a currency code and ISO times; this service decides how they read.
 */

/** A currency with a symbol of its own is written with it; any other with its code. */
const SYMBOLS: Record<string, string> = {
  NGN: '₦',
  USD: '$',
  GBP: '£',
  EUR: '€',
};

/** 500000, 'NGN' -> ₦5,000.00. 1250, 'USD' -> $12.50. 1000, 'GHS' -> GHS 10.00. */
export function formatMoney(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = SYMBOLS[currency];
  return symbol
    ? `${symbol}${grouped}.${cents}`
    : `${currency} ${grouped}.${cents}`;
}

const LAGOS = 'Africa/Lagos';

function partsOf(
  at: Date,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: LAGOS,
    ...options,
  }).formatToParts(at)) {
    out[p.type] = p.value;
  }
  return out;
}

/** Mon 14 Dec 2026, in Lagos time. */
export function formatLagosDate(iso: string | Date): string {
  const p = partsOf(new Date(iso), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** Sat 14 Nov 2026, 7:00 PM (Lagos time). */
export function formatLagosDateTime(iso: string | Date): string {
  const at = new Date(iso);
  const t = partsOf(at, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatLagosDate(at)}, ${t.hour}:${t.minute} ${String(t.dayPeriod).toUpperCase()} (Lagos time)`;
}

/** A tail of the last four characters for a long reference: "ending 3645". */
export function endingIn(reference: string): string {
  const tail = reference.trim();
  return tail.length > 4 ? `ending ${tail.slice(-4)}` : tail;
}
