import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';
import { phoneIsProven } from './phone-proof';

/**
 * JOIN-03 round 3, D3: `DELETE /internal/users/:id?mode=anonymize` is the call
 * the Hub makes to finalise an account deletion. The number the account proved
 * (`wawu_users.phone_verified_for`) is its real phone number, so it goes with
 * the phone: the row is read back after the request, through the route.
 */
describe('DELETE /internal/users/:id?mode=anonymize clears the number the account proved', () => {
  const KEY = 'spec-service-key';
  const ID = '00000000-0000-4000-8000-0000000000d3';
  const REAL = '+2348031234567';

  type Row = {
    id: string;
    email: string | null;
    phone: string;
    phoneVerifiedAt: Date | null;
    phoneVerifiedFor: string | null;
    firstName: string | null;
    status: string;
    deletedAt: Date | null;
    passwordHash: string | null;
  };

  let app: INestApplication;
  let row: Row;
  const gone: string[] = [];

  beforeEach(async () => {
    row = {
      id: ID,
      email: 'ada@example.test',
      phone: REAL,
      phoneVerifiedAt: new Date('2026-10-01T10:00:00Z'),
      phoneVerifiedFor: REAL,
      firstName: 'Ada',
      status: 'active',
      deletedAt: null,
      passwordHash: 'hash',
    };
    gone.length = 0;
    const tx = {
      wawuUser: {
        update: ({ data }: { data: Partial<Row> }) => {
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      },
      refreshToken: {
        deleteMany: () => (gone.push('refresh'), Promise.resolve({ count: 1 })),
      },
      passwordResetToken: {
        deleteMany: () => (gone.push('reset'), Promise.resolve({ count: 0 })),
      },
    };
    const prisma = {
      wawuUser: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === row.id ? row : null),
        delete: () => {
          row = undefined as never;
          return Promise.resolve({});
        },
      },
      $transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
    };
    const auth = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        { provide: AuthService, useValue: auth },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'INTERNAL_SERVICE_KEY' ? KEY : undefined,
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const anonymise = () =>
    request(app.getHttpServer() as App)
      .delete(`/internal/users/${ID}?mode=anonymize`)
      .set('x-service-key', KEY);

  it('reads back null in phone_verified_for, with the phone a deleted marker', async () => {
    expect(row.phoneVerifiedFor).toBe(REAL);
    const res = await anonymise().expect(200);
    expect(res.body).toEqual({
      data: { id: ID, status: 'banned', deleted: false },
    });
    expect(row.phone).toBe(`deleted:${ID}`);
    expect(row.phoneVerifiedFor).toBeNull();
    // the rest of the scrub is as it was
    expect(row).toMatchObject({
      email: null,
      firstName: null,
      passwordHash: null,
      status: 'banned',
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(gone).toEqual(['refresh', 'reset']);
  });

  it('leaves no copy of the number anywhere in the row', async () => {
    await anonymise().expect(200);
    expect(JSON.stringify(row)).not.toContain('8031234567');
  });

  it('an anonymised account proves nothing even if phone_verified_at stays set', async () => {
    await anonymise().expect(200);
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect(phoneIsProven(row)).toBe(false);
  });

  it('refuses a request without the service key and changes nothing', async () => {
    await request(app.getHttpServer() as App)
      .delete(`/internal/users/${ID}?mode=anonymize`)
      .expect(401);
    expect(row.phoneVerifiedFor).toBe(REAL);
    expect(row.phone).toBe(REAL);
  });

  it('a hard delete removes the row and leaves nothing to clear', async () => {
    await request(app.getHttpServer() as App)
      .delete(`/internal/users/${ID}`)
      .set('x-service-key', KEY)
      .expect(200);
    expect(row).toBeUndefined();
  });
});
