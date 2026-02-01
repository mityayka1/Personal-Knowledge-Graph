import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { RecallSessionService } from '../../claude-agent/recall-session.service';

/**
 * Mini App Recall Session Controller.
 * Handles: /recall/:sessionId
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppRecallController {
  private readonly logger = new Logger(MiniAppRecallController.name);

  constructor(private readonly recallSessionService: RecallSessionService) {}

  /**
   * GET /api/mini-app/recall/:sessionId
   * Returns recall session results.
   */
  @Get('recall/:sessionId')
  async getRecall(
    @Param('sessionId') sessionId: string,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`getRecall ${sessionId} for user ${user?.id}`);

    const session = await this.recallSessionService.get(sessionId);
    if (!session) {
      throw new NotFoundException('Recall session not found or expired');
    }

    // Verify user has access to this session (IDOR prevention)
    const hasAccess = await this.recallSessionService.verifyUser(
      sessionId,
      String(user.id),
    );
    if (!hasAccess) {
      this.logger.warn(
        `User ${user.id} attempted to access session ${sessionId} owned by ${session.userId}`,
      );
      throw new NotFoundException('Recall session not found or expired');
    }

    return {
      id: session.id,
      query: session.query,
      answer: session.answer,
      sources: session.sources.map((s) => ({
        id: s.id,
        type: s.type,
        preview: s.preview,
      })),
      createdAt: new Date(session.createdAt).toISOString(),
    };
  }
}
