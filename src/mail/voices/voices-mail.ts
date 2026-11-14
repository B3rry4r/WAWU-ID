import { formatLagosDate, formatLagosDateTime } from '../notice/notice-format';

/**
 * The VOICES account mails (VOICES-MAIL, V-44), in the look of the owner's
 * Voices_Email_Templates (the A group). The shell and the pieces below are the
 * owner's markup; the words are checked against what WAWU ID and VOICES really
 * do (docs/mail/CATALOGUE.md in the VOICES backend repo lists each change).
 * Every merged value is escaped here. No link is built from a value a caller
 * can choose: they all start with the VOICES address.
 */

export const DEFAULT_VOICES_URL = 'https://usevoices.com';

export interface VoicesMailUrls {
  /** https://usevoices.com, no trailing slash. */
  app: string;
  /** Where the logo files are served from, no trailing slash. */
  assets: string;
}

export interface VoicesMail {
  subject: string;
  html: string;
}

const esc = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const FONT_HEAD = `'Rowdies','Arial Black',Impact,Helvetica,Arial,sans-serif`;
const FONT_BODY = `'Helvetica Neue',Helvetica,Arial,sans-serif`;

const STYLE = `
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0;mso-table-rspace:0}
img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
a{text-decoration:none}
@media only screen and (max-width:620px){
 .container{width:100%!important;max-width:100%!important}
 .px{padding-left:22px!important;padding-right:22px!important}
 .herotx{font-size:28px!important;line-height:32px!important}
 .btn-primary a,.btn-secondary a{display:block!important;padding:18px 12px!important}
 .btn-primary,.btn-secondary{width:100%!important}
}
@media (prefers-color-scheme:dark){
 .bg{background:#06150E!important}
 .card{background:#0C2418!important}
 .tx{color:#EAF4EE!important} .mt{color:#A9BDB1!important} .gt{color:#5FD8A2!important}
 .mint,.code{background:#10382A!important} .mintx,.codetx{color:#EAF4EE!important}
 .heromint,.herow{background:#10382A!important} .heromint .herotx,.herow .herotx{color:#EAF4EE!important}
 .line{border-color:#1D3C2D!important} .trk{background:#173528!important}
 .warn{background:#40300F!important;color:#FFD98A!important}
 .btn-secondary{background:transparent!important;border-color:#5FD8A2!important} .btn-secondary a{color:#5FD8A2!important}
}`;

type Hero = 'green' | 'dark';

interface Shell {
  urls: VoicesMailUrls;
  title: string;
  preheader: string;
  /** Small label at the top right of the banner. */
  label: string;
  hero: Hero;
  /** The one character in the round badge above the headline. */
  badge: string;
  headline: string;
  /** Inner html of the white card. */
  body: string;
}

/** A paragraph of body text. `text` is already escaped. */
export const para = (text: string): string =>
  `<p class="tx" style="margin:0 0 16px;font-size:16px;line-height:25px;color:#0E1A14">${text}</p>`;

const small = (text: string): string =>
  `<p class="mt" style="margin:22px 0 0;font-size:13px;line-height:20px;color:#51605A">${text}</p>`;

