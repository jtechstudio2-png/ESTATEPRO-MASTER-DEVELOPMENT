import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Scope, Tenant } from '../auth/decorators.js';
import { TokenVerifier } from '../auth/token-verifier.service.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, PermissionScope, TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { RevealableContactField } from '../crypto/sensitive-fields.js';
import { TenantDb } from '../database/database.module.js';
import { REVEAL_DISPLAY_SECONDS, REVEALABLE_FIELDS, RevealBody, RevealedValueDto } from './sensitive.dto.js';
import { ContactSensitiveService, type RevealRequest } from './sensitive.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/**
 * Revealing protected contact details (ADR-007 §9, wireframe C-5). Requires
 * contact.view_sensitive, a second-factor sign-in within the reveal window and
 * a reason. Responses are never cached.
 */
@ApiTags('Contacts: protected details')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/contacts/:contactId')
export class ContactSensitiveController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly service: ContactSensitiveService,
    private readonly verifier: TokenVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('sensitive/:field/reveal')
  @HttpCode(200)
  @RequirePermission('contact.view_sensitive')
  @ApiOperation({ summary: 'Reveal one protected detail of a contact (audited)' })
  @ApiParam({ name: 'field', enum: REVEALABLE_FIELDS })
  @ApiOkResponse({ type: RevealedValueDto })
  async revealField(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Req() req: EstateProRequest,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('field') field: string,
    @Body() body: RevealBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevealedValueDto> {
    if (!(REVEALABLE_FIELDS as string[]).includes(field)) throw Problems.notFound();
    const request = this.revealRequest(req, scope, body);
    noStore(res);
    const value = await this.tenantDb.run(ctx, (tx) =>
      this.service.revealContactField(tx, ctx, contactId, field as RevealableContactField, request),
    );
    return { field, value, revealedAt: new Date().toISOString(), hideAfterSeconds: REVEAL_DISPLAY_SECONDS };
  }

  @Post('identity-documents/:documentId/reveal')
  @HttpCode(200)
  @RequirePermission('contact.view_sensitive')
  @ApiOperation({ summary: 'Reveal the number of an identity document (audited)' })
  @ApiOkResponse({ type: RevealedValueDto })
  async revealDocumentNumber(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Req() req: EstateProRequest,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('documentId', UUID_PARAM) documentId: string,
    @Body() body: RevealBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevealedValueDto> {
    const request = this.revealRequest(req, scope, body);
    noStore(res);
    const value = await this.tenantDb.run(ctx, (tx) => this.service.revealIdentityDocumentNumber(tx, ctx, contactId, documentId, request));
    return { field: 'documentNumber', value, revealedAt: new Date().toISOString(), hideAfterSeconds: REVEAL_DISPLAY_SECONDS };
  }

  /** The guard already required a recent second factor; revealing needs a tighter window. */
  private revealRequest(req: EstateProRequest, scope: PermissionScope, body: RevealBody): RevealRequest {
    const token = req.auth?.token;
    if (!token || token.authTime === null || !this.verifier.hasRecentMfa(token, new Date(), this.config.REVEAL_STEP_UP_MAX_AGE_SECONDS)) {
      throw Problems.mfaRequired('Revealing protected details needs a second-factor sign-in within the last few minutes. Sign in again and retry.');
    }
    return { scope, reason: body.reason, stepUpAt: new Date(token.authTime * 1000) };
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}
