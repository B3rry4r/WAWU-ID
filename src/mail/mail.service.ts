import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/**
 * The email header banner.
 *
 * This pointed at `production.wawuafrica.com`, which is the previous PHP
 * platform's domain. That host is being decommissioned, so every email sent
 * after it goes offline would have rendered with a broken header image. It now
 * points at the new web app, which serves /email-header.png with the current
 * trademarked mark. EMAIL_HEADER_URL still overrides it per environment.
 */
/**
 * Mirrors the web app's tokens.css so an email and the app it belongs to look
 * like the same product. Flattened to solid hex: email clients cannot be
 * trusted with rgba() over a background.
 */
const MAIL_COLORS = {
  page: '#0B0A0D',
  card: '#131316',
  tag: '#201F27',
  hairline: '#26262B',
  accent: '#9411C9',
  borderAccent: '#5B2478',
  onAccent: '#FFFFFF',
  textPrimary: '#FEFEFE',
  textSecondary: '#A5A4AE',
  textMuted: '#6E6D78',
  textDisabled: '#4A4952',
} as const;

const DEFAULT_HEADER_URL =
  'https://wawu-web-production.up.railway.app/email-header.png';

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
      // No real mail transport configured (local dev without a Resend key).
      // Log any 6-digit verification code so a developer can still complete
      // a real end-to-end flow locally -- this is NOT a bypass (there is no
      // fixed/guessable value here, only whatever code was actually just
      // generated for this specific request) and this branch can never run
      // in a real deployment, which always has RESEND_API_KEY set.
      const code = html.match(/letter-spacing:10px;color:[^;"]+;">(\d{6})</)?.[1];
      this.logger.warn(
        `[mail skipped] to=${to} subject="${subject}"${code ? ` code=${code}` : ''}`,
      );
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
   * The shared WAWUAfrica email shell.
   *
   * This was a light-themed template left over from the previous platform:
   * grey page, white card, black pill buttons. The product it belongs to is
   * dark and purple, so every auth email a new user received looked like it
   * came from a different company than the app they had just signed up to.
   *
   * The palette here mirrors src/app/tokens.css in the web app exactly, with
   * one concession to email clients: borders and tints are flattened to solid
   * hex, because rgba() over a background is unreliable in Outlook and older
   * Gmail. `color-scheme` is declared so clients do not "helpfully" invert an
   * already-dark design.
   */
  private layout(opts: LayoutOptions): string {
    const year = new Date().getFullYear();
    const greeting = opts.firstName
      ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${MAIL_COLORS.textPrimary};font-weight:600;">Hello ${this.escape(opts.firstName)},</p>`
      : '';
    const cta = opts.cta
      ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;">
              <tr>
                <td align="center" bgcolor="${MAIL_COLORS.accent}" style="border-radius:999px;">
                  <a href="${opts.cta.url}" target="_blank" style="display:inline-block;padding:15px 38px;font-size:16px;font-weight:600;color:${MAIL_COLORS.onAccent};text-decoration:none;border-radius:999px;background-color:${MAIL_COLORS.accent};">${this.escape(opts.cta.label)}</a>
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
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>WAWUAfrica</title>
</head>
<body style="margin:0;padding:0;background-color:${MAIL_COLORS.page};-webkit-text-size-adjust:100%;">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${MAIL_COLORS.page};">${this.escape(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${MAIL_COLORS.page};">
  <tr>
    <td align="center" style="padding:28px 12px 36px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr>
          <td style="padding:0;line-height:0;">
            <img src="${this.headerUrl}" alt="WAWU" width="600" style="display:block;width:100%;max-width:600px;height:auto;margin:0 auto;border:0;border-radius:14px 14px 0 0;" />
          </td>
        </tr>
        <tr>
          <td bgcolor="${MAIL_COLORS.card}" style="background-color:${MAIL_COLORS.card};border-radius:0 0 14px 14px;border-left:1px solid ${MAIL_COLORS.hairline};border-right:1px solid ${MAIL_COLORS.hairline};border-bottom:1px solid ${MAIL_COLORS.hairline};padding:36px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            ${greeting}
            <div style="font-size:16px;line-height:1.65;color:${MAIL_COLORS.textSecondary};">
              ${opts.bodyHtml}
            </div>
            ${cta}
          </td>
        </tr>
        <tr>
          <td style="padding:26px 40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${MAIL_COLORS.textMuted};text-align:center;">
            <p style="margin:0;font-weight:600;color:${MAIL_COLORS.textPrimary};">The WAWUAfrica Team</p>
            <p style="margin:6px 0 0;">We Build Ecosystems. Not Programs.</p>
            <p style="margin:2px 0 0;">Where Africa Connects, Shares, Learns and Grows.</p>
            <p style="margin:16px 0 0;color:${MAIL_COLORS.textDisabled};">&copy; ${year} WAWUAfrica. All rights reserved.</p>
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
    return `<p style="margin:0 0 16px;color:${MAIL_COLORS.textSecondary};">${text}</p>`;
  }

  // ── boss templates ──────────────────────────────────────────────────────────

  /** [WELCOME] You are In. Welcome to WAWUAfrica */
  /**
   * The Ditto Music distribution invite, sent when a Pro Max creator OPTS IN.
   *
   * Opting in is a separate, explicit act from paying for Pro Max. The plan
   * includes access to distribution; it does not enrol anybody in a
   * third-party service on their behalf. Nothing here fires on payment — only
   * on the creator pressing the button.
   *
   * The link is also shown in the app the moment they opt in. This email is a
   * copy they can come back to, not the only way to reach it: a signup link a
   * creator can only retrieve from an inbox is one lost email away from being
   * a benefit they paid for and cannot use.
   */
  async sendDittoDistributionInvite(
    email: string,
    firstName: string | null | undefined,
    signupUrl: string,
    discountPercent: number,
  ): Promise<void> {
    const body = [
      this.p(
        'You have opted in to music distribution through Ditto Music, included with your Pro Max plan.',
      ),
      this.p(
        `Use the link below to create your Ditto account. Your WAWUAfrica plan takes ${discountPercent}% off Ditto's price — the discount is applied through this link, so use it rather than signing up directly.`,
      ),
      this.p(
        'From there you can release unlimited music as one artist to 150+ platforms, keep your royalty splits automatic, and see your fan analytics.',
      ),
      this.p(
        'This link stays in your subscription settings on WAWUAfrica too, so you do not need to keep this email.',
      ),
    ].join('');

    await this.send(
      email,
      'Your Ditto Music distribution link',
      this.layout({
        preheader: `Your Pro Max music distribution link, ${discountPercent}% off.`,
        firstName,
        bodyHtml: body,
        cta: { label: 'Set up Ditto Music', url: signupUrl },
      }),
    );
  }

  /**
   * The one warning before an unpaid creator account is removed.
   *
   * Sent once, roughly a day before deletion. It has to be specific about
   * three things or it is not a warning: what will go, when, and the single
   * action that stops it. No marketing, no plan comparison - somebody about
   * to lose an account should not have to read a pitch to find the deadline.
   */
  async sendUnpaidDeletionWarning(
    email: string,
    firstName: string | null | undefined,
    hoursLeft: number,
    planUrl: string,
  ): Promise<void> {
    const body = [
      this.p(
        `Your WAWUAfrica creator account has not been activated with a plan, and it is due to be removed in about ${hoursLeft} hours.`,
      ),
      this.p(
        'Picking a tier keeps the account and unlocks uploading straight away. If you do nothing, the account and the details you entered are deleted, and you would need to sign up again from scratch.',
      ),
      this.p(
        'If you signed up by mistake, you can safely ignore this. Nothing has been charged.',
      ),
    ].join('');

    await this.send(
      email,
      `Your WAWUAfrica account closes in ${hoursLeft} hours`,
      this.layout({
        preheader: `Pick a plan to keep your account. About ${hoursLeft} hours left.`,
        firstName,
        bodyHtml: body,
        cta: { label: 'Pick a plan', url: planUrl },
      }),
    );
  }

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
        'For years, WAWUAfrica has been a place to discover opportunities, learn new skills, grow your business, and connect with a powerful ecosystem. But we could only hear you through emails and WhatsApp messages.',
      ),
      this.p(
        'Now we have added something new — a place for your thoughts, your experiences, your opinions, your stories, your voice.',
      ),
      this.p(
        'Welcome to the new WAWUAfrica Community: a space where entrepreneurs, students, professionals, farmers, creators, traders, innovators, and everyday Africans like you can connect, learn, debate, laugh, inspire, and be inspired.',
      ),
      this.p('A few conversations have already started:'),
      '<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.6;color:#111111;">' +
        '<li style="margin:0 0 6px;">African Parents Deserve Their Own Country</li>' +
        '<li style="margin:0 0 6px;">Soft Life Is Expensive</li>' +
        '<li style="margin:0 0 6px;">I Know Somebody Is Africa\'s Biggest Industry</li>' +
        '<li style="margin:0 0 6px;">The Next African Unicorn Might Be in This Community</li>' +
        '<li style="margin:0 0 6px;">Farming Is Having a Glow-Up</li>' +
        '</ul>',
      this.p('And trust us — the comments are where the real magic happens.'),
      this.p(
        '<strong>Your account is ready.</strong> Setting your password takes under a minute — just tap the button below to set it and step inside.',
      ),
    ].join('');

    await this.send(
      email,
      'Africa is talking. Come and say something.',
      this.layout({
        preheader:
          'Set your password and step into the new WAWUAfrica Community.',
        firstName,
        bodyHtml: body,
        cta: { label: 'Set My Password', url: activationUrl },
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

  /**
   * [VERIFICATION CODE] Your WAWUAfrica verification code
   *
   * Presents a 6-digit OTP prominently. No CTA link — the user types the code
   * back into the app. Used both as the WhatsApp→email OTP fallback and by the
   * phone-change flow. `purpose` lets the body name what the code is for (e.g.
   * "verify your phone number change"); defaults to a generic verification line.
   */
  async sendOtpCode(
    email: string,
    code: string,
    purpose?: string,
  ): Promise<void> {
    const reason = purpose ?? 'complete your verification';
    const body = [
      this.p(`Use the code below to ${this.escape(reason)}.`),
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;">
         <tr>
           <td align="center" bgcolor="${MAIL_COLORS.tag}" style="background-color:${MAIL_COLORS.tag};border:1px solid ${MAIL_COLORS.borderAccent};border-radius:14px;padding:22px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:34px;font-weight:700;letter-spacing:10px;color:${MAIL_COLORS.textPrimary};">${this.escape(code)}</td>
         </tr>
       </table>`,
      this.p(
        'This code expires in 10 minutes. Please do not share it with anyone.',
      ),
      this.p(
        'If you did not request this code, you can safely ignore this email. Your account remains secure.',
      ),
    ].join('');

    await this.send(
      email,
      'Your WAWUAfrica verification code',
      this.layout({
        preheader: 'Your WAWUAfrica verification code (expires in 10 minutes).',
        bodyHtml: body,
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
