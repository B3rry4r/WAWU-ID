import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { normalizePem } from '../common/pem.util';
import { JwksModule } from '../jwks/jwks.module';
import { MailModule } from '../mail/mail.module';
import { OtpModule } from '../otp/otp.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    JwksModule,
    OtpModule,
    MailModule,
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
  controllers: [AuthController, InternalController],
  providers: [AuthService, TokensService],
  exports: [TokensService],
})
export class AuthModule {}
