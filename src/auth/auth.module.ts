import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { normalizePem } from '../common/pem.util';
import { JwksModule } from '../jwks/jwks.module';
import { MailModule } from '../mail/mail.module';
import { OtpModule } from '../otp/otp.module';
import { SmsModule } from '../sms/sms.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';
import { PhoneSignupService } from './phone-signup.service';
import { DbRateLimiter, RateLimiter } from './rate-limiter.service';
import { SessionReader } from './session-reader';
import { SessionSecurityService } from './session-security.service';
import { SignupSequenceController } from './signup-sequence.controller';
import { SignupSequenceService } from './signup-sequence.service';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    JwksModule,
    OtpModule,
    MailModule,
    SmsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        privateKey: normalizePem(config.getOrThrow<string>('RS256_PRIVATE_KEY')),
        publicKey: normalizePem(config.getOrThrow<string>('RS256_PUBLIC_KEY')),
        signOptions: { algorithm: 'RS256' },
        verifyOptions: { algorithms: ['RS256'] },
      }),
    }),
  ],
  controllers: [AuthController, SignupSequenceController, InternalController],
  providers: [
    AuthService,
    TokensService,
    PhoneSignupService,
    SignupSequenceService,
    SessionReader,
    SessionSecurityService,
    { provide: RateLimiter, useClass: DbRateLimiter },
  ],
  exports: [TokensService],
})
export class AuthModule {}
