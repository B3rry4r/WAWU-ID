import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailNoticeDto } from './dto/mail-notice.dto';
import { MailRelayError, MailService } from './mail.service';
import { parseNotice, type NoticeKind } from './notice/notice-kinds';
import { noticeContent } from './notice/notice-words';
import { ownProvenEmail, provenEmail } from './proven-email';

/** What POST /internal/mail/notice answers (200). */
export type NoticeAnswer =
  | { sent: true }
  | { sent: false; replayed: true }
  | { sent: false; reason: 'no_email' };

/**
 * A claim is left alone this long. A claim older than this is a server that
 * died between claiming and answering, and the next call takes it over; the
 * provider's own idempotency key (held for a day) keeps that from sending twice.
 */
export const NOTICE_CLAIM_LIFE_MS = 2 * 60 * 1000;

/**
 * The two mails about a deletion go to a person whose account is in its 30 days
 * of deletion (R-17): that is exactly who they are for. Every other notice
 * follows the rule for all mail a service sends on its own, and skips an
 * account that is being deleted or is gone.
 */
const DELETION_KINDS: ReadonlySet<NoticeKind> = new Set([
  'account_deletion_started',
  'account_deleted',
]);

/**
 * POST /internal/mail/notice (EMAIL-01). The Hub names a person and a kind of
 * notice with its facts; this service finds the person's proven address (the
 * Hub never holds or sends one), writes the mail in its own layout and words,
 * and sends it once per idempotency key.
 *
 *   400  an unknown kind, or data that does not fit its kind (nothing touched)
 *   200 { sent: true }                     the provider took the mail
 *   200 { sent: false, replayed: true }    this key was already sent, or is being sent
 *   200 { sent: false, reason: 'no_email' } the person has no proven address (or the
 *                                           provider says the address cannot be mailed);
 *                                           nothing was claimed, so the key still works
 *   409  the key was used before for another person or another kind
 *   502  the provider refused the mail    503  try again (busy, unreachable, no key set)
 *
 * No lock and no transaction is held across the provider call: the claim is one
 * insert, the send holds nothing, the record is one update.
 */
@Injectable()
export class MailNoticeService {
  private readonly logger = new Logger(MailNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async send(dto: MailNoticeDto): Promise<NoticeAnswer> {
    const notice = parseNotice(dto.kind, dto.data);

    const user = await this.prisma.wawuUser.findUnique({
      where: { id: dto.wawuId },
      select: {
        id: true,
        email: true,
        firstName: true,
        emailVerified: true,
        phoneVerifiedAt: true,
        status: true,
        deletedAt: true,
      },
    });
    const to = user
      ? DELETION_KINDS.has(notice.kind)
        ? ownProvenEmail(user)
        : provenEmail(user)
      : null;
    if (!user || !to) return { sent: false, reason: 'no_email' };

    if (!(await this.claim(dto.idempotencyKey, user.id, notice.kind))) {
      return { sent: false, replayed: true };
    }

    const content = noticeContent(notice);
    const { html, text } = this.mail.renderNotice(content, user.firstName);
    let providerId: string;
    try {
      ({ id: providerId } = await this.mail.sendRelayed({
        to,
        subject: content.subject,
        html,
        text,
        idempotencyKey: `notice-${dto.idempotencyKey}`,
      }));
    } catch (err) {
      // Not sent: give the key back so the Hub's retry sends.
      await this.release(dto.idempotencyKey);
      if (!(err instanceof MailRelayError)) throw err;
      this.logger.warn(`Notice ${notice.kind} not sent: ${err.kind}`);
      switch (err.kind) {
        case 'invalid_address':
          // The provider cannot mail the address on file: for this send, a
          // person with no address to mail.
          return { sent: false, reason: 'no_email' };
        case 'refused':
          throw new BadGatewayException(err.message);
        default:
          // not_configured and unavailable: nothing was sent, try again later.
          throw new ServiceUnavailableException(err.message);
      }
    }

    try {
      await this.prisma.mailNotice.updateMany({
        where: { idempotencyKey: dto.idempotencyKey },
        data: { status: 'sent', sentAt: new Date(), providerId },
      });
    } catch {
      // The mail is out. A row left at `sending` is taken over after its life,
      // and the provider answers that repeat with this send.
      this.logger.warn(`Notice ${notice.kind} sent; its row was not updated`);
    }
    return { sent: true };
  }

  /**
   * Take the key. True: this call sends. False: another call has it or has
   * sent it. Throws 409 for a key that was used for something else.
   */
  private async claim(
    key: string,
    userId: string,
    kind: NoticeKind,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      const made = await this.prisma.mailNotice.createMany({
        data: [
          {
            idempotencyKey: key,
            userId,
            kind,
            status: 'sending',
            claimedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (made.count === 1) return true;

      const row = await this.prisma.mailNotice.findUnique({
        where: { idempotencyKey: key },
      });
      // Given back by a call that failed, between our insert and our read.
      if (!row) continue;
      if (row.userId !== userId || row.kind !== kind) {
        throw new ConflictException({
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'This idempotencyKey was already used for another person or another kind of notice.',
        });
      }
      if (
        row.status === 'sending' &&
        now.getTime() - row.claimedAt.getTime() > NOTICE_CLAIM_LIFE_MS
      ) {
        const took = await this.prisma.mailNotice.updateMany({
          where: {
            idempotencyKey: key,
            status: 'sending',
            claimedAt: row.claimedAt,
          },
          data: { claimedAt: now },
        });
        return took.count === 1;
      }
      return false;
    }
    // The key kept appearing and vanishing: another call is working on it.
    return false;
  }

  private async release(key: string): Promise<void> {
    try {
      await this.prisma.mailNotice.deleteMany({
        where: { idempotencyKey: key, status: 'sending' },
      });
    } catch {
      // The row stays `sending` and is taken over after its life.
      this.logger.warn('A notice claim could not be given back');
    }
  }
}
