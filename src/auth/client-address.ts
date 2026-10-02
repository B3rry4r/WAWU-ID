import type { Request } from 'express';

/**
 * The address a request really came from.
 *
 * wawu-id is reached through nginx only (ports 3001 and 3002 are closed by
 * ufw, wawu-backend deploy/README.md), and nginx overwrites `X-Real-IP` with
 * the address it saw on the socket (`proxy_set_header X-Real-IP $remote_addr`,
 * deploy/install-services.sh), so a client cannot choose it. That header is
 * used first. Without it the LAST `X-Forwarded-For` entry is used, which is the
 * one nginx appended (`$proxy_add_x_forwarded_for`); the first entry is
 * whatever the client wrote, so it is never trusted here (the consent route in
 * src/policies reads that first entry, which is why it is not reused). With
 * neither, the socket address.
 */
export function clientAddress(req: Request): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();

  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain?.length) return chain[chain.length - 1];

  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
