import {
  endingIn,
  formatLagosDate,
  formatLagosDateTime,
  formatMoney,
} from './notice-format';
import type { ParsedNotice, PaidWhen } from './notice-kinds';

/**
 * The words of each notice mail (EMAIL-01). One headline, a short body, a facts
 * box, and no button: the notice data carries no address of an app screen, and
 * a button to nowhere is worse than none.
 *
 * Every figure comes from the Hub's data. Nothing here promises what the
 * system does not do: an earning is "paid into your wallet automatically",
 * never "landed", because earnings move once a day (R-55); a sale made through
 * a store waits 3 working days (R-101); a creator with no wallet has the money
 * kept for them (R-11). Plain text only: the layout escapes it. No em-dash
 * (R-5), no brand but "Who Made This?" (R-68, R-76).
 */
export interface Fact {
  label: string;
  value: string;
}

export interface NoticeContent {
  subject: string;
  /** The line an inbox shows beside the subject. */
  preheader: string;
  headline: string;
  /** One to three short paragraphs, plain text. */
  paragraphs: string[];
  facts: Fact[];
}

/** A title kept short for a subject line. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** What happens to an earning and when, as the person is told. */
function earningLine(paidWhen: PaidWhen): string {
  switch (paidWhen) {
    case 'now':
      return 'Your earnings are paid into your wallet automatically. You do not need to do anything.';
    case 'in_3_working_days':
      return 'Your earnings reach your wallet in 3 working days. You do not need to do anything.';
    case 'when_wallet_opens':
      return 'You have not opened your wallet yet, so your earnings are kept safe for you. They are added the moment you open your wallet.';
  }
}

function paidFact(paidWhen: PaidWhen): Fact {
  switch (paidWhen) {
    case 'now':
      return { label: 'Paid', value: 'Into your wallet' };
    case 'in_3_working_days':
      return { label: 'Paid', value: 'In 3 working days' };
    case 'when_wallet_opens':
      return { label: 'Paid', value: 'When you open your wallet' };
  }
}

const RETURNED_TO_LABEL = {
  wallet: 'Your wallet',
  card: 'Your card',
  source_account: 'The account you paid from',
  question_credit: 'A question credit',
} as const;

