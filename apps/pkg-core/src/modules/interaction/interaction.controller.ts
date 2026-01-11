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

  @Get('by-identifier')
  async findByIdentifier(
    @Query('type') identifierType: string,
    @Query('value') identifierValue: string,
    @Query('limit') limit?: number,
  ) {
    return this.interactionService.findByIdentifier(identifierType, identifierValue, limit);
  }

  /**
   * Get statistics for all Telegram chats (for import optimization).
   * Returns list of chats with last message info and message count.
   */
  @Get('chat-stats')
  async getChatStats() {
    return this.interactionService.getChatStats();
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
