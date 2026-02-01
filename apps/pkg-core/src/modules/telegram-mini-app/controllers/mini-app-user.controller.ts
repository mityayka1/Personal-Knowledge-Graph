import { Controller, Get, UseGuards, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { PendingApprovalService } from '../../pending-approval/pending-approval.service';
import { PendingApprovalStatus } from '@pkg/entities';
import { MiniAppMapperService } from '../services/mini-app-mapper.service';

/**
 * Mini App User & Dashboard Controller.
 * Handles: /me, /dashboard
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppUserController {
  private readonly logger = new Logger(MiniAppUserController.name);
  private readonly ownerTelegramId: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly pendingApprovalService: PendingApprovalService,
    private readonly mapper: MiniAppMapperService,
  ) {
    this.ownerTelegramId = this.configService.get<number>('OWNER_TELEGRAM_ID', 0);
  }

  /**
   * GET /api/mini-app/me
   * Returns current user info and owner status.
   */
  @Get('me')
  async getMe(@TgUser() user: TelegramUser) {
    this.logger.debug(`getMe for user ${user?.id}`);

    return {
      user: user
        ? {
            id: user.id,
            firstName: user.first_name,
            lastName: user.last_name,
            username: user.username,
          }
        : null,
      isOwner: user?.id === this.ownerTelegramId,
    };
  }

  /**
   * GET /api/mini-app/dashboard
   * Returns dashboard data: pending actions, today's brief, recent activity.
   */
  @Get('dashboard')
  async getDashboard(@TgUser() user: TelegramUser) {
    this.logger.debug(`getDashboard for user ${user?.id}`);

    const { total } = await this.pendingApprovalService.list({
      status: PendingApprovalStatus.PENDING,
      limit: 1,
    });

    const pendingActions =
      total > 0
        ? [
            {
              type: 'approval' as const,
              id: 'all',
              count: total,
            },
          ]
        : [];

    return {
      pendingActions,
      todayBrief: null,
      recentActivity: [],
    };
  }
}
