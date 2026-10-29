import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { exportDeadlineText } from './data-export-link';
import { htmlToText } from './mail-text';
import {
  labelOf,
  type MoneyCheckReportMail,
  nairaOf,
  noticeSentence,
  STATE_LABELS,
  subjectOf,
  VERDICT_SENTENCE,
} from './money-check-report';
import { formatLagosDateTime } from './notice/notice-format';
import type { Fact, NoticeContent } from './notice/notice-words';

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

/**
 * The banner at the top of every email: WAWU ID's own picture, drawn from the
 * app's mark and name, so it reads "Who Made This?" (EMAIL-01 round 1). The
 * web app's old banner read "WAWUAfrica" and is left where it is.
 *
 * It has to be an absolute, publicly reachable URL: mail clients fetch it from
 * their own network with no session, so anything behind auth, or on a host
 * that no longer exists, silently renders as nothing. WAWU ID serves it at
 * /assets/email-header.png (EmailHeaderController). EMAIL_HEADER_URL still
 * overrides it per environment.
 */
const DEFAULT_HEADER_URL = 'https://id.wawuafrica.com/assets/email-header.png';

/** Options for the shared WAWUAfrica email layout. */
interface LayoutOptions {
  /** Inbox-preview text (hidden in the body). */
  preheader: string;
  /** First name for the "Hello {{First Name}}," greeting. Optional. */
  firstName?: string | null;
  /** The one headline, above the greeting (EMAIL-01). Optional. */
  headline?: string;
  /** A facts box of label and value rows, for money and dates (EMAIL-01). Optional. */
  facts?: Fact[];
  /** Main body HTML (paragraphs, lists) injected into the white card. */
  bodyHtml: string;
  /** Optional single primary CTA rendered as a dark pill button. */
  cta?: { label: string; url: string };
}

/** What a one-time code mail can be told beyond the code (every field is optional). */
export interface OtpCodeOptions {
  /** How long the code lives, in whole minutes, as the mail says it. Default 10. */
  expiresInMinutes?: number;
  /** false keeps the recipient's address out of the mailer's log lines. Default true. */
  logRecipient?: boolean;
}

/**
 * The mail was not handed to the transport: no transport is configured, or
 * Resend refused or could not be reached. Thrown only to a caller that asked
 * for `strict` delivery (a sign-up code, where "sent" must be true).
 */
export class MailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailSendError';
  }
}

/** Why the relay could not send (EMAIL-02), as POST /internal/mail/send maps it. */
export type MailRelayFailure =
  | 'not_configured'
  | 'invalid_address'
  | 'unavailable'
  | 'refused';

export class MailRelayError extends Error {
  constructor(
    readonly kind: MailRelayFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MailRelayError';
  }
}

