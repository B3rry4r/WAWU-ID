import {
  erasedKeys,
  erasureLockIds,
  erasureLockKeys,
  lockErasure,
  otherHolders,
  SIGNUP_EMAIL_BUDGET,
} from './erased-identifiers';

/**
 * JOIN-03 round 4, N16: the keys an anonymise removes, from what the person
 * held. Round 5 (D11, N24): only the person's OWN, and every spelling of an OTP
 * row.
 */
describe('erasedKeys', () => {
  it('names every spelling of a Nigerian number, the one as stored too', () => {
    const { keys, budgets } = erasedKeys({
      phones: ['0803 123 4567'],
      emails: [],
    });
    for (const spelling of [
      '0803 123 4567',
      '+2348031234567',
      '2348031234567',
      '08031234567',
    ]) {
      expect(keys).toContain(spelling);
      expect(budgets).toContain(spelling);
    }
  });

  it('keeps a number that is not Nigerian as it was written, with no invented spellings', () => {
    const { keys } = erasedKeys({ phones: ['+14155550100'], emails: [] });
    expect(keys).toEqual(['+14155550100']);
  });

  it('names an address, and its wrong-code budget under the sign-up prefix', () => {
    const { keys, budgets } = erasedKeys({
      phones: [],
      emails: ['ada@example.test'],
    });
    expect(keys).toEqual(['ada@example.test']);
    expect(budgets).toEqual([`${SIGNUP_EMAIL_BUDGET}ada@example.test`]);
    expect(SIGNUP_EMAIL_BUDGET).toBe('signup-email:');
  });

  it('names nothing for a marker, an empty text, a blank one or no value', () => {
    expect(
      erasedKeys({
        phones: ['deleted:u1', 'released:u1', '', '   ', null, undefined],
        emails: [null, undefined, '', '  '],
      }),
    ).toEqual({ keys: [], budgets: [], otpDigits: [] });
  });

  it('lists each key once however many fields name it', () => {
    const { keys } = erasedKeys({
      phones: ['+2348031234567', '+2348031234567', '08031234567'],
      emails: ['a@example.test', 'a@example.test'],
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  // ── N24: an OTP row holds the number as it was written ─────────────────────

  describe('the digits an OTP row of the number would hold (N24)', () => {
    it('names the number written with or without the country code, a leading 00, or the stray 0 after it', () => {
      const { otpDigits } = erasedKeys({
        phones: ['+2348031234567'],
        emails: [],
      });
      expect(new Set(otpDigits)).toEqual(
        new Set([
          '8031234567',
          '08031234567',
          '2348031234567',
          '002348031234567',
          '23408031234567',
          '0023408031234567',
        ]),
      );
    });

    it('is the same from whatever spelling the number was stored in', () => {
      const from = (stored: string) =>
        new Set(erasedKeys({ phones: [stored], emails: [] }).otpDigits);
      expect(from('0803 123 4567')).toEqual(from('+234-803-123-4567'));
      expect(from('002348031234567')).toEqual(from('2348031234567'));
    });

    it('names a number that is not Nigerian by its digits, with or without a leading 00', () => {
      expect(
        new Set(erasedKeys({ phones: ['+14155550100'], emails: [] }).otpDigits),
      ).toEqual(new Set(['14155550100', '0014155550100']));
    });

    it('names no digits for an address, a marker or text that is not a number', () => {
      expect(
        erasedKeys({
          phones: ['deleted:u1', 'not a number'],
          emails: ['ada@example.test'],
        }).otpDigits,
      ).toEqual([]);
    });
  });

  // ── D11: only what is the person's own ─────────────────────────────────────

  describe('leaves a number or address another account holds (D11)', () => {
    const own = { phones: ['+2348031234567'], emails: ['ada@example.test'] };

    it('names a number nobody else holds, whoever else is named in the list', () => {
      const { keys } = erasedKeys(own, {
        phones: ['+2348055550000'],
        emails: ['bob@example.test'],
      });
      expect(keys).toContain('+2348031234567');
      expect(keys).toContain('ada@example.test');
    });

    it.each([
      ['as stored', '+2348031234567'],
      ['written 0803...', '08031234567'],
      ['written 234...', '2348031234567'],
      ['spaced', '0803 123 4567'],
      ['dashed', '+234-803-123-4567'],
    ])(
      'names nothing of a number another account holds, %s',
      (_how, theirs) => {
        const out = erasedKeys(own, { phones: [theirs], emails: [] });
        expect(out.keys).not.toContain('+2348031234567');
        expect(out.keys).not.toContain('08031234567');
        expect(out.budgets).not.toContain('+2348031234567');
        expect(out.otpDigits).toEqual([]);
        // the address is still the person's own
        expect(out.keys).toContain('ada@example.test');
      },
    );

    it.each(['ada@example.test', 'ADA@Example.test', ' ada@example.test '])(
      'names nothing of an address another account holds, written %j',
      (theirs) => {
        const out = erasedKeys(own, { phones: [], emails: [theirs] });
        expect(out.keys).not.toContain('ada@example.test');
        expect(out.budgets).not.toContain(
          `${SIGNUP_EMAIL_BUDGET}ada@example.test`,
        );
        expect(out.keys).toContain('+2348031234567');
      },
    );

    it.each([
      ['0803 123 4567', '+2348031234567'],
      ['08031234567', '234 803 123 4567'],
      ['+234-803-123-4567', '08031234567'],
    ])(
      'compares the number as a number, not as text: stored %j, held by another as %j',
      (stored, theirs) => {
        const out = erasedKeys(
          { phones: [stored], emails: [] },
          { phones: [theirs], emails: [] },
        );
        expect(out).toEqual({ keys: [], budgets: [], otpDigits: [] });
      },
    );

    it('judges each number on its own: the one nobody holds is still named', () => {
      const out = erasedKeys(
        { phones: ['+2348031234567', '+2349011112222'], emails: [] },
        { phones: ['08031234567'], emails: [] },
      );
      expect(out.keys).toContain('+2349011112222');
      expect(out.keys).not.toContain('+2348031234567');
      expect(out.otpDigits).toContain('9011112222');
      expect(out.otpDigits).not.toContain('8031234567');
    });

    it('is not fooled by a marker or a blank in the other accounts', () => {
      const out = erasedKeys(own, {
        phones: ['released:u2', 'deleted:u3', ''],
        emails: [null, '', '  '],
      });
      expect(out.keys).toContain('+2348031234567');
      expect(out.keys).toContain('ada@example.test');
    });
  });
});

/** The other accounts that hold what the person held (D11), read inside the transaction. */
describe('otherHolders', () => {
  type Where = {
    id: { not: string };
    OR: Array<Record<string, unknown>>;
  };
  function tx(rows: Array<{ phone: string; email: string | null }>) {
    const calls: Where[] = [];
    return {
      calls,
      client: {
        wawuUser: {
          findMany: ({ where }: { where: Where }) => {
            calls.push(where);
            return Promise.resolve(rows);
          },
        },
      } as never,
    };
  }

  it('asks for other accounts only, in every spelling a duplicate check uses, and for an address in any case', async () => {
    const t = tx([{ phone: '08031234567', email: null }]);
    const out = await otherHolders(t.client, 'me', {
      phones: ['+2348031234567', null],
      emails: ['Ada@Example.test'],
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].id).toEqual({ not: 'me' });
    expect(t.calls[0].OR).toEqual([
      {
        phone: {
          in: expect.arrayContaining([
            '+2348031234567',
            '2348031234567',
            '08031234567',
          ]) as string[],
        },
      },
      { email: { equals: 'ada@example.test', mode: 'insensitive' } },
    ]);
    expect(out).toEqual({ phones: ['08031234567'], emails: [null] });
  });

  it('asks nothing when the person held no number and no address', async () => {
    const t = tx([]);
    const out = await otherHolders(t.client, 'me', {
      phones: ['deleted:me', 'released:me', null, ''],
      emails: [null, ' '],
    });
    expect(t.calls).toHaveLength(0);
    expect(out).toEqual({ phones: [], emails: [] });
  });
});

/**
 * JOIN-03 round 6, D12: two accounts that hold one number (the G-16 duplicates,
 * in two spellings) are closed under one lock, so the second reads who else
 * holds it after the first has committed.
 */
describe('erasureLockKeys and erasureLockIds', () => {
  it('names a number once, in whatever spelling it is stored', () => {
    const keys = (phone: string) =>
      erasureLockKeys({ phones: [phone], emails: [] });
    const one = keys('+2348031234567');
    expect(one).toHaveLength(1);
    for (const spelling of [
      '08031234567',
      '2348031234567',
      '0803 123 4567',
      '+234-803-123-4567',
      '002348031234567',
    ]) {
      expect(keys(spelling)).toEqual(one);
    }
    expect(keys('+2348031234568')).not.toEqual(one);
  });

  it('names an address once, in any case and with surrounding space', () => {
    const keys = (email: string) =>
      erasureLockKeys({ phones: [], emails: [email] });
    expect(keys(' Ada@Example.test ')).toEqual(keys('ada@example.test'));
    expect(keys('bob@example.test')).not.toEqual(keys('ada@example.test'));
  });

  it('does not lock a number and an address that are the same text as one key', () => {
    const keys = erasureLockKeys({
      phones: ['+2348031234567'],
      emails: ['+2348031234567'],
    });
    expect(keys).toHaveLength(2);
  });

  it('names nothing for a marker, an empty text or nothing', () => {
    expect(
      erasureLockKeys({
        phones: ['deleted:me', 'released:me', null, undefined, ''],
        emails: [null, undefined, ' '],
      }),
    ).toEqual([]);
  });

  it('turns keys into 64-bit ids, smallest first, each once, the same ones every time', () => {
    const keys = ['phone:+2348031234567', 'email:ada@example.test', 'phone:x'];
    const ids = erasureLockIds(keys);
    expect(ids).toEqual(erasureLockIds([...keys].reverse()));
    expect(ids).toEqual(erasureLockIds([...keys, ...keys]));
    expect(ids).toHaveLength(3);
    const big = ids.map((i) => BigInt(i));
    expect(big).toEqual([...big].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const id of big) {
      expect(id >= -(2n ** 63n) && id < 2n ** 63n).toBe(true);
    }
  });
});

describe('lockErasure', () => {
  it('takes one transaction-scoped advisory lock per number or address, in id order, and none when there is nothing to lock', async () => {
    const taken: string[] = [];
    const sql: string[] = [];
    const tx = {
      $executeRaw: (strings: TemplateStringsArray, id: string) => {
        sql.push(strings.join('?'));
        taken.push(id);
        return Promise.resolve(0);
      },
    };
    const own = {
      phones: ['0803 123 4567', '+2348031234567'],
      emails: ['Ada@Example.test'],
    };
    await lockErasure(tx as never, own);
    expect(taken).toEqual(erasureLockIds(erasureLockKeys(own)));
    expect(taken).toHaveLength(2);
    for (const text of sql) {
      expect(text).toBe('SELECT pg_advisory_xact_lock(?::bigint)');
    }

    taken.length = 0;
    await lockErasure(tx as never, { phones: ['deleted:me'], emails: [null] });
    expect(taken).toEqual([]);
  });
});
