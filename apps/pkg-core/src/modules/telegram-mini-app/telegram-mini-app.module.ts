import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramMiniAppController } from './controllers/telegram-mini-app.controller';
import { TelegramAuthGuard } from './guards/telegram-auth.guard';
import { EntityModule } from '../entity/entity.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { PendingApprovalModule } from '../pending-approval/pending-approval.module';
import { ActivityModule } from '../activity/activity.module';

/**
 * Module for Telegram Mini App API.
 *
 * Provides:
 * - TelegramAuthGuard for initData validation
 * - REST endpoints for Mini App frontend
 *
 * Dependencies:
 * - EntityModule for entity profiles
 * - ExtractionModule for carousel state
 * - ClaudeAgentModule for recall sessions
 * - PendingApprovalModule for pending approvals on dashboard
 * - ActivityModule for commitment details
 */
@Module({
  imports: [
    ConfigModule,
    EntityModule,
    ExtractionModule,
    ClaudeAgentModule,
    PendingApprovalModule,
    ActivityModule,
  ],
  controllers: [TelegramMiniAppController],
  providers: [TelegramAuthGuard],
  exports: [TelegramAuthGuard],
})
export class TelegramMiniAppModule {}
