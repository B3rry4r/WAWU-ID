import { Controller, Get } from '@nestjs/common';
import { JwksService, type PublicJwk } from './jwks.service';

@Controller('.well-known')
export class JwksController {
  constructor(private readonly jwks: JwksService) {}

  @Get('jwks.json')
  getJwks(): { keys: PublicJwk[] } {
    return this.jwks.getJwks();
  }
}
