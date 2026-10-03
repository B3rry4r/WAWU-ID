import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'crypto';
import type { Request } from 'express';
import { SessionReader } from './session-reader';

const keys = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

describe('SessionReader', () => {
  const ours = keys();
  const theirs = keys();
  const jwt = new JwtService({
    privateKey: ours.privateKey,
    publicKey: ours.publicKey,
    signOptions: { algorithm: 'RS256' },
    verifyOptions: { algorithms: ['RS256'] },
  });
  const users = new Map<string, Record<string, unknown>>();
  const prisma = {
    wawuUser: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(users.get(where.id) ?? null),
    },
  };
  const env: Record<string, string> = {};
  const reader = new SessionReader(
    jwt,
    { get: (name: string) => env[name] } as never,
    prisma as never,
  );
  const ID = '00000000-0000-0000-0000-0000000000aa';
  const req = (authorization?: string) =>
    ({ headers: authorization ? { authorization } : {} }) as Request;
  const access = (payload: object = { sub: ID }, options = {}) =>
    jwt.sign(payload, { algorithm: 'RS256', expiresIn: '15m', ...options });

  async function refused(r: Request) {
    await expect(reader.accountFor(r)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await reader.accountFor(r).catch((err: UnauthorizedException) =>
      expect(err.getResponse()).toEqual({
        statusCode: 401,
        code: 'SESSION_INVALID',
        message: 'Sign in again.',
      }),
    );
  }

  beforeEach(() => {
    users.clear();
    users.set(ID, { id: ID, status: 'active', deletedAt: null });
    delete env.JWT_ISSUER;
  });

  it('reads the account behind a live access token', async () => {
    await expect(reader.accountFor(req(`Bearer ${access()}`))).resolves.toEqual(
      users.get(ID),
    );
  });

  it('refuses a refresh token: it is signed by the same key but opens nothing', async () => {
    await refused(
      req(`Bearer ${access({ sub: ID, jti: 'j', type: 'refresh' })}`),
    );
  });

  it('refuses no header, another scheme, garbage, an expired token and one signed by another key', async () => {
    await refused(req());
    await refused(req(`Basic ${access()}`));
    await refused(req('Bearer not.a.token'));
    await refused(req(`Bearer ${access({ sub: ID }, { expiresIn: -10 })}`));
    const forged = new JwtService({ privateKey: theirs.privateKey }).sign(
      { sub: ID },
      { algorithm: 'RS256' },
    );
    await refused(req(`Bearer ${forged}`));
  });

  it('checks the issuer when one is configured', async () => {
    env.JWT_ISSUER = 'https://id.example.test';
    await refused(req(`Bearer ${access()}`));
    await expect(
      reader.accountFor(
        req(
          `Bearer ${access({ sub: ID }, { issuer: 'https://id.example.test' })}`,
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses an account that is gone, suspended or being deleted', async () => {
    await refused(req(`Bearer ${access({ sub: 'someone-else' })}`));
    users.set(ID, { id: ID, status: 'suspended', deletedAt: null });
    await refused(req(`Bearer ${access()}`));
    users.set(ID, {
      id: ID,
      status: 'pending_deletion',
      deletedAt: new Date(),
    });
    await refused(req(`Bearer ${access()}`));
  });
});
