import { Module } from '@nestjs/common';

import { ListingsModule } from '../listings/listings.module.js';
import { ContextController } from './context.controller.js';
import { PropertyDashboardController } from './dashboard.controller.js';
import { MembersController } from './members.controller.js';
import { ReferenceController } from './reference.controller.js';
import { SearchController } from './search.controller.js';

/** Read endpoints that support the web interface (M6 API gaps A-1, A-2, A-5, A-6, A-9). */
@Module({
  imports: [ListingsModule],
  controllers: [ContextController, MembersController, SearchController, ReferenceController, PropertyDashboardController],
})
export class WorkspaceModule {}
