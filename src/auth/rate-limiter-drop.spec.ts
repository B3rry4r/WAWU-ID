import { DbRateLimiter } from './rate-limiter.service';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';

/**
 * JOIN-03 round 6, N30: a resend that finds its sign-up gone gives its reserved
 * uses back and then removes the counter rows it wrote, so nothing stays keyed
 * on a closed account's number or address. `release` alone leaves a row at
 * zero; `dropIfEmpty` takes it away, and only when nothing is counted in it
 * (another sign-up's uses on the same number must stay).
 */
describe('RateLimiter.dropIfEmpty', () => {
  describe('on the database', () => {
    it('deletes the one row, only while its count is zero or less', async () => {
      const calls: unknown[] = [];
      const limiter = new DbRateLimiter({
        rateCounter: {
          deleteMany: (arg: unknown) => {
            calls.push(arg);
            return Promise.resolve({ count: 0 });
          },
        },
      } as never);
      await limiter.dropIfEmpty('sms-phone-day', '+2348031234567');
      expect(calls).toEqual([
        {
          where: {
            scope: 'sms-phone-day',
            key: '+2348031234567',
            count: { lte: 0 },
          },
        },
      ]);
    });
  });

  describe('in memory (the double the specs use)', () => {
    it('removes a row whose uses were all given back, and keeps one that still counts something', async () => {
      const limits = new MemoryRateLimiter();
      await limits.hit('a', 'k', 5, 60);
      await limits.release('a', 'k');
      expect(limits.hasCounter('a', 'k')).toBe(true);
      await limits.dropIfEmpty('a', 'k');
      expect(limits.hasCounter('a', 'k')).toBe(false);

      await limits.hit('a', 'k', 5, 60);
      await limits.hit('a', 'k', 5, 60);
      await limits.release('a', 'k');
      await limits.dropIfEmpty('a', 'k');
      expect(limits.hasCounter('a', 'k')).toBe(true);
    });

    it('does nothing for a row that is not there', async () => {
      const limits = new MemoryRateLimiter();
      await expect(limits.dropIfEmpty('a', 'none')).resolves.toBeUndefined();
    });
  });
});
