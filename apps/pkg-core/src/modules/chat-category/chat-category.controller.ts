import { Controller, Get, Param, Query } from '@nestjs/common';
import { ChatCategoryService } from './chat-category.service';
import { ChatCategory } from '@pkg/entities';

@Controller('chat-categories')
export class ChatCategoryController {
  constructor(private readonly chatCategoryService: ChatCategoryService) {}

  @Get()
  async findAll(
    @Query('category') category?: ChatCategory,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.chatCategoryService.findAll({
      category,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('stats')
  async getStats() {
    return this.chatCategoryService.getStats();
  }

  @Get(':telegramChatId')
  async findOne(@Param('telegramChatId') telegramChatId: string) {
    const result = await this.chatCategoryService.getCategory(telegramChatId);
    if (!result) {
      return { found: false, telegramChatId };
    }
    return result;
  }
}