export function noticeContent(notice: ParsedNotice): NoticeContent {
  switch (notice.kind) {
    case 'pin_changed': {
      return {
        subject: 'Your transaction PIN was changed',
        preheader: 'The PIN that approves your payments was changed.',
        headline: 'Your transaction PIN was changed',
        paragraphs: [
          'The PIN that approves payments from your wallet was changed. If you did this, you do not need to do anything.',
          'If you did not, reset your PIN in the app now and contact support from the app.',
        ],
        facts: [{ label: 'When', value: formatLagosDateTime(notice.data.at) }],
      };
    }
    case 'account_deletion_started': {
      const on = formatLagosDate(notice.data.deleteOn);
      return {
        subject: `Your account will be deleted on ${on}`,
        preheader: `Sign in before ${on} to keep your account.`,
        headline: 'Your account is set to be deleted',
        paragraphs: [
          `We have started deleting your Who Made This? account. It will be deleted on ${on}.`,
          'To keep it, sign in before then and the deletion is cancelled. If you did not ask for this, sign in now to stop it, and change your password.',
        ],
        facts: [{ label: 'Deleted on', value: on }],
      };
    }
    case 'account_deleted': {
      return {
        subject: 'Your account has been deleted',
        preheader: 'Thank you for the time you spent with us.',
        headline: 'Your account has been deleted',
        paragraphs: [
          'Your Who Made This? account and your personal details have been deleted. We keep only what the law requires us to keep.',
          'Thank you for the time you spent with us.',
        ],
        facts: [],
      };
    }
    case 'money_in': {
      const d = notice.data;
      const amt = formatMoney(d.amountMinor, d.currency);
      const facts: Fact[] = [{ label: 'Amount', value: amt }];
      if (d.senderName) facts.push({ label: 'From', value: d.senderName });
      return {
        subject: d.senderName
          ? `${amt} from ${clip(d.senderName, 40)}`
          : `${amt} added to your wallet`,
        preheader: 'The money is in your wallet.',
        headline: d.senderName
          ? `You received ${amt}`
          : `${amt} added to your wallet`,
        paragraphs: [
          d.senderName
            ? `${d.senderName} sent you money and it is now in your wallet.`
            : 'The money is now in your wallet.',
        ],
        facts,
      };
    }
    case 'bank_send_completed': {
      const d = notice.data;
      const amt = formatMoney(d.amountMinor, d.currency);
      const facts: Fact[] = [{ label: 'Amount sent', value: amt }];
      if (d.feeMinor > 0) {
        facts.push(
          { label: 'Fees', value: formatMoney(d.feeMinor, d.currency) },
          {
            label: 'Total from your wallet',
            value: formatMoney(d.amountMinor + d.feeMinor, d.currency),
          },
        );
      }
      facts.push(
        { label: 'To', value: d.recipientName },
        { label: 'Bank', value: d.bankName },
        { label: 'Account', value: `ending ${d.accountLast4}` },
        { label: 'Reference', value: d.reference },
      );
      return {
        subject: `${amt} sent to ${clip(d.recipientName, 40)}`,
        preheader: `Your transfer to ${clip(d.recipientName, 40)} was sent.`,
        headline: 'Your transfer was sent',
        paragraphs: [
          `We sent ${amt} to ${d.recipientName} at ${d.bankName}, account ending ${d.accountLast4}.`,
        ],
        facts,
      };
    }
    case 'bank_send_failed': {
      const d = notice.data;
      const amt = formatMoney(d.amountMinor, d.currency);
      const facts: Fact[] = [{ label: 'Transfer', value: amt }];
      const paragraphs = [`The transfer of ${amt} did not go through.`];
      if (d.returnedMinor > 0) {
        const back = formatMoney(d.returnedMinor, d.currency);
        facts.push({ label: 'Returned to your wallet', value: back });
        paragraphs.push(
          `We returned ${back} to your wallet. You can try the transfer again.`,
        );
      } else {
        paragraphs.push(
          'If money left your wallet, contact support in the app and give them the reference below.',
        );
      }
      facts.push({ label: 'Reference', value: d.reference });
      return {
        subject: 'Your transfer did not go through',
        preheader: `The transfer of ${amt} did not go through.`,
        headline: 'Your transfer did not go through',
        paragraphs,
        facts,
      };
    }
    case 'sale_made': {
      const d = notice.data;
      const earned = formatMoney(d.earnedMinor, d.currency);
      const facts: Fact[] = [{ label: 'Item', value: d.itemTitle }];
      if (d.buyerName) facts.push({ label: 'Buyer', value: d.buyerName });
      facts.push({ label: 'You earned', value: earned }, paidFact(d.paidWhen));
      return {
        subject: `You made a sale: ${clip(d.itemTitle, 40)}`,
        preheader: `You earned ${earned}.`,
        headline: 'You made a sale',
        paragraphs: [
          `${d.buyerName ?? 'Someone'} bought ${d.itemTitle}. You earned ${earned}.`,
          earningLine(d.paidWhen),
        ],
        facts,
      };
    }
    case 'tip_received': {
      const d = notice.data;
      const earned = formatMoney(d.earnedMinor, d.currency);
      const facts: Fact[] = [];
      if (d.fromName) facts.push({ label: 'From', value: d.fromName });
      facts.push({ label: 'You earned', value: earned }, paidFact(d.paidWhen));
      return {
        subject: d.fromName
          ? `${clip(d.fromName, 40)} sent you a tip`
          : 'You received a tip',
        preheader: `You earned ${earned}.`,
        headline: 'You received a tip',
        paragraphs: [
          `${d.fromName ?? 'Someone'} sent you a tip. You earned ${earned}.`,
          earningLine(d.paidWhen),
        ],
        facts,
      };
    }
    case 'paid_message_received': {
      const d = notice.data;
      const earned = formatMoney(d.earnedMinor, d.currency);
      const by = formatLagosDateTime(d.replyBy);
      const facts: Fact[] = [];
      if (d.fromName) facts.push({ label: 'From', value: d.fromName });
      facts.push(
        { label: 'You will earn', value: earned },
        { label: 'Reply by', value: by },
      );
      return {
        subject: d.fromName
          ? `${clip(d.fromName, 40)} sent you a paid message`
          : 'You have a paid message',
        preheader: `Reply by ${by} to earn ${earned}.`,
        headline: 'You have a paid message',
        paragraphs: [
          `${d.fromName ?? 'Someone'} paid to message you. Reply by ${by} to earn ${earned}.`,
          'If you do not reply in time, the money goes back to the person who paid.',
        ],
        facts,
      };
    }
    case 'refund_processed': {
      const d = notice.data;
      const amt =
        d.amountMinor !== null && d.currency !== null
          ? formatMoney(d.amountMinor, d.currency)
          : null;
      const facts: Fact[] = [{ label: 'For', value: d.what }];
      if (amt) facts.push({ label: 'Amount', value: amt });
      facts.push({
        label: 'Returned to',
        value: RETURNED_TO_LABEL[d.returnedTo],
      });
      const paragraphs: string[] = [];
      switch (d.returnedTo) {
        case 'wallet':
          paragraphs.push(
            amt
              ? `We returned ${amt} to your wallet for ${d.what}.`
              : `Your refund for ${d.what} has been returned to your wallet.`,
          );
          break;
        case 'card':
          paragraphs.push(
            amt
              ? `We refunded ${amt} to the card you paid with, for ${d.what}.`
              : `Your refund for ${d.what} was sent to the card you paid with.`,
            'Your bank decides when it shows on your statement.',
          );
          break;
        case 'source_account':
          paragraphs.push(
            amt
              ? `We sent ${amt} back to the account you paid from, for ${d.what}.`
              : `Your refund for ${d.what} was sent back to the account you paid from.`,
          );
          break;
        case 'question_credit':
          paragraphs.push(
            amt
              ? `You now have a question credit worth ${amt}, for ${d.what}.`
              : `You now have a question credit for ${d.what}.`,
            amt
              ? 'Use it to ask any creator at that price or less. A question credit is not cash and cannot be cashed out.'
              : 'Use it to ask any creator at the price you paid or less. A question credit is not cash and cannot be cashed out.',
          );
          break;
      }
      return {
        subject: `Refund processed: ${clip(d.what, 40)}`,
        preheader: amt
          ? `Your refund of ${amt} has been processed.`
          : 'Your refund has been processed.',
        headline: 'Your refund has been processed',
        paragraphs,
        facts,
      };
    }
    case 'purchase_receipt': {
      const d = notice.data;
      const paid = formatMoney(d.paidMinor, d.currency);
      return {
        subject: `Receipt: ${clip(d.itemTitle, 50)}`,
        preheader: `You paid ${paid}.`,
        headline: 'Thank you for your purchase',
        paragraphs: [
          `You paid ${paid} from your wallet for ${d.itemTitle}.`,
          'Keep this email as your receipt.',
        ],
        facts: [
          { label: 'Item', value: d.itemTitle },
          { label: 'Paid', value: paid },
          { label: 'Reference', value: d.reference },
        ],
      };
    }
    case 'ticket_confirmed': {
      const d = notice.data;
      const when = formatLagosDateTime(d.startsAt);
      const facts: Fact[] = [
        { label: 'Event', value: d.eventTitle },
        { label: 'When', value: when },
      ];
      if (d.place) facts.push({ label: 'Place', value: d.place });
      facts.push(
        {
          label: 'Paid',
          value:
            d.paidMinor === 0 ? 'Free' : formatMoney(d.paidMinor, d.currency),
        },
        { label: 'Ticket', value: d.ticketRef },
      );
      return {
        subject: `Your ticket for ${clip(d.eventTitle, 50)}`,
        preheader: `${when}.`,
        headline: 'Your ticket is confirmed',
        paragraphs: [
          `You are going to ${d.eventTitle}.`,
          'Open your ticket in the app when you arrive.',
        ],
        facts,
      };
    }
    case 'event_cancelled': {
      const d = notice.data;
      const refund =
        d.refundMinor !== null && d.currency !== null
          ? formatMoney(d.refundMinor, d.currency)
          : null;
      const facts: Fact[] = [{ label: 'Event', value: d.eventTitle }];
      if (refund) facts.push({ label: 'Refund', value: refund });
      const paragraphs = [
        `${d.eventTitle} has been cancelled, so your ticket is no longer valid.`,
      ];
      if (refund) paragraphs.push(`We are refunding ${refund} to you.`);
      return {
        subject: `${clip(d.eventTitle, 50)} has been cancelled`,
        preheader: 'Your ticket is no longer valid.',
        headline: 'Your event was cancelled',
        paragraphs,
        facts,
      };
    }
    case 'bill_paid': {
      const d = notice.data;
      const amt = formatMoney(d.amountMinor, d.currency);
      const facts: Fact[] = [
        { label: 'Biller', value: d.billerName },
        { label: 'For', value: endingIn(d.customerRef) },
        { label: 'Amount', value: amt },
      ];
      if (d.token) facts.push({ label: 'Token', value: d.token });
      if (d.units) facts.push({ label: 'Units', value: d.units });
      facts.push({ label: 'Reference', value: d.reference });
      return {
        subject: `Bill paid: ${clip(d.billerName, 50)}`,
        preheader: `We paid ${amt} to ${clip(d.billerName, 40)}.`,
        headline: 'Your bill payment went through',
        paragraphs: [
          `We paid ${amt} to ${d.billerName}.`,
          ...(d.token ? ['Your token is below.'] : []),
        ],
        facts,
      };
    }
  }
}
