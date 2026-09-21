import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  calculateJwkThumbprint,
  exportJWK,
  importSPKI,
  type JWK,
} from 'jose';
import { normalizePem } from '../common/pem.util';

export interface PublicJwk extends JWK {
  kid: string;
  use: 'sig';
  alg: 'RS256';
}

/**
 * Loads the RS256 public key from env and exposes it as a JWK (and the matching
 * `kid`). The `kid` is the RFC 7638 thumbprint so it is stable and identical to
 * the `kid` stamped on signed access tokens, letting verifiers match keys.
 */
@Injectable()
export class JwksService implements OnModuleInit {
  private jwk!: PublicJwk;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const pem = normalizePem(this.config.getOrThrow<string>('RS256_PUBLIC_KEY'));
    const key = await importSPKI(pem, 'RS256');
    const jwk = await exportJWK(key);
    const kid = await calculateJwkThumbprint(jwk);
    this.jwk = { ...jwk, kid, use: 'sig', alg: 'RS256' };
  }

  get kid(): string {
    return this.jwk.kid;
  }

  getJwks(): { keys: PublicJwk[] } {
    return { keys: [this.jwk] };
  }
}
