import type { Request } from 'express';
import { addressKey, clientAddress } from './client-address';

const req = (headers: Record<string, string>, ip?: string) =>
  ({ headers, ip, socket: {} }) as unknown as Request;

describe('addressKey', () => {
  it('leaves an IPv4 address alone and unwraps an IPv4-mapped one', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts every address in one IPv6 /64 as one client', () => {
    const a = addressKey('2001:db8:abcd:12:1:2:3:4');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(addressKey('2001:0db8:ABCD:0012:ffff:ffff:ffff:ffff')).toBe(a);
    expect(addressKey('2001:db8:abcd:12::9')).toBe(a);
    expect(addressKey('2001:db8:abcd:13::9')).not.toBe(a);
  });

  it('expands :: correctly', () => {
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });
});

describe('clientAddress', () => {
  it('takes X-Real-IP, which nginx sets from the socket, before anything a client can write', () => {
    expect(
      clientAddress(
        req({
          'x-real-ip': '198.51.100.9',
          'x-forwarded-for': '1.1.1.1, 2.2.2.2',
        }),
      ),
    ).toBe('198.51.100.9');
  });

  it('otherwise takes the LAST X-Forwarded-For entry, never the first', () => {
    expect(
      clientAddress(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.9' })),
    ).toBe('198.51.100.9');
  });

  it('otherwise the socket address', () => {
    expect(clientAddress(req({}, '192.0.2.4'))).toBe('192.0.2.4');
  });
});
