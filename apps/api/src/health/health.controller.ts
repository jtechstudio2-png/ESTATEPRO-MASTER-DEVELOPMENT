import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators.js';
import { DatabaseHealth } from '../database/database.module.js';

class HealthResponse {
  status!: 'ok';
  database!: 'ok';
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseHealth) {}

  @Public()
  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: HealthResponse })
  async health(): Promise<HealthResponse> {
    if (!(await this.database.check())) throw new ServiceUnavailableException();
    return { status: 'ok', database: 'ok' };
  }
}
