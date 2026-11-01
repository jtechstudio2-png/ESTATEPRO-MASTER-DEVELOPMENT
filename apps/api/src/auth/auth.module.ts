import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './auth.guard.js';
import { IdentityService } from './identity.service.js';
import { TokenVerifier } from './token-verifier.service.js';

@Module({
  providers: [TokenVerifier, IdentityService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [IdentityService, TokenVerifier],
})
export class AuthModule {}
