import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  RELAY_ATTACHMENT_MAX_COUNT,
  RELAY_ATTACHMENT_TYPES,
} from '../mail-relay.config';

/**
 * One file on a relayed mail (WALLET-35). The name is a plain file name (no
 * path, no spaces, no line breaks: a name is how a header gets injected and a
 * path gets escaped), the content is base64, and the type is one of a short
 * list. The size is checked across all of a mail's files by the service.
 */
export class MailAttachmentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, {
    message: 'filename must be a plain file name of letters, numbers, . _ -',
  })
  filename!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(17 * 1024 * 1024)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'content must be base64' })
  content!: string;

  @IsOptional()
  @IsIn(RELAY_ATTACHMENT_TYPES)
  contentType?: string;
}

/**
 * The body of POST /internal/mail/send (EMAIL-02). There is no `from`: the
 * From line is always WAWU ID's own MAIL_FROM, so a caller (or a leaked
 * service key) cannot make a mail look like it came from somewhere else.
 *
 * The html and text limits sit under Nest's 100 kb JSON body limit on purpose,
 * so an over-long mail is a plain 400 from here and not a 413.
 */
export class SendMailDto {
  @IsEmail()
  @MaxLength(254)
  to!: string;

  /** One line: a line break in a subject is how a header gets injected. */
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  @Matches(/^[^\r\n]*$/, { message: 'subject must be one line' })
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80_000)
  html!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40_000)
  text!: string;

  /** Only List-Unsubscribe and List-Unsubscribe-Post (checked by the service). */
  @IsOptional()
  @IsObject()
  @Type(() => Object)
  headers?: Record<string, unknown>;

  /** The campaign id, kept on the provider's record of the mail. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,256}$/, {
    message: 'tag may hold letters, numbers, underscores and dashes only',
  })
  tag?: string;

  /**
   * Files that travel with the mail (a wallet statement's CSV). Left out is
   * fine; sent as null is a bad body (400, nothing mailed): a caller that
   * means to attach a file and sends null has a bug, and a mail without its
   * file is the wrong mail. (@IsOptional would have let null through.)
   */
  @ValidateIf((o: SendMailDto) => o.attachments !== undefined)
  @IsArray()
  @ArrayMaxSize(RELAY_ATTACHMENT_MAX_COUNT)
  @ValidateNested({ each: true })
  @Type(() => MailAttachmentDto)
  attachments?: MailAttachmentDto[];
}
