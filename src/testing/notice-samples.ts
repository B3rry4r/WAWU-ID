/**
 * One valid `data` object for every notice kind (EMAIL-01), as the Hub sends
 * it. Used by the specs and by the sample-mail script; no production module
 * imports it.
 */
export const NOTICE_SAMPLES: Record<string, Record<string, unknown>> = {
  pin_changed: { at: '2026-11-14T18:05:00.000Z' },
  account_deletion_started: { deleteOn: '2026-12-14T09:30:00.000Z' },
  account_deleted: {},
  money_in: { amountMinor: 500000, currency: 'NGN', senderName: 'Ada Obi' },
  bank_send_completed: {
    amountMinor: 1000000,
    feeMinor: 6500,
    currency: 'NGN',
    recipientName: 'Tunde Bakare',
    bankName: 'Access Bank',
    accountLast4: '4821',
    reference: 'WTX-8H2K9Q',
  },
  bank_send_failed: {
    amountMinor: 1000000,
    returnedMinor: 1006500,
    currency: 'NGN',
    reference: 'WTX-8H2K9Q',
  },
  sale_made: {
    itemTitle: 'Lagos at Dawn (photo set)',
    buyerName: 'Chidi Eze',
    earnedMinor: 425000,
    currency: 'NGN',
    paidWhen: 'now',
  },
  tip_received: {
    earnedMinor: 85000,
    currency: 'NGN',
    fromName: 'Amaka N.',
    paidWhen: 'in_3_working_days',
  },
  paid_message_received: {
    fromName: 'Seun Adebayo',
    earnedMinor: 425000,
    currency: 'NGN',
    replyBy: '2026-11-16T12:00:00.000Z',
  },
  refund_processed: {
    what: 'Lagos at Dawn (photo set)',
    amountMinor: 500000,
    currency: 'NGN',
    returnedTo: 'wallet',
  },
  purchase_receipt: {
    itemTitle: 'Weaving basics (course)',
    paidMinor: 750000,
    currency: 'NGN',
    reference: 'WTX-3D7PLM',
  },
  ticket_confirmed: {
    eventTitle: 'Makers Night Lagos',
    startsAt: '2026-11-14T18:00:00.000Z',
    place: 'Terra Kulture, Victoria Island',
    paidMinor: 500000,
    currency: 'NGN',
    ticketRef: 'TKT-92KD3',
  },
  event_cancelled: {
    eventTitle: 'Makers Night Lagos',
    refundMinor: 500000,
    currency: 'NGN',
  },
  bill_paid: {
    billerName: 'Ikeja Electric',
    customerRef: '45021873645',
    amountMinor: 500000,
    currency: 'NGN',
    token: '4821 9937 2210 6654 1203',
    units: '31.4 kWh',
    reference: 'WTX-BL55Z2',
  },
};
