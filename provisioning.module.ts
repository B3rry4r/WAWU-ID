import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { PoliciesModule } from '../policies/policies.module';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';

@Module({
  // AuthModule exports TokensService; MailModule exports MailService;
  // PoliciesModule exports PoliciesService. PrismaService is global.
  imports: [AuthModule, MailModule, PoliciesModule],
  controllers: [ProvisioningController],
  providers: [ProvisioningService],
})
export class ProvisioningModule {}