const button = (label: string, url: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px"><tr><td align="center" bgcolor="#0DA86A" class="btn-primary" style="border-radius:999px;background:#0DA86A;border:2px solid #0DA86A"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:17px 34px;font-family:${FONT_BODY};font-size:17px;font-weight:700;color:#002B1A;text-decoration:none;border-radius:999px;line-height:1">${esc(label)}</a></td></tr></table>`;

const warn = (text: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td class="warn" bgcolor="#FFF4D6" style="background:#FFF4D6;border-radius:16px;padding:16px 18px;font-size:14px;line-height:22px;color:#5B3A00">${text}</td></tr></table>`;

const facts = (rows: Array<[string, string]>): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border-top:2px solid #002B1A" class="line">${rows
    .map(
      ([k, v]) =>
        `<tr><td class="mt line" style="padding:11px 0;border-bottom:1px solid #DCE2DE;font-size:14px;color:#51605A" width="42%">${esc(k)}</td><td class="tx line" align="right" style="padding:11px 0;border-bottom:1px solid #DCE2DE;font-size:15px;font-weight:700;color:#0E1A14">${esc(v)}</td></tr>`,
    )
    .join('')}</table>`;

const ticks = (items: string[]): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${items
    .map(
      (t) =>
        `<tr><td valign="top" width="22" style="padding:5px 0;color:#087A4C;font-size:16px;font-weight:700" class="gt">&#10003;</td><td class="tx" style="padding:5px 0;font-size:15px;line-height:23px;color:#0E1A14">${t}</td></tr>`,
    )
    .join('')}</table>`;

function steps(items: Array<[string, string]>): string {
  const rows = items
    .map(
      ([head, sub], i) =>
        `<tr><td valign="top" width="46" style="padding:8px 0"><div style="width:34px;height:34px;border-radius:50%;background:#0DA86A;color:#002B1A;font-family:${FONT_HEAD};font-size:16px;line-height:34px;text-align:center">${i + 1}</div></td><td class="tx" style="padding:8px 0;font-size:16px;line-height:24px;color:#0E1A14"><b>${esc(head)}</b><br><span class="mt" style="color:#51605A;font-size:14px">${esc(sub)}</span></td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 14px">${rows}</table>`;
}

/** The code box. The style order keeps the mailer's local-dev code log working. */
const codeBox = (code: string, note: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td align="center" class="code" bgcolor="#DDF3E8" style="background:#DDF3E8;border-radius:20px;padding:22px 12px"><div style="font-family:${FONT_HEAD};font-size:42px;line-height:1;letter-spacing:10px;color:#002B1A;" class="codetx">${esc(code)}</div><div class="mt" style="font-size:13px;color:#51605A;margin-top:10px">${note}</div></td></tr></table>`;

function shell(s: Shell): string {
  const heroBg = s.hero === 'green' ? '#0DA86A' : '#002B1A';
  const heroTx = s.hero === 'green' ? '#002B1A' : '#FFFFFF';
  const badgeBg = s.hero === 'green' ? '#002B1A' : '#0DA86A';
  const badgeTx = s.hero === 'green' ? '#FFFFFF' : '#002B1A';
  const legal = `${s.urls.app}/settings/legal`;
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(s.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Rowdies:wght@700&amp;display=swap" rel="stylesheet">
<style>${STYLE}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#F5F5F5;font-family:${FONT_BODY}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#F5F5F5">${esc(s.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" bgcolor="#F5F5F5" style="background:#F5F5F5">
<tr><td align="center" style="padding:24px 12px 32px">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
<tr><td class="px" bgcolor="#002B1A" style="background:#002B1A;padding:22px 36px;border-radius:28px 28px 0 0">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
 <td align="left"><a href="${esc(s.urls.app)}"><img src="${esc(s.urls.assets)}/logo-wordmark-white.png" width="126" alt="Voices" style="display:block;width:126px;height:auto"></a></td>
 <td align="right" style="font-family:${FONT_BODY};font-size:10px;font-weight:700;letter-spacing:1.5px;color:#9BD5BA">${esc(s.label)}</td></tr></table></td></tr>
<tr><td class="${s.hero === 'green' ? 'herog' : 'herof'} px" bgcolor="${heroBg}" style="background:${heroBg};padding:34px 36px 30px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="52" height="52" style="width:52px;height:52px;border-radius:50%;background:${badgeBg};color:${badgeTx};font-family:${FONT_HEAD};font-size:26px;line-height:52px;text-align:center">${s.badge}</td></tr></table><div class="herotx" style="font-family:${FONT_HEAD};font-size:32px;line-height:36px;letter-spacing:-.5px;color:${heroTx};margin-top:18px">${esc(s.headline)}</div></td></tr>
<tr><td class="card px" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:32px 36px 34px">
${s.body}
</td></tr>
<tr><td class="card px" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:0 36px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="mint mintx" bgcolor="#DDF3E8" style="background:#DDF3E8;border-radius:18px;padding:16px 20px;font-size:14px;line-height:22px;color:#002B1A"><b>Need a hand?</b> Open Voices at <a href="${esc(s.urls.app)}" class="gt" style="color:#087A4C;font-weight:700">usevoices.com</a> to find your way around. Please do not reply to this email, because this address does not take replies.</td></tr></table></td></tr>
<tr><td class="px" style="padding:26px 36px 0">
<p class="mt" style="margin:0 0 10px;font-size:12px;line-height:19px;color:#51605A"><b>Stay safe:</b> Voices will never ask for your password or sign-in code by email, text or phone.</p>
<p class="mt" style="margin:0 0 12px;font-size:12px;line-height:19px;color:#51605A">You are getting this because someone used this address on Voices. This email is not optional, because it keeps your account and community safe.</p>
<p class="mt" style="margin:0 0 12px;font-size:12px;line-height:19px;color:#51605A">
<a href="${esc(legal)}/rules" class="gt" style="color:#087A4C">Community rules</a> &nbsp;&middot;&nbsp; <a href="${esc(legal)}/privacy" class="gt" style="color:#087A4C">Privacy</a> &nbsp;&middot;&nbsp; <a href="${esc(legal)}/terms" class="gt" style="color:#087A4C">Terms</a></p>
<p class="mt" style="margin:0;font-size:12px;line-height:19px;color:#51605A">Voices by WAWU<br>Voices is a place for real conversation. Strong opinions are welcome. Harassment and threats are not.</p>
</td></tr>
</table></td></tr></table>
</body>
</html>`;
}

const hello = (firstName?: string | null): string =>
  firstName ? `Hi ${esc(firstName)}, ` : '';

/** A01. Sent once the email is proven (and at the end of the app sign-up). */
export function voicesWelcome(
  urls: VoicesMailUrls,
  firstName?: string | null,
): VoicesMail {
  const name = firstName ? `, ${firstName}` : '';
  return {
    subject: `Welcome to Voices${name}`,
    html: shell({
      urls,
      title: `Welcome to Voices${name}`,
      preheader: 'Say what you think. Hear everyone else. Vote.',
      label: 'YOUR ACCOUNT',
      hero: 'green',
      badge: '&#10003;',
      headline: `You are in${name}.`,
      body:
        para(
          'Voices is where people say what they really think, in their own voice. Pick a question, tap the mic and talk.',
        ) +
        steps([
          ['Speak', 'Answer today’s question with your voice or in text.'],
          ['Discuss', 'Reply to others. Agree, disagree or say “same here”.'],
          [
            'Vote',
            'Pick an answer in the weekly poll and see the real counts.',
          ],
          ['What Next?', 'Back the ideas that could actually help.'],
        ]) +
        button('Hear today’s question', urls.app),
    }),
  };
}

/** A02. The 6-digit email code (a code, never a link: WAWU ID's email check is a code). */
export function voicesVerifyCode(
  urls: VoicesMailUrls,
  code: string,
  minutes: number,
  email: string,
  firstName?: string | null,
): VoicesMail {
  const lives = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return {
    subject: 'Confirm your email for Voices',
    html: shell({
      urls,
      title: 'Confirm your email for Voices',
      preheader: `Your Voices code expires in ${lives}.`,
      label: 'ACCOUNT SECURITY',
      hero: 'dark',
      badge: '&#9993;',
      headline: 'Confirm your email.',
      body:
        para(
          `${hello(firstName)}use this code to confirm <b>${esc(email)}</b>.`,
        ) +
        codeBox(
          code,
          `Type this code in the Voices app or at usevoices.com. It expires in ${lives}.`,
        ) +
        para('Please do not share this code with anyone.') +
        small(
          'If you did not create a Voices account, you can ignore this email.',
        ),
    }),
  };
}

/** A06. The reset link (WAWU ID mails a link for email, which opens the reset page on usevoices.com). */
export function voicesPasswordReset(
  urls: VoicesMailUrls,
  resetUrl: string,
  firstName?: string | null,
): VoicesMail {
  return {
    subject: 'Reset your Voices password',
    html: shell({
      urls,
      title: 'Reset your Voices password',
      preheader: 'Choose a new password. The link works for 1 hour.',
      label: 'ACCOUNT SECURITY',
      hero: 'dark',
      badge: '&#8226;',
      headline: 'Reset your password.',
      body:
        para(
          `${hello(firstName)}we got a request to reset the password for your Voices account. Tap the button to choose a new one.`,
        ) +
        button('Choose a new password', resetUrl) +
        small(
          'This link works for 1 hour and can only be used once. Did not ask for it? Ignore this email. Your password stays the same.',
        ),
    }),
  };
}

/** A07. After a password change or a reset. */
export function voicesPasswordChanged(
  urls: VoicesMailUrls,
  at: Date,
  firstName?: string | null,
): VoicesMail {
  return {
    subject: 'Your Voices password was changed',
    html: shell({
      urls,
      title: 'Your Voices password was changed',
      preheader: 'If it was not you, secure your account now.',
      label: 'ACCOUNT SECURITY',
      hero: 'dark',
      badge: '&#10003;',
      headline: 'Your password was changed.',
      body:
        para(
          `${hello(firstName)}the password for your Voices account was changed, and any other device that was signed in has been signed out.`,
        ) +
        facts([['When', formatLagosDateTime(at)]]) +
        warn(
          'If this was not you, reset your password now so nobody else can get in.',
        ) +
        button('Secure my account', `${urls.app}/forgot-password`),
    }),
  };
}

/** A08. One for every sign-in (WAWU ID cannot tell a new device from a known one). */
export function voicesSignInAlert(
  urls: VoicesMailUrls,
  at: Date,
  firstName?: string | null,
): VoicesMail {
  return {
    subject: 'New sign-in to your Voices account',
    html: shell({
      urls,
      title: 'New sign-in to your Voices account',
      preheader: 'Your Voices account was just signed in to.',
      label: 'ACCOUNT SECURITY',
      hero: 'dark',
      badge: '!',
      headline: 'You just signed in.',
      body:
        para(`${hello(firstName)}your Voices account was just signed in to.`) +
        facts([['When', formatLagosDateTime(at)]]) +
        para('If this was you, you do not need to do anything.') +
        para('If it was not you, reset your password now.') +
        button('This was not me', `${urls.app}/forgot-password`),
    }),
  };
}

/** A10. The deletion was asked for in VOICES; 14 days, undone only by Undo, tokens lost. */
export function voicesDeletionStarted(
  urls: VoicesMailUrls,
  deleteOn: string,
  firstName?: string | null,
): VoicesMail {
  const on = formatLagosDate(deleteOn);
  return {
    subject: 'We have received your request to delete your Voices account',
    html: shell({
      urls,
      title: 'We have received your request to delete your Voices account',
      preheader: `You have until ${on} to change your mind.`,
      label: 'ACCOUNT SECURITY',
      hero: 'dark',
      badge: '!',
      headline: 'We are sorry to see you go.',
      body:
        para(
          `${hello(firstName)}we received your request to delete your account. Your account will be deleted on <b>${esc(on)}</b>.`,
        ) +
        ticks([
          'Until then nothing is removed.',
          `To keep your account, open Voices and tap Undo before ${esc(on)}. Signing in again does not cancel it.`,
          'After that, your posts, recordings and any unspent tokens are gone. Tokens are never paid back as cash.',
        ]) +
        button('Keep my account', `${urls.app}/profile`),
    }),
  };
}

/** A11. The deletion has run. */
export function voicesDeleted(urls: VoicesMailUrls): VoicesMail {
  return {
    subject: 'Your Voices account has been deleted',
    html: shell({
      urls,
      title: 'Your Voices account has been deleted',
      preheader: 'Your voices and profile have been removed.',
      label: 'ACCOUNT SECURITY',
      hero: 'dark',
      badge: '&#10003;',
      headline: 'Your account is deleted.',
      body:
        para(
          'Your Voices account and your personal details have been deleted. We keep only what the law requires us to keep.',
        ) +
        para(
          'Thank you for the time you spent with us. You are always welcome back, and you can start fresh any time at usevoices.com.',
        ),
    }),
  };
}
