/**
 * The few Prisma calls the sign-up services make, over plain arrays, for the
 * specs that run without a database (the real SQL is exercised by
 * test/phone-signup.local.mjs and test/signup-sequence.local.mjs). Only ever
 * handed to a test module.
 */

export type Row = Record<string, unknown>;

export interface CodeRow extends Row {
  id: string;
  userId: string;
  phone: string;
  codeHash: string;
  attemptHash: string;
  channel?: string | null;
  claimEmail: string | null;
  emailCodeHash: string | null;
  expiresAt: Date;
  lastSentAt: Date;
  signupExpiresAt: Date;
}

export interface UserRow extends Row {
  id: string;
  email: string | null;
  phone: string;
  emailVerified: boolean;
  phoneVerifiedAt: Date | null;
  passwordHash: string | null;
  occupation: string | null;
  accountType: string | null;
  phoneVerification: CodeRow | null;
}

type Where = Record<string, unknown>;

/** A Prisma `where` over plain rows: equality, `in`, `not` and `OR`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Where[]).some((w) => matches(row, w));
    const have = row[key];
    if (want && typeof want === 'object' && 'in' in want) {
      return (want.in as unknown[]).includes(have);
    }
    if (want && typeof want === 'object' && 'not' in want) {
      return have !== want.not;
    }
    return have === want;
  });
}

/** The few Prisma calls the service makes, over one array of users. */
export function fakePrisma() {
  const users: UserRow[] = [];
  let seq = 0;
  const codes = () =>
    users.flatMap((u) => (u.phoneVerification ? [u.phoneVerification] : []));

  /** The user ids that have a `signup_progress` row (made when a mailed sign-up is confirmed). */
  const progress: string[] = [];

  const api = {
    users,
    codes,
    progress,
    signupProgress: {
      create: ({ data }: { data: { userId: string } }) => {
        if (progress.includes(data.userId)) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        progress.push(data.userId);
        return Promise.resolve(data);
      },
    },
    wawuUser: {
      findMany: ({ where }: { where: Where }) =>
        Promise.resolve(users.filter((u) => matches(u, where))),
      create: ({ data }: { data: Row }) => {
        const { phoneVerification, ...rest } = data as {
          phoneVerification?: { create: Partial<CodeRow> };
        } & Row;
        const taken = users.some(
          (u) =>
            (rest.email && u.email === rest.email) || u.phone === rest.phone,
        );
        if (taken) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        const id = `u${++seq}`;
        const row = {
          id,
          emailVerified: false,
          phoneVerifiedAt: null,
          ...rest,
          phoneVerification: phoneVerification
            ? ({
                id: `c${++seq}`,
                userId: id,
                ...phoneVerification.create,
              } as CodeRow)
            : null,
        } as UserRow;
        users.push(row);
        return Promise.resolve(row);
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
      }) => {
        const row = users.find((u) => u.id === where.id) as UserRow;
        if (
          data.email &&
          users.some((u) => u.id !== row.id && u.email === data.email)
        ) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      updateMany: ({
        where,
        data,
      }: {
        where: Where;
        data: Partial<UserRow>;
      }) => {
        const hit = users.filter(
          (u) =>
            matches(u, where) &&
            u.id !== (where.id as { not: string } | undefined)?.not,
        );
        hit.forEach((u) => Object.assign(u, data));
        return Promise.resolve({ count: hit.length });
      },
      deleteMany: ({ where }: { where: { id: string } }) => {
        const at = users.findIndex((u) => u.id === where.id);
        if (at >= 0) users.splice(at, 1);
        return Promise.resolve({ count: at >= 0 ? 1 : 0 });
      },
    },
    phoneVerification: {
      findUnique: ({ where }: { where: { attemptHash: string } }) => {
        const owner = users.find(
          (u) => u.phoneVerification?.attemptHash === where.attemptHash,
        );
        return Promise.resolve(
          owner?.phoneVerification
            ? { ...owner.phoneVerification, user: owner }
            : null,
        );
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<CodeRow>;
      }) => {
        const row = codes().find((c) => c.id === where.id) as CodeRow;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      deleteMany: ({ where }: { where: { id: string } }) => {
        const owner = users.find((u) => u.phoneVerification?.id === where.id);
        if (!owner) return Promise.resolve({ count: 0 });
        owner.phoneVerification = null;
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };
  return api;
}
