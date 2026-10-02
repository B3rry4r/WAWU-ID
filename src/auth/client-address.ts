import type { Request } from 'express';
import { isIPv6 } from 'net';

/**
 * Write an IPv6 address as its /64 prefix (its first four groups), because a
 * single customer line is usually given a whole /64 and every address in it
 * is theirs: counting each address separately would let one machine step
 * round every per-address limit. An IPv4-mapped address (::ffff:1.2.3.4) is
 * the IPv4 address. Anything else comes back as it was.
 */
export function addressKey(address: string): string {
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  if (!isIPv6(address)) return address;

  const [head, tail] = address.split('::');
  const first = head ? head.split(':') : [];
  const last = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? first
      : [
          ...first,
          ...Array<string>(8 - first.length - last.length).fill('0'),
          ...last,
        ];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

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
 *
 * This holds only while nginx is the first hop. Behind a CDN or load balancer
 * `$remote_addr` is the proxy, so every caller would share one address; the
 * proxy would have to be trusted and its own header read instead
 * (deploy/ENV.md, "Client address").
 */
export function clientAddress(req: Request): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return addressKey(real.trim());

  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain?.length) return addressKey(chain[chain.length - 1]);

  return addressKey(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}
