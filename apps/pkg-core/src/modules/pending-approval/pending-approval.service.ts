import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
  Activity,
} from '@pkg/entities';
import {
  activateTarget,
  softDeleteTarget,
  hardDeleteTarget,
  updateTarget,
  getItemTypeConfig,
} from './item-type-registry';

/**
 * Input for creating a new pending approval.
 */
export interface CreatePendingApprovalInput {
  itemType: PendingApprovalItemType;
  targetId: string;
  batchId: string;
  confidence: number;
  sourceQuote?: string;
  sourceInteractionId?: string;
  messageRef?: string;
  sourceEntityId?: string;
  context?: string;
}

/**
 * Options for listing pending approvals.
 */
export interface ListPendingApprovalsOptions {
  batchId?: string;
  status?: PendingApprovalStatus;
  limit?: number;
  offset?: number;
}

/**
 * Result of batch operation.
 */
export interface BatchOperationResult {
  processed: number;
  failed: number;
  errors?: string[];
}

/**
 * Input for updating a pending approval's target entity.
 * Fields vary by item type:
 * - task/project: name, description, deadline, priority, parentId
 * - commitment: title, description, dueDate, priority
 * - fact: value, factType
 */
export interface UpdateTargetInput {
  // Common fields
  name?: string; // Activity: name, Commitment: title
  description?: string;
  priority?: string;

  // Activity/Task fields
  deadline?: Date | null;
  parentId?: string | null;
  clientEntityId?: string | null; // "от кого" - requester entity
  assignee?: string | null; // "кому" - 'self' or entity ID

  // Commitment fields
  dueDate?: Date | null;
}

/**
 * Service for managing pending approval workflow.
 *
 * Implements the Draft Entities pattern:
 * - Target entities are created with status='draft'
 * - PendingApproval links to target via itemType + targetId
 * - On approve: target.status → 'active'
 * - On reject: target.deletedAt = now() (soft delete)
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */
@Injectable()
export class PendingApprovalService {
  private readonly logger = new Logger(PendingApprovalService.name);
  private readonly retentionDays: number;

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
   * Create a new pending approval.
   * Should be called after creating the target entity with status='draft'.
   */
  async create(input: CreatePendingApprovalInput): Promise<PendingApproval> {
    const approval = this.approvalRepo.create({
      itemType: input.itemType,
      targetId: input.targetId,
      batchId: input.batchId,
      confidence: input.confidence,
      sourceQuote: input.sourceQuote ?? null,
      sourceInteractionId: input.sourceInteractionId ?? null,
      messageRef: input.messageRef ?? null,
      sourceEntityId: input.sourceEntityId ?? null,
      context: input.context ?? null,
      status: PendingApprovalStatus.PENDING,
    });

    return this.approvalRepo.save(approval);
  }

  /**
   * Get pending approval by ID.
   */
  async getById(id: string): Promise<PendingApproval | null> {
    return this.approvalRepo.findOne({
      where: { id },
      relations: ['sourceInteraction'],
    });
  }

  /**
   * Get the target entity of a pending approval.
   * Returns the actual entity (Activity, Commitment, EntityFact) based on itemType.
   */
  async getTargetEntity(id: string): Promise<{
    itemType: string;
    target: Record<string, unknown>;
  } | null> {
    const approval = await this.approvalRepo.findOne({ where: { id } });
    if (!approval) return null;

    const config = getItemTypeConfig(approval.itemType);
    const target = await this.dataSource.manager.findOne(
      config.entityClass as any,
      { where: { id: approval.targetId } },
    );

    if (!target) return null;
    return {
      itemType: approval.itemType,
      target: target as unknown as Record<string, unknown>,
    };
  }

