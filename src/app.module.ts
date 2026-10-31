import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { BulkStageMovesModule } from './bulk-stage-moves/bulk-stage-moves.module.js';
import { DatabaseModule } from './database/database.module.js';
import { OpportunitiesModule } from './opportunities/opportunities.module.js';

@Module({
  imports: [DatabaseModule, OpportunitiesModule, BulkStageMovesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
