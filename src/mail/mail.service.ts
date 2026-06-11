import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

const DEFAULT_HEADER_URL = 'https://production.wawuafrica.com/email-header.png';

/** Options for the shared WAWUAfrica email layout. */
interface LayoutOptions {
  /** Inbox-preview text (hidden in the body). */
  preheader: string;
  /** First name for the "Hello {{First Name}}," greeting. Optional. */
  firstName?: string | null;
  /** Main body HTML (paragraphs, lists) injected into the white card. */
  bodyHtml: string;
  /** Optional single primary CTA rendered as a dark pill button. */
  cta?: { label: string; url: string };
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;
  private readonly headerUrl: string;

  constructor(private readonly config: ConfigService) {
    this.from =
      this.config.get<string>('MAIL_FROM') ??
      'WAWUAfrica <noreply@wawuafrica.com>';
    this.headerUrl =
      this.config.get<string>('EMAIL_HEADER_URL') ?? DEFAULT_HEADER_URL;
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY not set — emails will be skipped');
      this.resend = null;
      return;
    }
    this.resend = new Resend(apiKey);
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`[mail skipped] to=${to} subject="${subject}"`);
      return;
    }
    try {
      await this.resend.emails.send({ from: this.from, to, subject, html });
      this.logger.log(`Email sent: ${to}`);
    } catch (err) {
      this.logger.error(`Email failed to ${to}: ${String(err)}`);
    }
  }

  // ── shared WAWUAfrica layout ────────────────────────────────────────────────

  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Render the shared, mobile-friendly WAWUAfrica email shell: header image at
   * the very top, white content card on a light background, optional dark pill
   * CTA, and the WAWUAfrica-only footer. No framework/Resend/Node chrome.
   */
  private layout(opts: LayoutOptions): string {
    const year = new Date().getFullYear();
    const greeting = opts.firstName
      ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#111111;">Hello ${this.escape(opts.firstName)},</p>`
      : '';
    const cta = opts.cta
      ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;">
              <tr>
                <td align="center" bgcolor="#111111" style="border-radius:999px;">
                  <a href="${opts.cta.url}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;background-color:#111111;">${this.escape(opts.cta.label)}</a>
                </td>
              </tr>
            </table>`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>WAWUAfrica</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;-webkit-text-size-adjust:100%;">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f5;">${this.escape(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr>
          <td style="padding:0;">
            <img src="${this.headerUrl}" alt="WAWUAfrica" width="600" style="display:block;width:100%;max-width:600px;height:auto;margin:0 auto;border:0;" />
          </td>
        </tr>
        <tr>
          <td style="background-color:#ffffff;border-radius:0 0 12px 12px;padding:36px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            ${greeting}
            <div style="font-size:16px;line-height:1.6;color:#333333;">
              ${opts.bodyHtml}
            </div>
            ${cta}
          </td>
        </tr>
        <tr>
          <td style="padding:28px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#888888;text-align:center;">
            <p style="margin:0;font-weight:600;color:#111111;">The WAWUAfrica Team</p>
            <p style="margin:6px 0 0;">We Build Ecosystems. Not Programs.</p>
            <p style="margin:2px 0 0;">Where Africa Connects, Shares, Learns and Grows.</p>
            <p style="margin:14px 0 0;color:#aaaaaa;">&copy; ${year} WAWUAfrica. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  }

  private p(text: string): string {
    return `<p style="margin:0 0 16px;">${text}</p>`;
  }

  // ── boss templates ──────────────────────────────────────────────────────────

  /** [WELCOME] You are In. Welcome to WAWUAfrica */
  async sendWelcome(email: string, firstName?: string | null): Promise<void> {
    const body = [
      this.p('Welcome to WAWUAfrica. We are so glad to have you with us.'),
      this.p(
        'You are now part of a community of Africans who refuse to believe that opportunity should be limited by geography, background, or circumstance.',
      ),
      this.p(
        'Some join to learn. Some come for opportunities. Others arrive to grow their businesses, connect with new people, or discover new markets. Whatever brought you here, we are glad you came.',
      ),
      this.p(
        'This is your space to connect, contribute, learn, trade, grow, and build meaningful relationships across Africa.',
      ),
      this.p(
        'Your next step is simple: complete your profile and start exploring.',
      ),
      this.p(
        "Africa's future is not waiting to be built. It is already being built by people like you. See you inside.",
      ),
      this.p('Emmanuel Lennox<br />CEO, WAWUAfrica'),
    ].join('');

    await this.send(
      email,
      'You are In. Welcome to WAWUAfrica',
      this.layout({
        preheader: 'You are now part of the WAWUAfrica community.',
        firstName,
        bodyHtml: body,
      }),
    );
  }

  /** [EMAIL VERIFICATION] One More Click and You are Officially In */
  async sendEmailVerification(
    email: string,
    verifyUrl: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'We are excited to have you here. Before you can access your account, we just need to make sure this email belongs to you. Click below to verify your email address.',
      ),
      this.p(
        'It takes less time than finding your charger when your phone is on 2%. We will wait.',
      ),
    ].join('');

    await this.send(
      email,
      'One More Click and You are Officially In',
      this.layout({
        preheader: 'Verify your email to finish setting up your account.',
        firstName,
        bodyHtml: body,
        cta: { label: 'Verify My Email', url: verifyUrl },
      }),
    );
  }

  /** [PASSWORD CREATION] Let us Get Your Account Ready (activation path) */
  async sendPasswordCreation(
    email: string,
    activationUrl: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'Your WAWUAfrica account is almost ready. The only thing left is creating a password so you can securely access your profile and everything waiting for you inside.',
      ),
      this.p(
        'A strong password is like a good gate. It keeps the right people in and the wrong people out. See you inside.',
      ),
    ].join('');

    await this.send(
      email,
      'Let us Get Your Account Ready',
      this.layout({
        preheader: 'Create your password to finish setting up your account.',
        firstName,
        bodyHtml: body,
        cta: { label: 'Create Password', url: activationUrl },
      }),
    );
  }

  /** Backwards-compatible alias for the existing activation call site. */
  async sendActivation(email: string, activationUrl: string): Promise<void> {
    await this.sendPasswordCreation(email, activationUrl);
  }

  /** [PASSWORD RESET] It Happens To The Best Of Us */
  async sendPasswordReset(
    email: string,
    resetUrl: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'Forgot your password? You are in good company. Let us get you back into your account. Click the button below to create a new password.',
      ),
      this.p(
        'If you did not request this reset, you can safely ignore this email. Your account remains secure.',
      ),
    ].join('');

    await this.send(
      email,
      'It Happens To The Best Of Us',
      this.layout({
        preheader: 'Reset your WAWUAfrica password.',
        firstName,
        bodyHtml: body,
        cta: { label: 'Reset Password', url: resetUrl },
      }),
    );
  }

  /** [PROFILE INCOMPLETE] We Need To Put A Face To The Name */
  async sendProfileIncomplete(
    email: string,
    completeUrl: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'Right now, your profile is a little like meeting someone who says: I will tell you about myself later. Let us fix that.',
      ),
      this.p(
        'Add your photo, tell us what you do, share your interests, and let people discover the amazing person behind the account. The more complete your profile, the more opportunities can find you.',
      ),
      this.p(
        'Because great connections usually start with a great introduction.',
      ),
    ].join('');

    await this.send(
      email,
      'We Need To Put A Face To The Name',
      this.layout({
        preheader: 'Complete your profile so opportunities can find you.',
        firstName,
        bodyHtml: body,
        cta: { label: 'Complete My Profile', url: completeUrl },
      }),
    );
  }

  /** [LOGIN ALERT] Was This You? */
  async sendLoginAlert(
    email: string,
    secureUrl: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'A new login was detected on your WAWUAfrica account. If this was you, you are all set. If not, please secure your account immediately.',
      ),
      this.p('Better safe than sorry.'),
    ].join('');

    await this.send(
      email,
      'Was This You?',
      this.layout({
        preheader: 'A new login was detected on your account.',
        firstName,
        bodyHtml: body,
        cta: { label: 'Secure My Account', url: secureUrl },
      }),
    );
  }

  /** [ACCOUNT APPROVED] Good News. You are Officially Part Of The Ecosystem */
  async sendAccountApproved(
    email: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'Your account has been approved. That means you are ready to start exploring opportunities, connecting with people, joining conversations, and becoming part of one of Africa’s fastest-growing communities.',
      ),
      this.p(
        'Your seat at the table is ready. Let us build something remarkable together.',
      ),
    ].join('');

    await this.send(
      email,
      'Good News. You are Officially Part Of The Ecosystem',
      this.layout({
        preheader: 'Your WAWUAfrica account has been approved.',
        firstName,
        bodyHtml: body,
      }),
    );
  }
}