  /**
   * List pending approvals with optional filters.
   */
  async list(options: ListPendingApprovalsOptions = {}): Promise<{
    items: PendingApproval[];
    total: number;
  }> {
    const { batchId, status, limit = 50, offset = 0 } = options;

    const qb = this.approvalRepo
      .createQueryBuilder('pa')
      .leftJoinAndSelect('pa.sourceInteraction', 'interaction')
      .orderBy('pa.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    if (batchId) {
      qb.andWhere('pa.batchId = :batchId', { batchId });
    }

    if (status) {
      qb.andWhere('pa.status = :status', { status });
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * Approve a pending item.
   * Activates the target entity and marks approval as approved.
   *
   * Uses pessimistic locking for concurrent safety.
   */
  async approve(id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Lock the approval row
      const approval = await manager.findOne(PendingApproval, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      // Idempotency check
      if (approval.status !== PendingApprovalStatus.PENDING) {
        throw new ConflictException(
          `Approval ${id} is already ${approval.status}`,
        );
      }

      // Activate target entity
      const activated = await activateTarget(
        manager,
        approval.itemType,
        approval.targetId,
      );

      if (!activated) {
        throw new NotFoundException(
          `Target ${approval.itemType} ${approval.targetId} not found`,
        );
      }

      // Update approval status
      approval.status = PendingApprovalStatus.APPROVED;
      approval.reviewedAt = new Date();
      await manager.save(PendingApproval, approval);

      this.logger.log(
        `Approved ${approval.itemType} target=${approval.targetId}`,
      );
    });
  }

  /**
   * Reject a pending item.
   * Soft deletes the target entity (or hard deletes if retention=0).
   */
  async reject(id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Lock the approval row
      const approval = await manager.findOne(PendingApproval, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      // Idempotency check
      if (approval.status !== PendingApprovalStatus.PENDING) {
        throw new ConflictException(
          `Approval ${id} is already ${approval.status}`,
        );
      }

      if (this.retentionDays === 0) {
        // Immediate hard delete
        await hardDeleteTarget(
          manager,
          approval.itemType,
          approval.targetId,
        );
        await manager.delete(PendingApproval, id);
        this.logger.log(
          `Rejected and hard-deleted ${approval.itemType} target=${approval.targetId}`,
        );
      } else {
        // Soft delete with retention
        await softDeleteTarget(
          manager,
          approval.itemType,
          approval.targetId,
        );

        approval.status = PendingApprovalStatus.REJECTED;
        approval.reviewedAt = new Date();
        await manager.save(PendingApproval, approval);

        this.logger.log(
          `Rejected ${approval.itemType} target=${approval.targetId} (soft delete, ${this.retentionDays} day retention)`,
        );
      }
    });
  }

