import { Injectable, Logger } from '@nestjs/common';
import {
  ExtractionCarouselState,
  ExtractionCarouselItem,
} from '../../extraction/extraction-carousel-state.service';
import { PendingApproval, CommitmentType } from '@pkg/entities';
import { CommitmentService } from '../../activity/commitment.service';
import { PendingApprovalItemType } from '@pkg/entities';

/**
 * Shared response mapping service for Mini App controllers.
 * Centralizes all response transformation logic.
 */
@Injectable()
export class MiniAppMapperService {
  private readonly logger = new Logger(MiniAppMapperService.name);

  constructor(private readonly commitmentService: CommitmentService) {}

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
  // Extraction Carousel Mapping
  // ─────────────────────────────────────────────────────────────

  /**
   * Map internal carousel state to API response format.
   */
  mapCarouselStateToResponse(state: ExtractionCarouselState, carouselId: string) {
    return {
      id: carouselId,
      items: state.items.map((item) => ({
        id: item.id,
        type: item.type,
        title: this.getItemTitle(item),
        description: this.getItemDescription(item),
        confidence: this.getItemConfidence(item),
        fields: this.getItemFields(item),
        status: state.confirmedIds.includes(item.id)
          ? 'confirmed'
          : state.processedIds.includes(item.id)
            ? 'skipped'
            : 'pending',
      })),
      currentIndex: state.currentIndex,
      totalCount: state.items.length,
      confirmedCount: state.confirmedIds.length,
      skippedCount: state.processedIds.length - state.confirmedIds.length,
    };
  }

  private getItemTitle(item: ExtractionCarouselItem): string {
    const data = item.data;
    return ('name' in data && data.name) || ('title' in data && data.title) || 'Untitled';
  }

  private getItemDescription(item: ExtractionCarouselItem): string | undefined {
    const data = item.data;
    if ('description' in data && typeof data.description === 'string') {
      return data.description;
    }
    if ('context' in data && typeof data.context === 'string') {
      return data.context;
    }
    return undefined;
  }

  private getItemConfidence(item: ExtractionCarouselItem): number {
    const data = item.data;
    return 'confidence' in data && typeof data.confidence === 'number' ? data.confidence : 0.5;
  }

  private getItemFields(item: ExtractionCarouselItem): Record<string, unknown> {
    const data = item.data;
    const fields: Record<string, unknown> = {};

    if (item.type === 'project') {
      if ('status' in data && data.status) fields.status = data.status;
      if ('deadline' in data && data.deadline) fields.deadline = data.deadline;
    } else if (item.type === 'task') {
      if ('priority' in data && data.priority) fields.priority = data.priority;
      if ('dueDate' in data && data.dueDate) fields.dueDate = data.dueDate;
      if ('assignee' in data && data.assignee) fields.assignee = data.assignee;
    } else if (item.type === 'commitment') {
      if ('type' in data && data.type) fields.type = data.type;
      if ('direction' in data && data.direction) fields.direction = data.direction;
      if ('deadline' in data && data.deadline) fields.deadline = data.deadline;
    }

    return fields;
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
