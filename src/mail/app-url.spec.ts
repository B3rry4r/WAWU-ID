import { AuthService } from '../auth/auth.service';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { appBaseUrl, securityUrl } from './app-url';

/**
 * ID-LINKS (R-133 point 4): every link WAWU ID mails starts with a host, even
 * when FRONTEND_URL, APP_URL and SECURITY_URL are all unset. No mail is sent:
 * the mailer is a stand-in that records the link.
 */
const LIVE = 'https://wawuafrica.com';
const settings = (s: Record<string, string | undefined>) => ({
  get: (k: string) => s[k],
});

describe('the host of a mailed link', () => {
  it('falls back to the live site with nothing set', () => {
    expect(appBaseUrl(settings({}))).toBe(LIVE);
    expect(appBaseUrl(settings({ FRONTEND_URL: '', APP_URL: '  ' }))).toBe(
      LIVE,
    );
  });
  it('uses FRONTEND_URL, then APP_URL, and trims trailing slashes', () => {
    expect(
      appBaseUrl(
        settings({
          FRONTEND_URL: 'https://f.example.test//',
          APP_URL: 'https://a.example.test',
        }),
      ),
    ).toBe('https://f.example.test');
    expect(appBaseUrl(settings({ APP_URL: 'https://a.example.test/' }))).toBe(
      'https://a.example.test',
    );
  });
  it('sends "this was not me" to forgot-password, or SECURITY_URL when set', () => {
    expect(securityUrl(settings({}))).toBe(`${LIVE}/forgot-password`);
    expect(
      securityUrl(settings({ FRONTEND_URL: 'https://f.example.test/' })),
    ).toBe('https://f.example.test/forgot-password');
    expect(
      securityUrl(
        settings({
          FRONTEND_URL: 'https://f.example.test',
          SECURITY_URL: 'https://s.example.test/safe',
        }),
      ),
    ).toBe('https://s.example.test/safe');
  });
});

describe('the reset link', () => {
  async function resetLink(s: Record<string, string | undefined>) {
    const prisma = {
      wawuUser: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'ada@wawuafrica.com',
          phone: '+2348031234412',
          firstName: 'Ada',
          emailVerified: true,
          phoneVerifiedAt: null,
        }),
      },
      passwordResetToken: { create: jest.fn().mockResolvedValue({}) },
    };
    const mail = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
    const auth = new AuthService(
      prisma as never,
      {} as never,
      { generateAndSend: jest.fn() } as never,
      mail as never,
      settings(s) as never,
    );
    await auth.forgotPassword('ada@wawuafrica.com', 'email');
    return (mail.sendPasswordReset.mock.calls[0] as [string, string])[1];
  }

  it('is absolute with every setting unset', async () => {
    expect(await resetLink({})).toMatch(
      /^https:\/\/wawuafrica\.com\/reset-password\?token=[^&]+&email=ada%40wawuafrica\.com$/,
    );
  });
  it('uses FRONTEND_URL when set, and APP_URL when only that is set', async () => {
    expect(
      await resetLink({ FRONTEND_URL: 'https://f.example.test/' }),
    ).toMatch(/^https:\/\/f\.example\.test\/reset-password\?token=/);
    expect(await resetLink({ APP_URL: 'https://a.example.test' })).toMatch(
      /^https:\/\/a\.example\.test\/reset-password\?token=/,
    );
  });
});

describe('the activation link', () => {
  async function activationLink(s: Record<string, string | undefined>) {
    const mail = {
      sendPasswordCreation: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new ProvisioningService(
      {} as never,
      mail as never,
      { issueActivationToken: jest.fn().mockResolvedValue('tok123') } as never,
      settings(s) as never,
      {} as never,
    );
    await (
      svc as unknown as {
        sendActivation(
          id: string,
          email: string,
          first: string | null,
        ): Promise<void>;
      }
    ).sendActivation('u1', 'ada@wawuafrica.com', 'Ada');
    return (mail.sendPasswordCreation.mock.calls[0] as [string, string])[1];
  }

  it('is absolute with every setting unset, and an explicit setting wins', async () => {
    expect(await activationLink({})).toBe(
      `${LIVE}/activate?token=tok123&email=ada%40wawuafrica.com`,
    );
    expect(
      await activationLink({ FRONTEND_URL: 'https://f.example.test' }),
    ).toMatch(/^https:\/\/f\.example\.test\/activate\?token=tok123/);
  });
});
