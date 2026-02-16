import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Activity, ActivityMember, Commitment, EntityRecord } from '@pkg/entities';
import { ActivityService } from './activity.service';
import { ActivityMemberService } from './activity-member.service';
import { ActivityValidationService } from './activity-validation.service';
import { CommitmentService } from './commitment.service';
import { ActivityController } from './activity.controller';
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';
import { ActivityToolsProvider } from '../claude-agent/tools';

/**
 * ActivityModule — модуль для управления активностями.
 *
 * Активности представляют иерархию дел:
 * - Areas (Работа, Семья, Здоровье)
 * - Businesses (организации)
 * - Directions (направления)
 * - Projects (проекты)
 * - Tasks (задачи)
 *
 * Использует closure-table для эффективных иерархических запросов.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Activity, ActivityMember, Commitment, EntityRecord]),
    ClaudeAgentCoreModule,
  ],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityMemberService, ActivityValidationService, CommitmentService, ActivityToolsProvider],
  exports: [ActivityService, ActivityMemberService, ActivityValidationService, CommitmentService, ActivityToolsProvider],
})
export class ActivityModule {}
