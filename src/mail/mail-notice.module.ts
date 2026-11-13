import { Module } from '@nestjs/common';
import { MailAudienceController } from './mail-audience.controller';
import { MailAudienceService } from './mail-audience.service';
import { MailNoticeController } from './mail-notice.controller';
import { MailNoticeService } from './mail-notice.service';
import { MailModule } from './mail.module';
import { ServiceKeyGuard } from './service-key.guard';

/**
 * POST /internal/mail/notice (EMAIL-01) and GET /internal/mail/audience
 * (EMAIL-ID-AUD). Its own module, because it reads the
 * database (PrismaService, global in the app) and MailModule does not.
 */
@Module({
  imports: [MailModule],
  controllers: [MailNoticeController, MailAudienceController],
  providers: [MailNoticeService, MailAudienceService, ServiceKeyGuard],
})
export class MailNoticeModule {}
