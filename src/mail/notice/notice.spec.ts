import { BadRequestException } from '@nestjs/common';
import { NOTICE_SAMPLES } from '../../testing/notice-samples';
import {
  formatLagosDate,
  formatLagosDateTime,
  formatMoney,
} from './notice-format';
import { NOTICE_KINDS, parseNotice } from './notice-kinds';
import { noticeContent } from './notice-words';

/**
 * EMAIL-01: the 16 notice kinds the Hub sends (POST /internal/mail/notice).
 * Pure checks: how money and time read, what data each kind accepts, and the
 * words each kind is rendered to.
 */
describe('formatMoney', () => {
  it('writes minor units the way the contract shows them', () => {
    expect(formatMoney(500000, 'NGN')).toBe('₦5,000.00');
    expect(formatMoney(1250, 'USD')).toBe('$12.50');
    expect(formatMoney(5, 'NGN')).toBe('₦0.05');
    expect(formatMoney(0, 'NGN')).toBe('₦0.00');
    expect(formatMoney(123456789, 'GBP')).toBe('£1,234,567.89');
    expect(formatMoney(100000, 'EUR')).toBe('€1,000.00');
  });
  it('puts the code in front of a currency with no symbol of its own', () => {
    expect(formatMoney(1000, 'GHS')).toBe('GHS 10.00');
    expect(formatMoney(250050, 'CAD')).toBe('CAD 2,500.50');
  });
});

describe('Lagos time', () => {
  it('shows a moment in Lagos time (UTC+1, no daylight saving)', () => {
    expect(formatLagosDateTime('2026-11-14T18:00:00Z')).toBe(
      'Sat 14 Nov 2026, 7:00 PM (Lagos time)',
    );
    expect(formatLagosDateTime('2026-11-14T23:30:00Z')).toBe(
      'Sun 15 Nov 2026, 12:30 AM (Lagos time)',
    );
    expect(formatLagosDateTime('2026-07-01T11:05:00Z')).toBe(
      'Wed 1 Jul 2026, 12:05 PM (Lagos time)',
    );
  });
  it('shows a date alone the Lagos way too', () => {
    expect(formatLagosDate('2026-12-14T09:30:00.000Z')).toBe('Mon 14 Dec 2026');
    expect(formatLagosDate('2026-12-14T23:30:00.000Z')).toBe('Tue 15 Dec 2026');
  });
});

describe('the kinds', () => {
  it('are exactly the 16 the contract names', () => {
    expect([...NOTICE_KINDS].sort()).toEqual(
      [
        'account_deleted',
        'account_deletion_started',
        'bank_send_completed',
        'bank_send_failed',
        'bill_paid',
        'event_cancelled',
        'money_in',
        'paid_message_received',
        'pass_sold',
        'pin_changed',
        'question_earned',
        'purchase_receipt',
        'refund_processed',
        'sale_made',
        'ticket_confirmed',
        'tip_received',
      ].sort(),
    );
    expect(Object.keys(NOTICE_SAMPLES).sort()).toEqual(
      [...NOTICE_KINDS].sort(),
    );
  });
});

