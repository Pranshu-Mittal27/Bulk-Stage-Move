import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { OpportunitiesModule } from './opportunities/opportunities.module.js';

@Module({
  imports: [DatabaseModule, OpportunitiesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