  /**
   * Update the target entity of a pending approval.
   * Allows editing draft entities before approving.
   *
   * @param id - PendingApproval ID
   * @param updates - Fields to update on the target entity
   * @throws NotFoundException if approval not found
   * @throws ConflictException if approval is not pending
   */
  async updateTargetEntity(id: string, updates: UpdateTargetInput): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const approval = await manager.findOne(PendingApproval, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      if (approval.status !== PendingApprovalStatus.PENDING) {
        throw new ConflictException(
          `Cannot update target: approval ${id} is already ${approval.status}`,
        );
      }

      // Build updates object based on item type
      const targetUpdates: Record<string, unknown> = {};

      if (
        approval.itemType === PendingApprovalItemType.TASK ||
        approval.itemType === PendingApprovalItemType.PROJECT
      ) {
        // parentId changes require closure-table maintenance (depth, materializedPath, activity_closure)
        // and must go through ActivityService.update() — block here to prevent data corruption
        if (updates.parentId !== undefined) {
          throw new BadRequestException(
            'parentId cannot be changed via this endpoint. Use ActivityService after approval.',
          );
        }

        // Activity entity updates (direct columns)
        if (updates.name !== undefined) targetUpdates.name = updates.name;
        if (updates.description !== undefined) targetUpdates.description = updates.description;
        if (updates.priority !== undefined) targetUpdates.priority = updates.priority;
        if (updates.deadline !== undefined) targetUpdates.deadline = updates.deadline;
        if (updates.clientEntityId !== undefined) targetUpdates.clientEntityId = updates.clientEntityId;

        // assignee is stored in metadata.assignee (JSONB), needs special handling
        if (updates.assignee !== undefined) {
          const activity = await manager.findOne(Activity, {
            where: { id: approval.targetId },
            select: ['id', 'metadata'],
          });
          if (activity) {
            const currentMetadata = (activity.metadata as Record<string, unknown>) || {};
            targetUpdates.metadata = {
              ...currentMetadata,
              assignee: updates.assignee,
            };
          }
        }
      } else if (approval.itemType === PendingApprovalItemType.COMMITMENT) {
        // Commitment entity updates (field name mapping)
        if (updates.name !== undefined) targetUpdates.title = updates.name;
        if (updates.description !== undefined) targetUpdates.description = updates.description;
        if (updates.priority !== undefined) targetUpdates.priority = updates.priority;
        if (updates.dueDate !== undefined) targetUpdates.dueDate = updates.dueDate;
      } else if (approval.itemType === PendingApprovalItemType.FACT) {
        // EntityFact entity - limited updates allowed
        // Facts are typically not edited, just approved/rejected
        this.logger.warn(`Fact updates not yet supported for approval ${id}`);
      }

      if (Object.keys(targetUpdates).length === 0) {
        this.logger.debug(`No updates to apply for approval ${id}`);
        return;
      }

      const updated = await updateTarget(
        manager,
        approval.itemType,
        approval.targetId,
        targetUpdates,
      );

      if (!updated) {
        throw new NotFoundException(
          `Target ${approval.itemType} ${approval.targetId} not found`,
        );
      }

      this.logger.log(
        `Updated ${approval.itemType} target=${approval.targetId}: ${JSON.stringify(targetUpdates)}`,
      );
    });
  }

  /**
   * Approve all pending items in a batch.
   */
  async approveBatch(batchId: string): Promise<BatchOperationResult> {
    return this.dataSource.transaction(async (manager) => {
      const approvals = await manager.find(PendingApproval, {
        where: { batchId, status: PendingApprovalStatus.PENDING },
      });

      if (approvals.length === 0) {
        return { processed: 0, failed: 0 };
      }

      let processed = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const approval of approvals) {
        try {
          const activated = await activateTarget(
            manager,
            approval.itemType,
            approval.targetId,
          );

          if (activated) {
            approval.status = PendingApprovalStatus.APPROVED;
            approval.reviewedAt = new Date();
            processed++;
          } else {
            errors.push(`Target ${approval.itemType}:${approval.targetId} not found`);
            failed++;
          }
        } catch (error) {
          errors.push(`${approval.id}: ${(error as Error).message}`);
          failed++;
        }
      }

      // Save all approvals
      await manager.save(PendingApproval, approvals);

      this.logger.log(
        `Batch approve ${batchId}: ${processed} approved, ${failed} failed`,
      );

      return { processed, failed, errors: errors.length > 0 ? errors : undefined };
    });
  }

  /**
   * Reject all pending items in a batch.
   */
  async rejectBatch(batchId: string): Promise<BatchOperationResult> {
    return this.dataSource.transaction(async (manager) => {
      const approvals = await manager.find(PendingApproval, {
        where: { batchId, status: PendingApprovalStatus.PENDING },
      });

      if (approvals.length === 0) {
        return { processed: 0, failed: 0 };
      }

      let processed = 0;
      let failed = 0;
      const errors: string[] = [];

      if (this.retentionDays === 0) {
        // Hard delete all targets
        for (const approval of approvals) {
          try {
            await hardDeleteTarget(
              manager,
              approval.itemType,
              approval.targetId,
            );
            processed++;
          } catch (error) {
            errors.push(`${approval.id}: ${(error as Error).message}`);
            failed++;
          }
        }

        // Delete all approvals
        await manager.delete(PendingApproval, {
          id: In(approvals.map((a) => a.id)),
        });
      } else {
        // Soft delete all targets
        for (const approval of approvals) {
          try {
            await softDeleteTarget(
              manager,
              approval.itemType,
              approval.targetId,
            );
            approval.status = PendingApprovalStatus.REJECTED;
            approval.reviewedAt = new Date();
            processed++;
          } catch (error) {
            errors.push(`${approval.id}: ${(error as Error).message}`);
            failed++;
          }
        }

        // Save all approvals
        await manager.save(PendingApproval, approvals);
      }

      this.logger.log(
        `Batch reject ${batchId}: ${processed} rejected, ${failed} failed`,
      );

      return { processed, failed, errors: errors.length > 0 ? errors : undefined };
    });
  }

  /**
   * Get statistics for a batch.
   */
  async getBatchStats(batchId: string): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
  }> {
    const stats = await this.approvalRepo
      .createQueryBuilder('pa')
      .select('pa.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('pa.batchId = :batchId', { batchId })
      .groupBy('pa.status')
      .getRawMany<{ status: string; count: string }>();

    const result = {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
    };

    for (const row of stats) {
      const count = parseInt(row.count, 10);
      result.total += count;
      result[row.status as 'pending' | 'approved' | 'rejected'] = count;
    }

    return result;
  }

  /**
   * Get global statistics across all batches.
   */
  async getGlobalStats(): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
  }> {
    const stats = await this.approvalRepo
      .createQueryBuilder('pa')
      .select('pa.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('pa.status')
      .getRawMany<{ status: string; count: string }>();

    const result = {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
    };

    for (const row of stats) {
      const count = parseInt(row.count, 10);
      result.total += count;
      result[row.status as 'pending' | 'approved' | 'rejected'] = count;
    }

    return result;
  }

}