describe('parseNotice', () => {
  const bad = (kind: string, data: unknown) => {
    try {
      parseNotice(kind, data);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as {
        message: string;
      };
      // One plain sentence a developer can act on, never an em-dash.
      expect(body.message).not.toContain('—');
      return body.message;
    }
    throw new Error(`expected ${kind} ${JSON.stringify(data)} to be refused`);
  };

  it.each(NOTICE_KINDS.map((k) => [k]))(
    'takes the sample data of %s',
    (kind) => {
      const parsed = parseNotice(kind, NOTICE_SAMPLES[kind]);
      expect(parsed.kind).toBe(kind);
    },
  );

  it('refuses a kind it does not know, and data that is not an object', () => {
    expect(bad('weekly_earnings', {})).toMatch(/kind/);
    expect(bad('money_in', null)).toMatch(/data/);
    expect(bad('money_in', [])).toMatch(/data/);
    expect(bad('money_in', 'x')).toMatch(/data/);
  });

  it.each(
    NOTICE_KINDS.flatMap((kind) =>
      Object.keys(NOTICE_SAMPLES[kind])
        .filter((field) => {
          // Fields the contract marks |null or ? may be null; the rest are required.
          const nullable = [
            'senderName',
            'buyerName',
            'fromName',
            'place',
            'token',
            'units',
          ];
          const bothOrNeither = ['amountMinor', 'currency', 'refundMinor'];
          if (kind === 'refund_processed' || kind === 'event_cancelled') {
            return !bothOrNeither.includes(field);
          }
          return !nullable.includes(field);
        })
        .map((field) => [kind, field]),
    ),
  )('refuses %s without %s', (kind, field) => {
    const data = { ...NOTICE_SAMPLES[kind] };
    delete data[field];
    expect(bad(kind, data)).toContain(field);
  });

  it('takes the fields the contract lets be null', () => {
    parseNotice('money_in', { ...NOTICE_SAMPLES.money_in, senderName: null });
    parseNotice('sale_made', { ...NOTICE_SAMPLES.sale_made, buyerName: null });
    parseNotice('tip_received', {
      ...NOTICE_SAMPLES.tip_received,
      fromName: null,
    });
    parseNotice('paid_message_received', {
      ...NOTICE_SAMPLES.paid_message_received,
      fromName: null,
    });
    parseNotice('ticket_confirmed', {
      ...NOTICE_SAMPLES.ticket_confirmed,
      place: null,
    });
    parseNotice('pass_sold', { ...NOTICE_SAMPLES.pass_sold, buyerName: null });
    parseNotice('question_earned', {
      ...NOTICE_SAMPLES.question_earned,
      fromName: null,
    });
    parseNotice('bill_paid', {
      ...NOTICE_SAMPLES.bill_paid,
      token: null,
      units: null,
    });
    parseNotice('refund_processed', {
      ...NOTICE_SAMPLES.refund_processed,
      amountMinor: null,
      currency: null,
    });
    parseNotice('event_cancelled', {
      ...NOTICE_SAMPLES.event_cancelled,
      refundMinor: null,
      currency: null,
    });
  });

  it('takes a free ticket (R-8) and refuses an amount that is not whole minor units', () => {
    parseNotice('ticket_confirmed', {
      ...NOTICE_SAMPLES.ticket_confirmed,
      paidMinor: 0,
    });
    expect(
      bad('money_in', { ...NOTICE_SAMPLES.money_in, amountMinor: 0 }),
    ).toContain('amountMinor');
    expect(
      bad('money_in', { ...NOTICE_SAMPLES.money_in, amountMinor: -5 }),
    ).toContain('amountMinor');
    expect(
      bad('money_in', { ...NOTICE_SAMPLES.money_in, amountMinor: 10.5 }),
    ).toContain('amountMinor');
    expect(
      bad('money_in', { ...NOTICE_SAMPLES.money_in, amountMinor: '500' }),
    ).toContain('amountMinor');
    expect(
      bad('money_in', { ...NOTICE_SAMPLES.money_in, amountMinor: 2 ** 60 }),
    ).toContain('amountMinor');
  });

  it('refuses a currency that is not a three-letter code', () => {
    for (const currency of ['ngn', 'NG', 'NAIRA', 5, null]) {
      expect(
        bad('money_in', { ...NOTICE_SAMPLES.money_in, currency }),
      ).toContain('currency');
    }
  });

  it('refuses a time that is not an ISO date', () => {
    for (const at of ['yesterday', '2026-13-45T00:00:00Z', 1700000000, '']) {
      expect(bad('pin_changed', { at })).toContain('at');
    }
    expect(
      bad('ticket_confirmed', {
        ...NOTICE_SAMPLES.ticket_confirmed,
        startsAt: 'soon',
      }),
    ).toContain('startsAt');
  });

  it('refuses a word out of the lists the contract fixes', () => {
    expect(
      bad('sale_made', { ...NOTICE_SAMPLES.sale_made, paidWhen: 'tomorrow' }),
    ).toContain('paidWhen');
    expect(
      bad('tip_received', { ...NOTICE_SAMPLES.tip_received, paidWhen: 'now ' }),
    ).toContain('paidWhen');
    expect(
      bad('refund_processed', {
        ...NOTICE_SAMPLES.refund_processed,
        returnedTo: 'cash',
      }),
    ).toContain('returnedTo');
  });

  it('refuses an account tail that is not four digits', () => {
    for (const accountLast4 of ['123', '12345', 'abcd', 1234, '0123456789']) {
      expect(
        bad('bank_send_completed', {
          ...NOTICE_SAMPLES.bank_send_completed,
          accountLast4,
        }),
      ).toContain('accountLast4');
    }
  });

  it('refuses a refund or an event refund that names an amount without a currency, or the reverse', () => {
    expect(
      bad('refund_processed', {
        ...NOTICE_SAMPLES.refund_processed,
        currency: null,
      }),
    ).toContain('currency');
    expect(
      bad('refund_processed', {
        ...NOTICE_SAMPLES.refund_processed,
        amountMinor: null,
      }),
    ).toContain('amountMinor');
    expect(
      bad('event_cancelled', {
        ...NOTICE_SAMPLES.event_cancelled,
        currency: null,
      }),
    ).toContain('currency');
    expect(
      bad('event_cancelled', {
        ...NOTICE_SAMPLES.event_cancelled,
        refundMinor: null,
      }),
    ).toContain('refundMinor');
  });

  it('refuses text that is empty, too long, or has a line break in it', () => {
    const base = NOTICE_SAMPLES.sale_made;
    expect(bad('sale_made', { ...base, itemTitle: '' })).toContain('itemTitle');
    expect(bad('sale_made', { ...base, itemTitle: '   ' })).toContain(
      'itemTitle',
    );
    expect(bad('sale_made', { ...base, itemTitle: 'x'.repeat(301) })).toContain(
      'itemTitle',
    );
    expect(
      bad('sale_made', { ...base, itemTitle: 'a\r\nBcc: x@y.z' }),
    ).toContain('itemTitle');
    expect(bad('sale_made', { ...base, buyerName: 'a\u0000b' })).toContain(
      'buyerName',
    );
    expect(bad('sale_made', { ...base, itemTitle: 5 })).toContain('itemTitle');
  });

  it('takes a number of units as well as text', () => {
    parseNotice('bill_paid', { ...NOTICE_SAMPLES.bill_paid, units: 31.4 });
    expect(
      bad('bill_paid', { ...NOTICE_SAMPLES.bill_paid, units: {} }),
    ).toContain('units');
  });

  it('ignores fields it does not know, so the Hub can add one without breaking a send', () => {
    const parsed = parseNotice('money_in', {
      ...NOTICE_SAMPLES.money_in,
      extra: 'x',
    });
    expect(parsed.data).not.toHaveProperty('extra');
  });
});

