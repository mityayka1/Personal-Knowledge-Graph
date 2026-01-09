import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { InteractionService } from './interaction.service';

@Controller('interactions')
export class InteractionController {
  constructor(private interactionService: InteractionService) {}

  @Get()
  async findAll(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.interactionService.findAll({ limit, offset });
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.interactionService.findOne(id);
  }

  @Post(':id/end')
  async endSession(@Param('id', ParseUUIDPipe) id: string) {
    return this.interactionService.endSession(id);
  }
}
