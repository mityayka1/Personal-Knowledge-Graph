import { Controller, Get, Patch, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { PendingFactService } from './pending-fact.service';
import { PendingFactStatus } from '@pkg/entities';

@Controller('pending-facts')
export class PendingFactController {
  constructor(private pendingFactService: PendingFactService) {}

  @Get()
  async findAll(
    @Query('status') status?: PendingFactStatus,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.pendingFactService.findAll(status, limit, offset);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.pendingFactService.findOne(id);
  }

  @Patch(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.pendingFactService.approve(id);
  }

  @Patch(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string) {
    return this.pendingFactService.reject(id);
  }
}
