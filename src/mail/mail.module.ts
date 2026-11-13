import { Module } from '@nestjs/common';
import { MailAudienceController } from './mail-audience.controller';
import { MailAudienceService } from './mail-audience.service';
import { EmailHeaderController } from './email-header.controller';
import { MailRelayController } from './mail-relay.controller';
import { MailRelayService } from './mail-relay.service';
import { MailService } from './mail.service';
import { ServiceKeyGuard } from './service-key.guard';

@Module({
  controllers: [
    MailRelayController,
    EmailHeaderController,
    MailAudienceController,
  ],
  providers: [
    MailService,
    MailRelayService,
    MailAudienceService,
    ServiceKeyGuard,
  ],
  exports: [MailService],
})
export class MailModule {}
