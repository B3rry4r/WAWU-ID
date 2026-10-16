import { NotFoundException } from '@nestjs/common';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { deleteAccountsMatching } from './account-removal';
import { AuthService } from './auth.service';

/**
 * JOIN-03 round 6, N31: every path that removes an account takes the sign-up
 * code row BEFORE the account, the order the confirm routes, a newer sign-up
 * and the Hub's anonymise take (round 5, D8). A plain DELETE of the account
 * locks it first and reaches the code row in the cascade, which deadlocks with
 * a confirm that has deleted the code row and is waiting for the account. The
 * real locks are proved by `npm run test:erase-local` against Postgres; these
 * specs check the order of the statements each path sends.
 */
describe('removing an account takes the sign-up code row first (N31)', () => {
  type Call = [string, unknown];
  let calls: Call[];
  /** The accounts the first look-up finds (the real one applies the `where`). */
  let found: Array<{ id: string }>;
  /** How many code rows each delete finds (an account that was confirmed has none). */
  let codeRows: Record<string, number>;
  /** The accounts that are still there when the delete is made. */
  let still: Set<string>;

  const tx = () => ({
    wawuUser: {
      findMany: (arg: unknown) => {
        calls.push(['account.find', arg]);
        return Promise.resolve(found);
      },
      deleteMany: (arg: {
        where: { id?: string; AND?: Array<{ id: string }> };
      }) => {
        calls.push(['account.delete', arg]);
        const id = arg.where.id ?? arg.where.AND?.[0]?.id ?? '';
        return Promise.resolve({ count: still.has(id) ? 1 : 0 });
      },
    },
    phoneVerification: {
      deleteMany: (arg: { where: { userId: string } }) => {
        calls.push(['code.delete', arg]);
        return Promise.resolve({ count: codeRows[arg.where.userId] ?? 0 });
      },
    },
  });
  const prisma = {
    $transaction: (run: (t: ReturnType<typeof tx>) => Promise<unknown>) =>
      run(tx()),
  };
  const names = () => calls.map(([name]) => name);

  beforeEach(() => {
    calls = [];
    found = [{ id: 'a' }, { id: 'b' }];
    codeRows = { a: 1, b: 0 };
    still = new Set(['a', 'b']);
  });

  describe('deleteAccountsMatching', () => {
    it('looks the accounts up in id order, then deletes each one code row first and account after', async () => {
      const where = { email: 'ada@example.test' };
      const count = await deleteAccountsMatching(tx() as never, where);
      expect(count).toBe(2);
      expect(names()).toEqual([
        'account.find',
        'code.delete',
        'account.delete',
        'code.delete',
        'account.delete',
      ]);
      expect(calls[0][1]).toMatchObject({ where, orderBy: { id: 'asc' } });
      expect(calls[1][1]).toEqual({ where: { userId: 'a' } });
      expect(calls[3][1]).toEqual({ where: { userId: 'b' } });
    });

    it('applies the original condition again to each account when it deletes it', async () => {
      const where = { phone: '+2348031234567' };
      await deleteAccountsMatching(tx() as never, where);
      expect(calls[2][1]).toEqual({ where: { AND: [{ id: 'a' }, where] } });
    });

    it('counts only the accounts that went (one that changed meanwhile stays)', async () => {
      still = new Set(['a']);
      expect(await deleteAccountsMatching(tx() as never, { id: 'a' })).toBe(1);
    });

    it('deletes nothing and asks for nothing more when no account matches', async () => {
      found = [];
      expect(await deleteAccountsMatching(tx() as never, { id: 'x' })).toBe(0);
      expect(names()).toEqual(['account.find']);
    });
  });

  describe('the hard delete', () => {
    const auth = () =>
      new AuthService(
        {
          ...prisma,
          wawuUser: {
            findUnique: () => Promise.resolve({ id: 'a' }),
          },
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

    it('takes the code row before the account', async () => {
      found = [{ id: 'a' }];
      const out = await auth().deleteUser('a', 'hard');
      expect(out).toEqual({ id: 'a', status: 'deleted', deleted: true });
      expect(names()).toEqual([
        'account.find',
        'code.delete',
        'account.delete',
      ]);
    });

    it('answers 404, not a server error, when the account went between the lookup and the delete', async () => {
      found = [];
      await expect(auth().deleteUser('a', 'hard')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('the SAF delete', () => {
    const provisioning = () =>
      new ProvisioningService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

    it('takes the code row before the account, for each account it finds, and reports how many went', async () => {
      const out = await provisioning().deleteSafUser({
        email: ' Ada@Example.test ',
        phone: '08031234567',
      });
      expect(out).toEqual({ deleted: 2 });
      expect(names()).toEqual([
        'account.find',
        'code.delete',
        'account.delete',
        'code.delete',
        'account.delete',
      ]);
      expect(calls[0][1]).toMatchObject({
        where: {
          OR: [{ email: 'ada@example.test' }, { phone: '08031234567' }],
        },
      });
    });

    it('touches nothing when neither an email nor a phone is given', async () => {
      expect(await provisioning().deleteSafUser({})).toEqual({ deleted: 0 });
      expect(calls).toEqual([]);
    });
  });

  describe('the expired sign-up sweep in register', () => {
    const sweep = (email = 'ada@example.test', phone = '+2348031234567') =>
      (
        new AuthService(
          prisma as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        ) as unknown as {
          releaseExpiredSignups: (e: string, p: string) => Promise<void>;
        }
      ).releaseExpiredSignups(email, phone);

    it('takes the code row first and removes the account only when it found the code row', async () => {
      codeRows = { a: 1, b: 0 }; // b was confirmed (or anonymised) since it was looked up: no code row
      await sweep();
      expect(names()).toEqual([
        'account.find',
        'code.delete',
        'account.delete',
        'code.delete',
      ]);
      expect(calls[2][1]).toEqual({ where: { id: 'a' } });
    });

    it('only deletes a code row whose 24 hours have ended, and only for an account that has not proved its phone', async () => {
      await sweep();
      expect(calls[0][1]).toMatchObject({
        where: {
          phoneVerifiedAt: null,
          phoneVerification: {
            is: { signupExpiresAt: { lt: expect.any(Date) as Date } },
          },
        },
        orderBy: { id: 'asc' },
      });
      expect(calls[1][1]).toEqual({
        where: {
          userId: 'a',
          signupExpiresAt: { lt: expect.any(Date) as Date },
        },
      });
    });

    it('is the same transaction for every account it removes', async () => {
      let transactions = 0;
      const counting = {
        $transaction: (run: (t: ReturnType<typeof tx>) => Promise<unknown>) => {
          transactions += 1;
          return run(tx());
        },
      };
      await (
        new AuthService(
          counting as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        ) as unknown as {
          releaseExpiredSignups: (e: string, p: string) => Promise<void>;
        }
      ).releaseExpiredSignups('ada@example.test', '+2348031234567');
      expect(transactions).toBe(1);
    });
  });
});
