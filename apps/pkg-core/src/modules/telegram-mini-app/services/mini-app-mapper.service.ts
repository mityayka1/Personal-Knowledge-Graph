import { Injectable, Logger } from '@nestjs/common';
import { PendingApproval, CommitmentType } from '@pkg/entities';
import { CommitmentService } from '../../activity/commitment.service';
import { ActivityService } from '../../activity/activity.service';
import { PendingApprovalItemType } from '@pkg/entities';

/**
 * Shared response mapping service for Mini App controllers.
 * Centralizes all response transformation logic.
 */
@Injectable()
export class MiniAppMapperService {
  private readonly logger = new Logger(MiniAppMapperService.name);

  constructor(
    private readonly commitmentService: CommitmentService,
    private readonly activityService: ActivityService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Pending Approval Mapping
  // ─────────────────────────────────────────────────────────────

  /**
   * Map PendingApproval entity to API response format.
   */
  async mapPendingApprovalToResponse(approval: PendingApproval) {
    return {
      id: approval.id,
      itemType: approval.itemType,
      targetId: approval.targetId,
      confidence: approval.confidence,
      sourceQuote: approval.sourceQuote,
      status: approval.status,
      createdAt: approval.createdAt.toISOString(),
      target: await this.loadTargetData(approval),
    };
  }

  /**
   * Load full target entity data based on item type.
   */
  private async loadTargetData(
    approval: PendingApproval,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      if (approval.itemType === PendingApprovalItemType.COMMITMENT) {
        const commitment = await this.commitmentService.findOne(approval.targetId);
        return {
          title: commitment.title,
          description: commitment.description,
          type: commitment.type,
          typeName: this.getCommitmentTypeName(commitment.type),
          dueDate: commitment.dueDate?.toISOString(),
          priority: commitment.priority,
          fromEntity: commitment.fromEntity
            ? { id: commitment.fromEntity.id, name: commitment.fromEntity.name }
            : null,
          toEntity: commitment.toEntity
            ? { id: commitment.toEntity.id, name: commitment.toEntity.name }
            : null,
          preview: approval.sourceQuote?.substring(0, 200),
        };
      }

      // TASK and PROJECT are Activity entities
      if (
        approval.itemType === PendingApprovalItemType.TASK ||
        approval.itemType === PendingApprovalItemType.PROJECT
      ) {
        const activity = await this.activityService.findOne(approval.targetId);
        return {
          title: activity.name,
          description: activity.description,
          dueDate: activity.deadline?.toISOString(),
          priority: activity.priority,
          parentActivity: activity.parent
            ? { id: activity.parent.id, name: activity.parent.name }
            : null,
          ownerEntity: activity.ownerEntity
            ? { id: activity.ownerEntity.id, name: activity.ownerEntity.name }
            : null,
          clientEntity: activity.clientEntity
            ? { id: activity.clientEntity.id, name: activity.clientEntity.name }
            : null,
          preview: approval.sourceQuote?.substring(0, 200),
        };
      }

      if (approval.sourceQuote) {
        return { preview: approval.sourceQuote.substring(0, 200) };
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load target data for ${approval.itemType}/${approval.targetId}: ${error}`,
      );
      if (approval.sourceQuote) {
        return { preview: approval.sourceQuote.substring(0, 200) };
      }
    }

    return undefined;
  }

  /**
   * Get human-readable commitment type name.
   * Note: Returns machine-readable keys for frontend i18n.
   */
  getCommitmentTypeName(type: CommitmentType): string {
    return type.toLowerCase();
  }

  // ─────────────────────────────────────────────────────────────
  // Utility Helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Russian pluralization helper.
   * Note: Consider moving to frontend for proper i18n.
   */
  pluralize(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }
}
