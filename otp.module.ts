import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { OtpService } from './otp.service';

@Module({
  imports: [MailModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
