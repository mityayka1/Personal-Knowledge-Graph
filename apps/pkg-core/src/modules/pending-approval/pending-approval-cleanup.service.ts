import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource, Repository, In, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
} from '@pkg/entities';
import {
  hardDeleteTargets,
  getUniqueTableConfigs,
} from './item-type-registry';

/**
 * Service for periodic cleanup of rejected pending approvals and orphaned drafts.
 *
 * Runs daily at 3:00 AM to:
 * 1. Hard-delete rejected items (PendingApproval + target entities) older than retention period
 * 2. Hard-delete orphaned draft entities that have no associated PendingApproval record
 */
@Injectable()
export class PendingApprovalCleanupService {
  private readonly logger = new Logger(PendingApprovalCleanupService.name);
  private readonly retentionDays: number;
  private readonly batchSize = 100;

  constructor(
    @InjectRepository(PendingApproval)
    private readonly approvalRepo: Repository<PendingApproval>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.retentionDays = this.configService.get<number>(
      'PENDING_APPROVAL_RETENTION_DAYS',
      30,
    );
  }

  /**
   * Main cleanup job - runs daily at 3:00 AM.
   * Cleans up rejected approvals and orphaned drafts.
   */
  @Cron('0 3 * * *')
  async runCleanup(): Promise<void> {
    this.logger.log('Starting pending approval cleanup job...');

    try {
      const rejectedStats = await this.cleanupRejectedApprovals();
      const orphanedStats = await this.cleanupOrphanedDrafts();

      this.logger.log(
        `Cleanup completed: ${rejectedStats.approvals} approvals, ` +
          `${rejectedStats.targets} targets deleted; ` +
          `${orphanedStats.facts} orphaned facts, ` +
          `${orphanedStats.activities} orphaned activities, ` +
          `${orphanedStats.commitments} orphaned commitments deleted`,
      );
    } catch (error) {
      this.logger.error('Cleanup job failed:', error);
    }
  }

  /**
   * Delete rejected pending approvals and their target entities
   * older than PENDING_APPROVAL_RETENTION_DAYS.
   */
  async cleanupRejectedApprovals(): Promise<{
    approvals: number;
    targets: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    this.logger.debug(
      `Cleaning rejected approvals older than ${this.retentionDays} days`,
    );

    let totalApprovals = 0;
    let totalTargets = 0;
    let hasMore = true;

    while (hasMore) {
      // Filter by date in SQL query (not in memory) to ensure all old records are found
      const approvals = await this.approvalRepo.find({
        where: {
          status: PendingApprovalStatus.REJECTED,
          reviewedAt: LessThan(cutoffDate),
        },
        order: { reviewedAt: 'ASC' },
        take: this.batchSize,
      });

      if (approvals.length === 0) {
        break;
      }

      await this.dataSource.transaction(async (manager) => {
        const byType = this.groupByItemType(approvals);

        for (const [itemType, ids] of Object.entries(byType)) {
          const deletedCount = await hardDeleteTargets(
            manager,
            itemType as PendingApprovalItemType,
            ids,
          );
          totalTargets += deletedCount;
        }

        const approvalIds = approvals.map((a) => a.id);
        await manager.delete(PendingApproval, { id: In(approvalIds) });
        totalApprovals += approvalIds.length;
      });

      if (approvals.length < this.batchSize) {
        hasMore = false;
      }
    }

    if (totalApprovals > 0) {
      this.logger.log(
        `Cleaned up ${totalApprovals} rejected approvals, ${totalTargets} targets`,
      );
    }

    return { approvals: totalApprovals, targets: totalTargets };
  }

  /**
   * Delete orphaned draft entities that have no associated PendingApproval record.
   */
  async cleanupOrphanedDrafts(): Promise<{
    facts: number;
    activities: number;
    commitments: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    this.logger.debug(
      `Cleaning orphaned drafts older than ${this.retentionDays} days`,
    );

    // Map table names to result property names
    const tableToProperty: Record<string, keyof typeof stats> = {
      entity_facts: 'facts',
      activities: 'activities',
      commitments: 'commitments',
    };

    const stats = {
      facts: 0,
      activities: 0,
      commitments: 0,
    };

    const tableConfigs = getUniqueTableConfigs();

    for (const config of tableConfigs) {
      const deletedCount = await this.cleanupOrphanedEntityType(
        config.tableName,
        config.draftStatus,
        config.itemTypes,
        cutoffDate,
      );
      const propName = tableToProperty[config.tableName];
      if (propName) {
        stats[propName] = deletedCount;
      }
    }

    const totalDeleted = stats.facts + stats.activities + stats.commitments;
    if (totalDeleted > 0) {
      this.logger.log(
        `Cleaned up orphaned drafts: ${stats.facts} facts, ` +
          `${stats.activities} activities, ${stats.commitments} commitments`,
      );
    }

    return stats;
  }

  private groupByItemType(
    approvals: PendingApproval[],
  ): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const approval of approvals) {
      if (!result[approval.itemType]) {
        result[approval.itemType] = [];
      }
      result[approval.itemType].push(approval.targetId);
    }

    return result;
  }

  private async cleanupOrphanedEntityType(
    tableName: string,
    draftStatus: string,
    itemTypes: PendingApprovalItemType[],
    cutoffDate: Date,
  ): Promise<number> {
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      // Use raw query to avoid TypeORM typing issues with dynamic entity
      const drafts: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM ${tableName}
         WHERE status = $1 AND created_at < $2
         LIMIT $3`,
        [draftStatus, cutoffDate, this.batchSize],
      );

      if (drafts.length === 0) {
        hasMore = false;
        break;
      }

      const draftIds = drafts.map((d) => d.id);

      const existingApprovals = await this.approvalRepo.find({
        where: {
          itemType: In(itemTypes),
          targetId: In(draftIds),
        },
        select: ['targetId'],
      });

      const approvalTargetIds = new Set(
        existingApprovals.map((a) => a.targetId),
      );

      const orphanedIds = draftIds.filter(
        (id: string) => !approvalTargetIds.has(id),
      );

      if (orphanedIds.length > 0) {
        await this.dataSource.manager.query(
          `DELETE FROM ${tableName} WHERE id = ANY($1::uuid[])`,
          [orphanedIds],
        );
        totalDeleted += orphanedIds.length;
      }

      if (drafts.length < this.batchSize) {
        hasMore = false;
      }
    }

    return totalDeleted;
  }
}
