import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, errors as joseErrors, type JWTPayload, jwtVerify } from 'jose';

import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Problems } from '../common/problem.js';

export interface VerifiedToken {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** Authentication methods references (RFC 8176), e.g. ["pwd", "mfa"]. */
  amr: readonly string[];
  /** Seconds since epoch when the user last authenticated, if the IdP sends it. */
  authTime: number | null;
}

const ALLOWED_ALGORITHMS = ['RS256', 'ES256'];
const CLOCK_TOLERANCE_SECONDS = 60;

/** Verifies IdP access tokens locally against the IdP's JWKS (ADR-001 §2). */
@Injectable()
export class TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.OIDC_JWKS_URL), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 5_000,
    });
  }

  async verify(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.OIDC_ISSUER,
        audience: this.config.OIDC_AUDIENCE,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw Problems.unauthenticated('The access token has expired.');
      if (error instanceof joseErrors.JOSEError) throw Problems.unauthenticated('The access token is not valid.');
      throw error;
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255) {
      throw Problems.unauthenticated('The access token has no valid subject.');
    }

    const email = typeof payload['email'] === 'string' ? payload['email'] : null;
    const amr = Array.isArray(payload['amr'])
      ? payload['amr'].filter((value): value is string => typeof value === 'string')
      : [];
    const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : null;

    return {
      subject,
      email,
      emailVerified: payload['email_verified'] === true,
      amr,
      authTime,
    };
  }

  hasMfa(token: VerifiedToken): boolean {
    return token.amr.some((method) => this.config.OIDC_MFA_AMR_VALUES.includes(method));
  }

  /**
   * Step-up check for sensitive permissions: MFA and a recent authentication.
   * `maxAgeSeconds` tightens the window for particular actions (e.g. revealing protected data).
   */
  hasRecentMfa(token: VerifiedToken, now: Date = new Date(), maxAgeSeconds: number = this.config.STEP_UP_MAX_AGE_SECONDS): boolean {
    if (!this.hasMfa(token) || token.authTime === null) return false;
    const ageSeconds = now.getTime() / 1000 - token.authTime;
    return ageSeconds <= maxAgeSeconds;
  }
}
