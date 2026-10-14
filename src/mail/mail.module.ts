import { Module } from '@nestjs/common';
import { MailRelayController } from './mail-relay.controller';
import { MailRelayService } from './mail-relay.service';
import { MailService } from './mail.service';
import { ServiceKeyGuard } from './service-key.guard';

@Module({
  controllers: [MailRelayController],
  providers: [MailService, MailRelayService, ServiceKeyGuard],
  exports: [MailService],
})
export class MailModule {}