export interface RelayedMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Kept on the provider's record of the mail (the campaign id). */
  tag?: string;
  /** Same key on a retry: the provider answers with the first result. */
  idempotencyKey?: string;
  /** Files that travel with the mail; `content` is base64. */
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
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
      'Who Made This? <noreply@wawuafrica.com>';
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

  /** True when a real mail transport is configured (RESEND_API_KEY is set). */
  isConfigured(): boolean {
    return this.resend !== null;
  }

  /**
   * Hand a mail to Resend. By default a failure is logged and swallowed (a
   * notification that does not arrive must not break the request that caused
   * it). With `strict`, a missing transport, an error answer from Resend or an
   * unreachable Resend throws MailSendError, for a sign-up code that the
   * person is waiting for.
   */
  async send(
    to: string,
    subject: string,
    html: string,
    strict = false,
    logRecipient = true,
  ): Promise<void> {
    if (!this.resend) {
      if (strict) throw new MailSendError('no mail transport is configured');
      // No real mail transport configured (local dev without a Resend key).
      // Log any 6-digit verification code so a developer can still complete
      // a real end-to-end flow locally -- this is NOT a bypass (there is no
      // fixed/guessable value here, only whatever code was actually just
      // generated for this specific request) and this branch can never run
      // in a real deployment, which always has RESEND_API_KEY set.
      const code = html.match(
        /letter-spacing:10px;color:[^;"]+;">(\d{6})</,
      )?.[1];
      this.logger.warn(
        `[mail skipped] to=${to} subject="${subject}"${code ? ` code=${code}` : ''}`,
      );
      return;
    }
    try {
      const result = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html,
        // Every mail also goes as plain text, made from the same html.
        text: htmlToText(html),
      });
      // Resend answers an error as data, not as a throw.
      if (result.error) throw new Error(result.error.message);
      this.logger.log(logRecipient ? `Email sent: ${to}` : 'Email sent');
    } catch (err) {
      // A mail that must not name its recipient in the logs also keeps the
      // provider's own error text out of them: it can echo the address.
      this.logger.error(
        logRecipient
          ? `Email failed to ${to}: ${String(err)}`
          : 'Email failed (the provider did not take it)',
      );
      if (strict) throw new MailSendError('the mail could not be sent');
    }
  }

  /**
   * Send one finished mail the Hub built (EMAIL-02): its admin
   * email campaigns. The From is always this service's MAIL_FROM. Unlike
   * send(), it never swallows a failure: the caller is told which kind, so it
   * can retry a busy provider and give up on a bad address.
   */
  async sendRelayed(mail: RelayedMail): Promise<{ id: string }> {
    if (!this.resend) {
      throw new MailRelayError(
        'not_configured',
        'WAWU ID has no email key set (RESEND_API_KEY), so no email can be sent.',
      );
    }
    let result: Awaited<ReturnType<Resend['emails']['send']>>;
    try {
      result = await this.resend.emails.send(
        {
          from: this.from,
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(mail.headers && Object.keys(mail.headers).length > 0
            ? { headers: mail.headers }
            : {}),
          ...(mail.tag
            ? { tags: [{ name: 'campaign', value: mail.tag }] }
            : {}),
          ...(mail.attachments && mail.attachments.length > 0
            ? {
                attachments: mail.attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content, 'base64'),
                  ...(a.contentType ? { contentType: a.contentType } : {}),
                })),
              }
            : {}),
        },
        mail.idempotencyKey
          ? { idempotencyKey: mail.idempotencyKey }
          : undefined,
      );
    } catch {
      throw new MailRelayError(
        'unavailable',
        'The email provider could not be reached. Try again.',
      );
    }
    if (result.error) {
      const { statusCode, name } = result.error;
      const detail = result.error.message.slice(0, 200);
      if (statusCode === null || statusCode === 429 || statusCode >= 500) {
        throw new MailRelayError(
          'unavailable',
          'The email provider is busy or unavailable. Try again.',
        );
      }
      if (
        (statusCode === 400 || statusCode === 422) &&
        name !== 'invalid_from_address'
      ) {
        throw new MailRelayError('invalid_address', detail);
      }
      this.logger.error(
        `Relayed mail refused by Resend: ${name} ${statusCode}`,
      );
      throw new MailRelayError(
        'refused',
        'The email provider refused the message.',
      );
    }
    if (!result.data?.id) {
      throw new MailRelayError(
        'unavailable',
        'The email provider gave no answer. Try again.',
      );
    }
    return { id: result.data.id };
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
    const headline = opts.headline
      ? `<h1 style="margin:0 0 18px;font-size:26px;line-height:1.25;font-weight:700;color:${MAIL_COLORS.textPrimary};">${this.escape(opts.headline)}</h1>`
      : '';
    const facts = this.factsBox(opts.facts ?? []);
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
<title>Who Made This?</title>
</head>
<body style="margin:0;padding:0;background-color:${MAIL_COLORS.page};-webkit-text-size-adjust:100%;">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${MAIL_COLORS.page};">${this.escape(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${MAIL_COLORS.page};">
  <tr>
    <td align="center" style="padding:28px 12px 36px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr>
          <td style="padding:0;line-height:0;">
            <img src="${this.headerUrl}" alt="Who Made This?" width="600" style="display:block;width:100%;max-width:600px;height:auto;margin:0 auto;border:0;border-radius:14px 14px 0 0;" />
          </td>
        </tr>
        <tr>
          <td bgcolor="${MAIL_COLORS.card}" style="background-color:${MAIL_COLORS.card};border-radius:0 0 14px 14px;border-left:1px solid ${MAIL_COLORS.hairline};border-right:1px solid ${MAIL_COLORS.hairline};border-bottom:1px solid ${MAIL_COLORS.hairline};padding:36px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            ${headline}
            ${greeting}
            <div style="font-size:16px;line-height:1.65;color:${MAIL_COLORS.textSecondary};">
              ${opts.bodyHtml}
            </div>
            ${facts}
            ${cta}
          </td>
        </tr>
        <tr>
          <td style="padding:26px 40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${MAIL_COLORS.textMuted};text-align:center;">
            <p style="margin:0;font-weight:600;color:${MAIL_COLORS.textPrimary};">The Who Made This? Team</p>
            <p style="margin:6px 0 0;">We Build Ecosystems. Not Programs.</p>
            <p style="margin:2px 0 0;">Where Africa Connects, Shares, Learns and Grows.</p>
            <p style="margin:16px 0 0;color:${MAIL_COLORS.textDisabled};">&copy; ${year} Who Made This? All rights reserved.</p>
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

  /**
   * The facts box: label and value rows for money and dates. Each row is
   * marked `data-fact` so the plain-text part reads it back as "Label: value".
   * Everything in it is escaped here.
   */
  private factsBox(facts: Fact[]): string {
    if (facts.length === 0) return '';
    const font = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`;
    const rows = facts
      .map((f, i) => {
        const edge =
          i === facts.length - 1
            ? ''
            : `border-bottom:1px solid ${MAIL_COLORS.hairline};`;
        return `<tr data-fact="1"><td width="38%" valign="top" style="padding:12px 16px;${edge}${font}font-size:13px;line-height:1.5;color:${MAIL_COLORS.textMuted};">${this.escape(f.label)}</td><td valign="top" style="padding:12px 16px;${edge}${font}font-size:15px;line-height:1.5;font-weight:600;color:${MAIL_COLORS.textPrimary};word-break:break-word;">${this.escape(f.value)}</td></tr>`;
      })
      .join('');
    return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${MAIL_COLORS.tag}" style="margin:22px 0 4px;background-color:${MAIL_COLORS.tag};border:1px solid ${MAIL_COLORS.hairline};border-radius:12px;">${rows}</table>`;
  }

  /**
   * A notice mail (EMAIL-01, POST /internal/mail/notice) as html and plain
   * text: the headline, a short body, the facts box, no button. The words come
   * from `noticeContent()`; this puts them in the layout and escapes them.
   */
  renderNotice(
    content: NoticeContent,
    firstName?: string | null,
  ): { html: string; text: string } {
    const html = this.layout({
      preheader: content.preheader,
      firstName,
      headline: content.headline,
      bodyHtml: content.paragraphs.map((t) => this.p(this.escape(t))).join(''),
      facts: content.facts,
    });
    return { html, text: htmlToText(html) };
  }

  // ── boss templates ──────────────────────────────────────────────────────────

  /** [WELCOME] You are In. Welcome to Who Made This? */
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
        `Use the link below to create your Ditto account. Your Who Made This? plan takes ${discountPercent}% off Ditto's price. The discount is applied through this link, so use it rather than signing up directly.`,
      ),
      this.p(
        'From there you can release unlimited music as one artist to 150+ platforms, keep your royalty splits automatic, and see your fan analytics.',
      ),
      this.p(
        'This link stays in your subscription settings on Who Made This? too, so you do not need to keep this email.',
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
        `Your Who Made This? creator account has not been activated with a plan, and it is due to be removed in about ${hoursLeft} hours.`,
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
      `Your Who Made This? account closes in ${hoursLeft} hours`,
      this.layout({
        preheader: `Pick a plan to keep your account. About ${hoursLeft} hours left.`,
        firstName,
        bodyHtml: body,
        cta: { label: 'Pick a plan', url: planUrl },
      }),
    );
  }

  /**
   * The link to download a person's data export (task FIX-53, the Hub's
   * SETTINGS-04), to the one person the Hub named. The Hub gives the checked
   * link and when it stops working (`parseDataExportLink`); this service
   * writes the mail. Strict: a mail that could not be handed to the transport
   * throws, so the Hub keeps the request and sends it again.
   */
  async sendDataExportLink(
    email: string,
    firstName: string | null | undefined,
    downloadUrl: string,
    expiresAt: Date,
  ): Promise<void> {
    const deadline = exportDeadlineText(expiresAt);
    const body = [
      this.p('Your copy of your Who Made This? data is ready to download.'),
      this.p(
        `The link works until ${this.escape(deadline)} (Lagos time). After that you can ask for a new copy in Settings.`,
      ),
      this.p(
        'Anyone with this link can download your data, so keep it to yourself. If you did not ask for it, you can ignore this email, and it is worth changing your password.',
      ),
    ].join('');

    await this.send(
      email,
      'Your Who Made This? data is ready to download',
      this.layout({
        preheader: `Your data export is ready. The link works until ${deadline}.`,
        firstName,
        bodyHtml: body,
        cta: { label: 'Download my data', url: this.escape(downloadUrl) },
      }),
      true,
    );
  }

  /**
   * The nightly money check's report (task MONEY-16, G-690), to the one
   * person the Hub named. The Hub gives the facts and this service writes the
   * mail, so nothing in it is the Hub's own HTML: every value arrives already
   * checked by `parseMoneyCheckReport` and is escaped again here. Counts,
   * references and amounts only. Strict: a mail that could not be handed to
   * the transport throws, so the Hub keeps the report and sends it again.
   */
  async sendMoneyCheckReport(
    email: string,
    firstName: string | null | undefined,
    report: MoneyCheckReportMail,
  ): Promise<void> {
    const e = (v: string): string => this.escape(v);
    const strong = (v: string): string =>
      `<strong style="color:${MAIL_COLORS.textPrimary};">${e(v)}</strong>`;
    const muted = (v: string): string =>
      `<span style="color:${MAIL_COLORS.textMuted};">${e(v)}</span>`;
    const heading = (v: string): string =>
      `<p style="margin:24px 0 8px;font-size:16px;font-weight:600;color:${MAIL_COLORS.textPrimary};">${e(v)}</p>`;
    const line = (html: string): string =>
      `<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:${MAIL_COLORS.textSecondary};">${html}</p>`;

    const parts: string[] = [
      this.p(
        `${strong(`Night of ${report.night}`)} on ${e(labelOf(report.provider))}. ${e(VERDICT_SENTENCE[report.verdict])}`,
      ),
      line(
        `${strong(`${report.walletsChecked} of ${report.walletsTotal}`)} wallets were checked. ` +
          `${strong(String(report.mismatchCount))} ${report.mismatchCount === 1 ? 'difference' : 'differences'} between our ledger and the provider, ` +
          `${strong(String(report.lookCount))} ${report.lookCount === 1 ? 'thing' : 'things'} for a person to look at.`,
      ),
    ];

    parts.push(heading('What was checked'));
    // A night that did not finish gives every check the same note: say it once.
    const first = report.checks[0]?.note ?? null;
    const same =
      first !== null &&
      report.checks.length > 1 &&
      report.checks.every((c) => c.note === first);
    if (same) parts.push(line(muted(first)));
    for (const c of report.checks) {
      parts.push(
        line(
          `${strong(labelOf(c.id))}: ${e(STATE_LABELS[c.state])}. ${c.checked} compared, ${c.found} found.` +
            (c.note && !same ? ` ${muted(c.note)}` : ''),
        ),
      );
    }

    parts.push(heading('Held money'));
    parts.push(
      line(
        `${report.held.openCount} open ${report.held.openCount === 1 ? 'hold' : 'holds'} worth ${e(nairaOf(report.held.openKobo))}. ` +
          `WAWU's account needs at least ${e(nairaOf(report.held.requiredKobo))}` +
          (report.held.merchantAvailableKobo === null
            ? ' and could not be read.'
            : ` and has ${e(nairaOf(report.held.merchantAvailableKobo))}.`),
      ),
    );

    const notices = Object.entries(report.notices);
    if (notices.length > 0) {
      parts.push(heading('Worth knowing'));
      for (const [key, n] of notices) {
        parts.push(line(e(noticeSentence(key, n))));
      }
    }

    if (report.items.length > 0) {
      parts.push(heading('What differs or needs a look'));
      for (const it of report.items) {
        const amounts =
          it.amountKobo === undefined
            ? ''
            : ` ${e(nairaOf(it.amountKobo))}` +
              (it.otherKobo === undefined
                ? ''
                : ` against ${e(nairaOf(it.otherKobo))}`);
        parts.push(
          line(
            `${strong(it.severity === 'mismatch' ? 'Difference' : 'Look')} ${muted(labelOf(it.check))}. ${e(it.detail)}${amounts} ` +
              `${muted(`Reference ${it.ref}`)}`,
          ),
        );
      }
      if (report.itemsOmitted > 0) {
        parts.push(
          line(
            `${e(String(report.itemsOmitted))} more ${report.itemsOmitted === 1 ? 'is' : 'are'} in the stored report on the Hub.`,
          ),
        );
      }
    }

    await this.send(
      email,
      subjectOf(report),
      this.layout({
        preheader: `${VERDICT_SENTENCE[report.verdict]} ${report.walletsChecked} of ${report.walletsTotal} wallets checked.`,
        firstName,
        bodyHtml: parts.join(''),
      }),
      true,
    );
  }

  /**
   * The welcome. Sent once the person's email is proven on the web, and once
   * more at the end of the app's sign-up when the email was proven there
   * (AuthService.verifyEmail, SignupSequenceService.complete). The sign-off
   * is the live one and stays: it names the company the person leads, not the
   * product.
   */
  async sendWelcome(email: string, firstName?: string | null): Promise<void> {
    const body = [
      this.p(
        'You are now part of a community of Africans who refuse to believe that opportunity should be limited by geography, background, or circumstance.',
      ),
      this.p(
        'This is your space to connect, learn, and grow. Your next step is simple: complete your profile and start exploring.',
      ),
      this.p(
        "Africa's future is not waiting to be built. It is already being built by people like you. See you inside.",
      ),
      this.p('Emmanuel Lennox<br />CEO, WAWUAfrica'),
    ].join('');

    await this.send(
      email,
      'You are In. Welcome to Who Made This?',
      this.layout({
        preheader: 'You are now part of the Who Made This? community.',
        firstName,
        headline: 'Welcome to Who Made This?',
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
        'For years, Who Made This? has been a place to discover opportunities, learn new skills, grow your business, and connect with a powerful ecosystem. But we could only hear you through emails and WhatsApp messages.',
      ),
      this.p(
        'Now we have added something new: a place for your thoughts, your experiences, your opinions, your stories, your voice.',
      ),
      this.p(
        'Welcome to the new Who Made This? Community: a space where entrepreneurs, students, professionals, farmers, creators, traders, innovators, and everyday Africans like you can connect, learn, debate, laugh, inspire, and be inspired.',
      ),
      this.p('A few conversations have already started:'),
      '<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.6;color:#111111;">' +
        '<li style="margin:0 0 6px;">African Parents Deserve Their Own Country</li>' +
        '<li style="margin:0 0 6px;">Soft Life Is Expensive</li>' +
        '<li style="margin:0 0 6px;">I Know Somebody Is Africa\'s Biggest Industry</li>' +
        '<li style="margin:0 0 6px;">The Next African Unicorn Might Be in This Community</li>' +
        '<li style="margin:0 0 6px;">Farming Is Having a Glow-Up</li>' +
        '</ul>',
      this.p('And trust us, the comments are where the real magic happens.'),
      this.p(
        '<strong>Your account is ready.</strong> Setting your password takes under a minute. Just tap the button below to set it and step inside.',
      ),
    ].join('');

    await this.send(
      email,
      'Africa is talking. Come and say something.',
      this.layout({
        preheader:
          'Set your password and step into the new Who Made This? Community.',
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
        preheader: 'Reset your Who Made This? password.',
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

  /**
   * [SIGN-IN ALERT] Sent on every sign-in (EMAIL-01). It says when, never
   * which device or where: nothing here knows either, and a guess would be
   * worse than silence.
   */
  async sendLoginAlert(
    email: string,
    secureUrl: string,
    firstName?: string | null,
    at: Date = new Date(),
  ): Promise<void> {
    const body = [
      this.p(
        'Your Who Made This? account was just signed in to. If this was you, you do not need to do anything.',
      ),
      this.p(
        'If it was not you, reset your password now so nobody else can get in.',
      ),
    ].join('');

    await this.send(
      email,
      'New sign-in to your account',
      this.layout({
        preheader: 'Your Who Made This? account was just signed in to.',
        firstName,
        headline: 'You just signed in',
        bodyHtml: body,
        facts: [{ label: 'When', value: formatLagosDateTime(at) }],
        cta: { label: 'Secure my account', url: secureUrl },
      }),
    );
  }

  /**
   * [PASSWORD CHANGED] Sent after a password is changed in the app and after
   * a reset (EMAIL-01). Every other device is signed out by both, so the mail
   * says so.
   */
  async sendPasswordChanged(
    email: string,
    secureUrl: string,
    firstName?: string | null,
    at: Date = new Date(),
  ): Promise<void> {
    const body = [
      this.p(
        'The password for your Who Made This? account was changed, and any other device that was signed in has been signed out. If you did this, you do not need to do anything.',
      ),
      this.p(
        'If you did not, reset your password now and contact support from the app.',
      ),
    ].join('');

    await this.send(
      email,
      'Your password was changed',
      this.layout({
        preheader: 'The password for your Who Made This? account was changed.',
        firstName,
        headline: 'Your password was changed',
        bodyHtml: body,
        facts: [{ label: 'When', value: formatLagosDateTime(at) }],
        cta: { label: 'Reset my password', url: secureUrl },
      }),
    );
  }

  /**
   * [VERIFICATION CODE] Your Who Made This? verification code
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
    strict = false,
    options: OtpCodeOptions = {},
  ): Promise<void> {
    const reason = purpose ?? 'complete your verification';
    const minutes = options.expiresInMinutes ?? 10;
    const lives = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const body = [
      this.p(`Use the code below to ${this.escape(reason)}.`),
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;">
         <tr>
           <td align="center" bgcolor="${MAIL_COLORS.tag}" style="background-color:${MAIL_COLORS.tag};border:1px solid ${MAIL_COLORS.borderAccent};border-radius:14px;padding:22px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:34px;font-weight:700;letter-spacing:10px;color:${MAIL_COLORS.textPrimary};">${this.escape(code)}</td>
         </tr>
       </table>`,
      this.p(
        `This code expires in ${lives}. Please do not share it with anyone.`,
      ),
      this.p(
        'If you did not request this code, you can safely ignore this email. Your account remains secure.',
      ),
    ].join('');

    await this.send(
      email,
      'Your Who Made This? verification code',
      this.layout({
        preheader: `Your Who Made This? verification code (expires in ${lives}).`,
        bodyHtml: body,
      }),
      strict,
      options.logRecipient ?? true,
    );
  }

  /**
   * [YOU'RE VERIFIED] Sent when a verification tick is granted (it was
   * "account approved"; the method keeps its name so no caller changes).
   */
  async sendAccountApproved(
    email: string,
    firstName?: string | null,
  ): Promise<void> {
    const body = [
      this.p(
        'Your verification is active, and your badge now shows on your profile.',
      ),
      this.p('Verified accounts can upload more and reach more people.'),
    ].join('');

    await this.send(
      email,
      "You're verified",
      this.layout({
        preheader: 'Your badge is now on your profile.',
        firstName,
        headline: "You're verified",
        bodyHtml: body,
      }),
    );
  }
}
