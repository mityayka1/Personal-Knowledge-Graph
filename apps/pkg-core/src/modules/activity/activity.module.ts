import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Activity, ActivityMember, Commitment } from '@pkg/entities';
import { ActivityService } from './activity.service';
import { CommitmentService } from './commitment.service';

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
    TypeOrmModule.forFeature([Activity, ActivityMember, Commitment]),
  ],
  providers: [ActivityService, CommitmentService],
  exports: [ActivityService, CommitmentService],
})
export class ActivityModule {}
