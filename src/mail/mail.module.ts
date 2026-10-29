import { Module } from '@nestjs/common';
import { EmailHeaderController } from './email-header.controller';
import { MailRelayController } from './mail-relay.controller';
import { MailRelayService } from './mail-relay.service';
import { MailService } from './mail.service';
import { ServiceKeyGuard } from './service-key.guard';

@Module({
  controllers: [MailRelayController, EmailHeaderController],
  providers: [MailService, MailRelayService, ServiceKeyGuard],
  exports: [MailService],
})
export class MailModule {}
