import { Controller, Post, Body, Get, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { MessageService } from './message.service';
import { CreateMessageDto } from '../dto/create-message.dto';

@Controller('messages')
export class MessageController {
  constructor(private messageService: MessageService) {}

  @Post()
  async create(@Body() dto: CreateMessageDto) {
    return this.messageService.create(dto);
  }

  @Get('interaction/:interactionId')
  async findByInteraction(
    @Param('interactionId', ParseUUIDPipe) interactionId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.messageService.findByInteraction(interactionId, limit, offset);
  }

  /**
   * Get messages by Telegram chat ID
   * GET /messages/chat/:telegramChatId
   */
  @Get('chat/:telegramChatId')
  async findByTelegramChatId(
    @Param('telegramChatId') telegramChatId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('order') order?: 'ASC' | 'DESC',
  ) {
    return this.messageService.findByTelegramChatIdWithSenders(telegramChatId, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order,
    });
  }
}
