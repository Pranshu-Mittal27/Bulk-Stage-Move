import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { BulkStageMovesController } from './bulk-stage-moves.controller.js';
import { BulkStageMovesService } from './bulk-stage-moves.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [BulkStageMovesController],
  providers: [BulkStageMovesService],
})
export class BulkStageMovesModule {}