describe('noticeContent', () => {
  const content = (kind: string, over: Record<string, unknown> = {}) =>
    noticeContent(parseNotice(kind, { ...NOTICE_SAMPLES[kind], ...over }));
  const allText = (kind: string, over: Record<string, unknown> = {}) => {
    const c = content(kind, over);
    return [
      c.subject,
      c.preheader,
      c.headline,
      ...c.paragraphs,
      ...c.facts.flatMap((f) => [f.label, f.value]),
    ].join('\n');
  };

  it.each(NOTICE_KINDS.map((k) => [k]))(
    '%s has one subject, one headline, a short body and no dash, no button',
    (kind) => {
      const c = content(kind);
      expect(c.subject.length).toBeGreaterThan(5);
      expect(c.subject.length).toBeLessThanOrEqual(90);
      expect(c.subject).not.toMatch(/[\r\n]/);
      expect(c.headline.length).toBeGreaterThan(5);
      expect(c.paragraphs.length).toBeGreaterThanOrEqual(1);
      expect(c.paragraphs.length).toBeLessThanOrEqual(3);
      expect(c).not.toHaveProperty('button');
      const text = allText(kind);
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/by WAWU|WAWU Technology|WAWUAfrica/i);
      expect(text).not.toMatch(/\{\{|undefined|null|NaN/);
      expect(text).not.toMatch(/Nuvion|Fintava|Flutterwave/i);
    },
  );

  it('shows money the way the contract shows it', () => {
    const c = content('money_in');
    expect(c.facts).toEqual(
      expect.arrayContaining([
        { label: 'Amount', value: '₦5,000.00' },
        { label: 'From', value: 'Ada Obi' },
      ]),
    );
    expect(
      content('money_in', { senderName: null }).facts.map((f) => f.label),
    ).toEqual(['Amount']);
  });

  it('lays a bank send out as amount, fees, total, then who got it', () => {
    const c = content('bank_send_completed');
    expect(c.facts).toEqual([
      { label: 'Amount sent', value: '₦10,000.00' },
      { label: 'Fees', value: '₦65.00' },
      { label: 'Total from your wallet', value: '₦10,065.00' },
      { label: 'To', value: 'Tunde Bakare' },
      { label: 'Bank', value: 'Access Bank' },
      { label: 'Account', value: 'ending 4821' },
      { label: 'Reference', value: 'WTX-8H2K9Q' },
    ]);
    // A send with no fee never draws a "No fee" line (designer brief, rule 4).
    const free = content('bank_send_completed', { feeMinor: 0 });
    expect(free.facts.map((f) => f.label)).not.toContain('Fees');
    expect(JSON.stringify(free)).not.toMatch(/no fee/i);
  });

  it("says a failed send's money is on its way back, never that it was returned (the reversal lands after the send is marked failed)", () => {
    const c = content('bank_send_failed');
    expect(c.facts).toEqual(
      expect.arrayContaining([
        { label: 'Transfer', value: '₦10,000.00' },
        { label: 'Coming back to your wallet', value: '₦10,065.00' },
        { label: 'Reference', value: 'WTX-8H2K9Q' },
      ]),
    );
    const text = allText('bank_send_failed');
    expect(text).toContain(
      'Your ₦10,065.00 is on its way back to your wallet.',
    );
    expect(text).not.toMatch(
      /we returned|has been returned|was returned|returned to your wallet/i,
    );
    const none = content('bank_send_failed', { returnedMinor: 0 });
    expect(none.facts.map((f) => f.label)).not.toContain(
      'Coming back to your wallet',
    );
    expect(none.paragraphs.join(' ')).toMatch(/support/i);
    expect(JSON.stringify(none)).not.toMatch(/on its way back/i);
  });

  it('tells a creator when the earning is paid, the way R-11 and R-101 rule', () => {
    const now = allText('sale_made', { paidWhen: 'now' });
    expect(now).toMatch(/into your wallet/i);
    expect(now).not.toMatch(/3 working days|open one|landed/i);

    const store = allText('sale_made', { paidWhen: 'in_3_working_days' });
    expect(store).toMatch(/3 working days/);

    const waiting = allText('sale_made', { paidWhen: 'when_wallet_opens' });
    expect(waiting).toMatch(/open/i);
    expect(waiting).toMatch(/kept|waiting|safe/i);
    expect(waiting).not.toMatch(/has been added|landed/i);

    const tip = allText('tip_received', { paidWhen: 'when_wallet_opens' });
    expect(tip).toMatch(/open/i);
    expect(allText('tip_received', { paidWhen: 'in_3_working_days' })).toMatch(
      /3 working days/,
    );
  });

  it('tells a community pass seller and a question earner when it is paid, the same way a sale is told', () => {
    for (const kind of ['pass_sold', 'question_earned']) {
      const now = allText(kind, { paidWhen: 'now' });
      expect(now).toMatch(/into your wallet/i);
      expect(now).not.toMatch(/3 working days|open one|landed/i);
      expect(allText(kind, { paidWhen: 'in_3_working_days' })).toMatch(
        /3 working days/,
      );
      const waiting = allText(kind, { paidWhen: 'when_wallet_opens' });
      expect(waiting).toMatch(/open/i);
      expect(waiting).toMatch(/kept|waiting|safe/i);
      expect(waiting).not.toMatch(/has been added|landed/i);
    }
  });

  it('names the community, the buyer and what the pass earned', () => {
    const c = content('pass_sold');
    expect(c.headline).toBe('You sold a community pass');
    expect(c.facts).toEqual([
      { label: 'Community', value: 'Aba Tailors' },
      { label: 'Buyer', value: 'Funke A.' },
      { label: 'You earned', value: '₦4,250.00' },
      { label: 'Paid', value: 'Into your wallet' },
    ]);
    expect(c.paragraphs[0]).toContain('Funke A. bought a pass to Aba Tailors');
    const anon = content('pass_sold', { buyerName: null });
    expect(anon.facts.map((f) => f.label)).not.toContain('Buyer');
    expect(anon.paragraphs[0]).toContain(
      'Someone bought a pass to Aba Tailors',
    );
    expect(c.subject).toContain('Aba Tailors');
  });

  it('thanks a creator for an answered question with what it earned', () => {
    const c = content('question_earned');
    expect(c.headline).toBe('You earned from a paid message');
    expect(c.facts).toEqual([
      { label: 'From', value: 'Seun Adebayo' },
      { label: 'You earned', value: '₦850.00' },
      { label: 'Paid', value: 'In 3 working days' },
    ]);
    expect(c.paragraphs[0]).toContain('You answered Seun Adebayo');
    expect(content('question_earned', { fromName: null }).facts[0].label).toBe(
      'You earned',
    );
  });

  it('names a sale and a tip without the buyer when the buyer is not named', () => {
    expect(
      content('sale_made', { buyerName: null }).facts.map((f) => f.label),
    ).not.toContain('Buyer');
    expect(content('sale_made').facts).toEqual(
      expect.arrayContaining([
        { label: 'Item', value: 'Lagos at Dawn (photo set)' },
        { label: 'Buyer', value: 'Chidi Eze' },
        { label: 'You earned', value: '₦4,250.00' },
      ]),
    );
    expect(content('tip_received', { fromName: null }).headline).toMatch(
      /tip/i,
    );
  });

  it('gives a paid question its deadline in Lagos time and what happens if it is missed', () => {
    const c = content('paid_message_received');
    expect(c.facts).toEqual(
      expect.arrayContaining([
        { label: 'Reply by', value: 'Mon 16 Nov 2026, 1:00 PM (Lagos time)' },
        { label: 'You will earn', value: '₦4,250.00' },
      ]),
    );
    expect(c.paragraphs.join(' ')).toMatch(/goes back/i);
  });

  it('says where a refund went, and that a question credit is never cash (R-101)', () => {
    expect(allText('refund_processed', { returnedTo: 'wallet' })).toMatch(
      /your wallet/i,
    );
    expect(allText('refund_processed', { returnedTo: 'card' })).toMatch(
      /card/i,
    );
    expect(
      allText('refund_processed', { returnedTo: 'source_account' }),
    ).toMatch(/account you paid from/i);
    const credit = allText('refund_processed', {
      returnedTo: 'question_credit',
    });
    expect(credit).toMatch(/question credit/i);
    expect(credit).toMatch(/at that price or less/i);
    expect(credit).toMatch(/not cash|never cash|cannot be cashed/i);
    const noAmount = content('refund_processed', {
      amountMinor: null,
      currency: null,
    });
    expect(noAmount.facts.map((f) => f.label)).not.toContain('Amount');
  });

  it('prints a receipt, a ticket and a bill with every fact the person may need', () => {
    expect(content('purchase_receipt').facts).toEqual([
      { label: 'Item', value: 'Weaving basics (course)' },
      { label: 'Paid', value: '₦7,500.00' },
      { label: 'Reference', value: 'WTX-3D7PLM' },
    ]);
    const ticket = content('ticket_confirmed');
    expect(ticket.facts).toEqual([
      { label: 'Event', value: 'Makers Night Lagos' },
      { label: 'When', value: 'Sat 14 Nov 2026, 7:00 PM (Lagos time)' },
      { label: 'Place', value: 'Terra Kulture, Victoria Island' },
      { label: 'Paid', value: '₦5,000.00' },
      { label: 'Ticket', value: 'TKT-92KD3' },
    ]);
    expect(content('ticket_confirmed', { paidMinor: 0 }).facts).toEqual(
      expect.arrayContaining([{ label: 'Paid', value: 'Free' }]),
    );
    expect(
      content('ticket_confirmed', { place: null }).facts.map((f) => f.label),
    ).not.toContain('Place');
    const bill = content('bill_paid');
    expect(bill.facts).toEqual([
      { label: 'Biller', value: 'Ikeja Electric' },
      { label: 'For', value: 'ending 3645' },
      { label: 'Amount', value: '₦5,000.00' },
      { label: 'Token', value: '4821 9937 2210 6654 1203' },
      { label: 'Units', value: '31.4 kWh' },
      { label: 'Reference', value: 'WTX-BL55Z2' },
    ]);
    expect(
      content('bill_paid', { token: null, units: null }).facts.map(
        (f) => f.label,
      ),
    ).toEqual(['Biller', 'For', 'Amount', 'Reference']);
  });

  it('says a cancelled event refunds only when an amount is named', () => {
    expect(content('event_cancelled').facts).toEqual(
      expect.arrayContaining([{ label: 'Refund', value: '₦5,000.00' }]),
    );
    const none = content('event_cancelled', {
      refundMinor: null,
      currency: null,
    });
    expect(none.facts.map((f) => f.label)).not.toContain('Refund');
    expect(JSON.stringify(none)).not.toMatch(/refund/i);
  });

  it('dates the deletion and the PIN change in Lagos time', () => {
    expect(content('account_deletion_started').facts).toEqual([
      { label: 'Deleted on', value: 'Mon 14 Dec 2026' },
    ]);
    expect(allText('account_deletion_started')).toMatch(/sign in/i);
    expect(content('pin_changed').facts).toEqual([
      { label: 'When', value: 'Sat 14 Nov 2026, 7:05 PM (Lagos time)' },
    ]);
    expect(content('account_deleted').facts).toEqual([]);
  });

  it('keeps a title with markup in it as text for the mail layout to escape', () => {
    const c = content('sale_made', { itemTitle: '<b>Bold</b> & "quoted"' });
    expect(c.facts[0].value).toBe('<b>Bold</b> & "quoted"');
  });
});
