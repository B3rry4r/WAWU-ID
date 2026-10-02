import { Module } from '@nestjs/common';
import { FintavaSmsProvider } from './fintava-sms.provider';
import { SMS_PROVIDER } from './sms.provider';

@Module({
  providers: [
    FintavaSmsProvider,
    { provide: SMS_PROVIDER, useExisting: FintavaSmsProvider },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}
