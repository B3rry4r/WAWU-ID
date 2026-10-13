import { Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
}
