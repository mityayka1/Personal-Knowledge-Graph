import { Controller, Get, Put, Post, Param, Query, Body, NotFoundException } from '@nestjs/common';
import { ChatCategoryService } from './chat-category.service';
import { ChatCategory } from '@pkg/entities';
import { UpdateChatCategoryDto } from './dto/update-chat-category.dto';

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

  /**
   * Backfill chat titles and participants from Telegram
   * POST /chat-categories/backfill
   */
  @Post('backfill')
  async backfill(
    @Query('onlyMissingTitles') onlyMissingTitles?: string,
    @Query('limit') limit?: number,
  ) {
    return this.chatCategoryService.backfillChatsFromTelegram({
      onlyMissingTitles: onlyMissingTitles !== 'false',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':telegramChatId')
  async findOne(@Param('telegramChatId') telegramChatId: string) {
    const result = await this.chatCategoryService.getCategory(telegramChatId);
    if (!result) {
      return { found: false, telegramChatId };
    }
    return result;
  }

  @Put(':telegramChatId')
  async updateCategory(
    @Param('telegramChatId') telegramChatId: string,
    @Body() dto: UpdateChatCategoryDto,
  ) {
    return this.chatCategoryService.updateCategory(telegramChatId, dto.category);
  }

  /**
   * Refresh single chat info from Telegram
   * POST /chat-categories/:telegramChatId/refresh
   */
  @Post(':telegramChatId/refresh')
  async refreshChat(@Param('telegramChatId') telegramChatId: string) {
    const result = await this.chatCategoryService.updateChatFromTelegram(telegramChatId);
    if (!result) {
      throw new NotFoundException(`Chat not found: ${telegramChatId}`);
    }
    return result;
  }

  /**
   * Reset manual override flag to allow automatic categorization again
   * DELETE /chat-categories/:telegramChatId/manual-override
   */
  @Post(':telegramChatId/reset-override')
  async resetManualOverride(@Param('telegramChatId') telegramChatId: string) {
    const result = await this.chatCategoryService.resetManualOverride(telegramChatId);
    if (!result) {
      throw new NotFoundException(`Chat not found: ${telegramChatId}`);
    }
    return result;
  }
}
