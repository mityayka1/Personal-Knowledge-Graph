import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
  EntityFact,
  EntityFactStatus,
  Activity,
  ActivityStatus,
  Commitment,
  CommitmentStatus,
} from '@pkg/entities';

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
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
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
      const activated = await this.activateTarget(
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
        await this.hardDeleteTarget(
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
        await this.softDeleteTarget(
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
          const activated = await this.activateTarget(
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
            await this.hardDeleteTarget(
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
            await this.softDeleteTarget(
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

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Activate target entity (set status to 'active').
   * Returns true if entity was found and updated.
   */
  private async activateTarget(
    manager: import('typeorm').EntityManager,
    itemType: PendingApprovalItemType,
    targetId: string,
  ): Promise<boolean> {
    switch (itemType) {
      case PendingApprovalItemType.FACT: {
        const result = await manager.update(
          EntityFact,
          { id: targetId },
          { status: EntityFactStatus.ACTIVE },
        );
        return (result.affected ?? 0) > 0;
      }

      case PendingApprovalItemType.PROJECT:
      case PendingApprovalItemType.TASK: {
        // Activity entity handles both projects and tasks
        const activityResult = await manager.update(
          Activity,
          { id: targetId },
          { status: ActivityStatus.ACTIVE },
        );
        return (activityResult.affected ?? 0) > 0;
      }

      case PendingApprovalItemType.COMMITMENT: {
        // Commitment: draft → pending (the natural initial state)
        const commitmentResult = await manager.update(
          Commitment,
          { id: targetId },
          { status: CommitmentStatus.PENDING },
        );
        return (commitmentResult.affected ?? 0) > 0;
      }

      default:
        this.logger.error(`Unknown item type: ${itemType}`);
        return false;
    }
  }

  /**
   * Soft delete target entity (set deletedAt = now()).
   */
  private async softDeleteTarget(
    manager: import('typeorm').EntityManager,
    itemType: PendingApprovalItemType,
    targetId: string,
  ): Promise<void> {
    switch (itemType) {
      case PendingApprovalItemType.FACT:
        await manager.softDelete(EntityFact, { id: targetId });
        break;

      case PendingApprovalItemType.PROJECT:
      case PendingApprovalItemType.TASK:
        await manager.softDelete(Activity, { id: targetId });
        break;

      case PendingApprovalItemType.COMMITMENT:
        await manager.softDelete(Commitment, { id: targetId });
        break;

      default:
        this.logger.error(`Unknown item type: ${itemType}`);
    }
  }

  /**
   * Hard delete target entity.
   */
  private async hardDeleteTarget(
    manager: import('typeorm').EntityManager,
    itemType: PendingApprovalItemType,
    targetId: string,
  ): Promise<void> {
    switch (itemType) {
      case PendingApprovalItemType.FACT:
        await manager.delete(EntityFact, { id: targetId });
        break;

      case PendingApprovalItemType.PROJECT:
      case PendingApprovalItemType.TASK:
        await manager.delete(Activity, { id: targetId });
        break;

      case PendingApprovalItemType.COMMITMENT:
        await manager.delete(Commitment, { id: targetId });
        break;

      default:
        this.logger.error(`Unknown item type: ${itemType}`);
    }
  }
}
