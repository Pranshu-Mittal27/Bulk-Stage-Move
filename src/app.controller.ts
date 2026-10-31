import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service.js';

@ApiTags('starter')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Confirm the starter API is running' })
  @ApiResponse({ status: 200, description: 'The service is running.' })
  getStatus(): string {
    return this.appService.getStatus();
  }
}
