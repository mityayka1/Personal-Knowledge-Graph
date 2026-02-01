import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramAuthGuard } from './guards/telegram-auth.guard';
import { MiniAppMapperService } from './services/mini-app-mapper.service';
import { MiniAppUserController } from './controllers/mini-app-user.controller';
import { MiniAppBriefController } from './controllers/mini-app-brief.controller';
import { MiniAppExtractionController } from './controllers/mini-app-extraction.controller';
import { MiniAppRecallController } from './controllers/mini-app-recall.controller';
import { MiniAppEntityController } from './controllers/mini-app-entity.controller';
import { MiniAppApprovalController } from './controllers/mini-app-approval.controller';
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
 * - REST endpoints for Mini App frontend (split by domain)
 *
 * Controllers:
 * - MiniAppUserController: /me, /dashboard
 * - MiniAppBriefController: /brief/*
 * - MiniAppExtractionController: /extraction/*
 * - MiniAppRecallController: /recall/*
 * - MiniAppEntityController: /entity/*
 * - MiniAppApprovalController: /pending-approval/*
 *
 * Dependencies:
 * - EntityModule for entity profiles
 * - ExtractionModule for carousel state
 * - ClaudeAgentModule for recall sessions
 * - PendingApprovalModule for pending approvals
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
  controllers: [
    MiniAppUserController,
    MiniAppBriefController,
    MiniAppExtractionController,
    MiniAppRecallController,
    MiniAppEntityController,
    MiniAppApprovalController,
  ],
  providers: [TelegramAuthGuard, MiniAppMapperService],
  exports: [TelegramAuthGuard],
})
export class TelegramMiniAppModule {}
