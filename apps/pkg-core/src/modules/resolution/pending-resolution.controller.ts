import { Controller, Get, Post, Patch, Param, Query, Body, ParseUUIDPipe } from '@nestjs/common';
import { PendingResolutionService } from './pending-resolution.service';
import { ResolutionStatus } from '@pkg/entities';

@Controller('pending-resolutions')
export class PendingResolutionController {
  constructor(private resolutionService: PendingResolutionService) {}

  @Get()
  async findAll(
    @Query('status') status?: ResolutionStatus,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.resolutionService.findAll(status, limit, offset);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.resolutionService.findOne(id);
  }

  @Patch(':id/suggestions')
  async updateSuggestions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      suggestions: Array<{
        entity_id: string;
        name: string;
        confidence: number;
        reason: string;
      }>;
    },
  ) {
    return this.resolutionService.updateSuggestions(id, body.suggestions);
  }

  @Post(':id/resolve')
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { entity_id: string },
  ) {
    return this.resolutionService.resolve(id, body.entity_id);
  }

  @Post(':id/ignore')
  async ignore(@Param('id', ParseUUIDPipe) id: string) {
    return this.resolutionService.ignore(id);
  }
}
