import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  Logger,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { BriefItemActionDto } from '../dto/mini-app.dto';

/**
 * Mini App Brief Controller.
 * Handles: /brief/:id, /brief/:id/item/:idx/action
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppBriefController {
  private readonly logger = new Logger(MiniAppBriefController.name);

  /**
   * GET /api/mini-app/brief/:id
   * Returns brief details with items.
   */
  @Get('brief/:id')
  async getBrief(
    @Param('id', ParseUUIDPipe) briefId: string,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`getBrief ${briefId} for user ${user?.id}`);

    // Brief functionality not yet implemented
    throw new NotFoundException('Brief not found');
  }

  /**
   * POST /api/mini-app/brief/:id/item/:idx/action
   * Perform action on a brief item (done, remind, write, prepare).
   */
  @Post('brief/:id/item/:idx/action')
  async briefItemAction(
    @Param('id', ParseUUIDPipe) briefId: string,
    @Param('idx') itemIdx: string,
    @Body() dto: BriefItemActionDto,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(
      `briefItemAction ${briefId}/${itemIdx} action=${dto.action} for user ${user?.id}`,
    );

    // Brief functionality not yet implemented
    return { success: true };
  }
}
