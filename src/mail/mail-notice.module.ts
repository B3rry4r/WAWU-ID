import { Module } from '@nestjs/common';
import { MailNoticeController } from './mail-notice.controller';
import { MailNoticeService } from './mail-notice.service';
import { MailModule } from './mail.module';
import { ServiceKeyGuard } from './service-key.guard';

/**
 * POST /internal/mail/notice (EMAIL-01). Its own module, because it reads the
 * database (PrismaService, global in the app) and MailModule does not.
 */
@Module({
  imports: [MailModule],
  controllers: [MailNoticeController],
  providers: [MailNoticeService, ServiceKeyGuard],
})
export class MailNoticeModule {}
