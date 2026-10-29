import {
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * The body of POST /internal/mail/notice (EMAIL-01). The Hub names the person
 * (`wawuId`), the kind of notice and the facts; this service finds the address,
 * writes the words and sends the mail once per `idempotencyKey`. There is no
 * `to`, no `from`, no subject and no html: a caller (or a leaked service key)
 * cannot make this route mail arbitrary text to an arbitrary address.
 *
 * `kind` and `data` are checked together by `parseNotice`, so one place says
 * which kinds exist and what each takes.
 */
export class MailNoticeDto {
  @IsUUID()
  wawuId!: string;

  @IsString()
  @MaxLength(40)
  kind!: string;

  @IsObject()
  data!: Record<string, unknown>;

  /** 8 to 128 letters, numbers, dash and underscore: the Hub's own id of this send. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/, {
    message:
      'idempotencyKey must be 8 to 128 letters, numbers, dashes or underscores',
  })
  idempotencyKey!: string;
}
