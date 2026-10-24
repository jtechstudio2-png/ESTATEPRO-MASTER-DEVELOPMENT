import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';

import { CurrentUser, NoCompanyContext } from '../auth/decorators.js';
import { IdentityService } from '../auth/identity.service.js';
import type { AuthenticatedUser } from '../common/request-context.js';

class MembershipSummaryDto {
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty({ format: 'uuid' }) companyId!: string;
  @ApiProperty() companyName!: string;
  @ApiProperty({ enum: ['trial', 'active', 'past_due', 'read_only', 'suspended', 'cancelled'] }) companyStatus!: string;
  @ApiProperty() roleKey!: string;
  @ApiProperty() roleName!: string;
  @ApiProperty({ enum: ['staff', 'portal'] }) membershipType!: string;
}

class MeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: [MembershipSummaryDto] }) memberships!: MembershipSummaryDto[];
}

@ApiTags('Me')
@ApiBearerAuth()
@Controller('api/v1/me')
export class MeController {
  constructor(private readonly identity: IdentityService) {}

  /** The signed-in user and the companies they can work in. */
  @NoCompanyContext()
  @Get()
  @ApiOkResponse({ type: MeDto })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeDto> {
    return { ...user, memberships: await this.identity.listMemberships(user.id) };
  }
}
