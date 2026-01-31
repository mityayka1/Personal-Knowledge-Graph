import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityPriority,
  Commitment,
  CommitmentType,
  CommitmentStatus,
  CommitmentPriority,
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
  EntityFact,
  EntityFactStatus,
  EntityRecord,
} from '@pkg/entities';
import {
  ExtractedProject,
  ExtractedTask,
  ExtractedCommitment,
} from './daily-synthesis-extraction.types';

/**
 * Input for creating draft entities with pending approvals.
 */
export interface DraftExtractionInput {
  /** Owner entity ID (usually the user's own entity) */
  ownerEntityId: string;
  /** Projects to create as drafts */
  projects: ExtractedProject[];
  /** Tasks to create as drafts */
  tasks: ExtractedTask[];
  /** Commitments to create as drafts */
  commitments: ExtractedCommitment[];
  /** Source interaction ID for tracking */
  sourceInteractionId?: string;
  /** Message reference for Telegram updates */
  messageRef?: string;
  /** Optional: synthesis date for metadata */
  synthesisDate?: string;
  /** Optional: focus topic for metadata */
  focusTopic?: string;
}

/**
 * Result of creating draft entities.
 */
export interface DraftExtractionResult {
  /** Batch ID for grouping all approvals */
  batchId: string;
  /** Created PendingApproval records */
  approvals: PendingApproval[];
  /** Count of drafts created by type */
  counts: {
    projects: number;
    tasks: number;
    commitments: number;
  };
  /** Items that failed to create */
  errors: Array<{ item: string; error: string }>;
}

/**
 * DraftExtractionService — creates draft entities with PendingApproval records.
 *
 * Implements Draft Entities pattern:
 * - Creates Activity/Commitment with status='draft'
 * - Creates PendingApproval linking to target via itemType + targetId
 * - On approve: target.status → 'active' (handled by PendingApprovalService)
 * - On reject: soft delete target (handled by PendingApprovalService)
 *
 * Unlike ExtractionPersistenceService which creates ACTIVE entities after
 * carousel confirmation, this service creates DRAFT entities immediately
 * during extraction, allowing for the pending approval workflow.
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */
@Injectable()
export class DraftExtractionService {
  private readonly logger = new Logger(DraftExtractionService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
    @InjectRepository(PendingApproval)
    private readonly approvalRepo: Repository<PendingApproval>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
  ) {}

  /**
   * Create draft entities from extracted items.
   *
   * NOTE: We intentionally don't use transactions here due to TypeORM 0.3.x bug
   * with closure-table entities inside transactions (getEntityValue undefined).
   * Orphaned drafts (Activity without PendingApproval) are cleaned up by
   * PendingApprovalCleanupService which runs daily.
   *
   * @see https://github.com/typeorm/typeorm/issues/9658
   * @see https://github.com/typeorm/typeorm/issues/11302
   */
  async createDrafts(input: DraftExtractionInput): Promise<DraftExtractionResult> {
    const batchId = randomUUID();
    const result: DraftExtractionResult = {
      batchId,
      approvals: [],
      counts: { projects: 0, tasks: 0, commitments: 0 },
      errors: [],
    };

    // Build project name → Activity ID map for task parent resolution
    const projectMap = new Map<string, string>();

    // 1. Create draft projects first (tasks may reference them)
    for (const project of input.projects) {
      try {
        // Skip if already matched to existing activity
        if (project.existingActivityId) {
          this.logger.debug(`Skipping existing project: ${project.existingActivityId}`);
          continue;
        }

        const { activity, approval } = await this.createDraftProject(
          project,
          input,
          batchId,
        );

        projectMap.set(project.name.toLowerCase(), activity.id);
        result.approvals.push(approval);
        result.counts.projects++;
        this.logger.debug(`Created draft project: ${activity.name} (${activity.id})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `project:${project.name}`, error: message });
        this.logger.error(`Failed to create draft project "${project.name}": ${message}`);
      }
    }

    // 2. Create draft tasks (may link to projects)
    for (const task of input.tasks) {
      try {
        const parentId = task.projectName
          ? projectMap.get(task.projectName.toLowerCase())
          : undefined;

        const { activity, approval } = await this.createDraftTask(
          task,
          input,
          batchId,
          parentId,
        );

        result.approvals.push(approval);
        result.counts.tasks++;
        this.logger.debug(`Created draft task: ${activity.name} (${activity.id})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `task:${task.title}`, error: message });
        this.logger.error(`Failed to create draft task "${task.title}": ${message}`);
      }
    }

    // 3. Create draft commitments
    for (const commitment of input.commitments) {
      try {
        const { entity, approval } = await this.createDraftCommitment(
          commitment,
          input,
          batchId,
        );

        result.approvals.push(approval);
        result.counts.commitments++;
        this.logger.debug(`Created draft commitment: ${entity.title} (${entity.id})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `commitment:${commitment.what}`, error: message });
        this.logger.error(`Failed to create draft commitment "${commitment.what}": ${message}`);
      }
    }

    this.logger.log(
      `Draft extraction complete (batch=${batchId}): ` +
        `${result.counts.projects} projects, ${result.counts.tasks} tasks, ` +
        `${result.counts.commitments} commitments (${result.errors.length} errors)`,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Draft Creation Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Create draft Activity (PROJECT) + PendingApproval.
   *
   * Uses injected repository instead of transactional manager to avoid
   * TypeORM 0.3.x closure-table bug.
   */
  private async createDraftProject(
    project: ExtractedProject,
    input: DraftExtractionInput,
    batchId: string,
  ): Promise<{ activity: Activity; approval: PendingApproval }> {
    // Try to resolve client entity
    let clientEntityId: string | null = null;
    if (project.client) {
      const client = await this.findEntityByName(project.client);
      clientEntityId = client?.id ?? null;
    }

    // Create draft Activity using injected repository
    const activity = this.activityRepo.create({
      name: project.name,
      activityType: ActivityType.PROJECT,
      status: ActivityStatus.DRAFT,
      ownerEntityId: input.ownerEntityId,
      clientEntityId,
      depth: 0,
      materializedPath: null,
      metadata: {
        extractedFrom: 'daily_synthesis',
        synthesisDate: input.synthesisDate,
        focusTopic: input.focusTopic,
        participants: project.participants,
        sourceQuote: project.sourceQuote,
        confidence: project.confidence,
        draftBatchId: batchId,
      },
    });

    const savedActivity = await this.activityRepo.save(activity);

    // Create PendingApproval linking to the draft
    const approval = this.approvalRepo.create({
      itemType: PendingApprovalItemType.PROJECT,
      targetId: savedActivity.id,
      batchId,
      confidence: project.confidence ?? 0.8,
      sourceQuote: project.sourceQuote,
      sourceInteractionId: input.sourceInteractionId ?? null,
      messageRef: input.messageRef ?? null,
      status: PendingApprovalStatus.PENDING,
    });

    const savedApproval = await this.approvalRepo.save(approval);

    return { activity: savedActivity, approval: savedApproval };
  }

  /**
   * Create draft Activity (TASK) + PendingApproval.
   *
   * Uses injected repository instead of transactional manager to avoid
   * TypeORM 0.3.x closure-table bug.
   */
  private async createDraftTask(
    task: ExtractedTask,
    input: DraftExtractionInput,
    batchId: string,
    parentId?: string,
  ): Promise<{ activity: Activity; approval: PendingApproval }> {
    // Compute depth and materializedPath if parent exists
    let depth = 0;
    let materializedPath: string | null = null;

    if (parentId) {
      const parent = await this.activityRepo.findOne({ where: { id: parentId } });
      if (parent) {
        depth = parent.depth + 1;
        materializedPath = parent.materializedPath
          ? `${parent.materializedPath}/${parent.id}`
          : parent.id;
      }
    }

    // Create draft Activity using injected repository
    const activity = this.activityRepo.create({
      name: task.title,
      activityType: ActivityType.TASK,
      status: ActivityStatus.DRAFT,
      priority: this.mapPriority(task.priority),
      parentId: parentId ?? null,
      depth,
      materializedPath,
      ownerEntityId: input.ownerEntityId,
      deadline: task.deadline ? new Date(task.deadline) : null,
      metadata: {
        extractedFrom: 'daily_synthesis',
        synthesisDate: input.synthesisDate,
        focusTopic: input.focusTopic,
        assignee: task.assignee,
        sourceQuote: task.sourceQuote,
        confidence: task.confidence,
        draftBatchId: batchId,
      },
    });

    const savedActivity = await this.activityRepo.save(activity);

    // Create PendingApproval linking to the draft
    const approval = this.approvalRepo.create({
      itemType: PendingApprovalItemType.TASK,
      targetId: savedActivity.id,
      batchId,
      confidence: task.confidence ?? 0.8,
      sourceQuote: task.sourceQuote,
      sourceInteractionId: input.sourceInteractionId ?? null,
      messageRef: input.messageRef ?? null,
      status: PendingApprovalStatus.PENDING,
    });

    const savedApproval = await this.approvalRepo.save(approval);

    return { activity: savedActivity, approval: savedApproval };
  }

  /**
   * Create draft Commitment + PendingApproval.
   *
   * Uses injected repository for consistency with other methods.
   */
  private async createDraftCommitment(
    commitment: ExtractedCommitment,
    input: DraftExtractionInput,
    batchId: string,
  ): Promise<{ entity: Commitment; approval: PendingApproval }> {
    // Resolve from/to entities
    let fromEntityId = input.ownerEntityId;
    let toEntityId = input.ownerEntityId;

    if (commitment.from !== 'self') {
      const fromEntity = await this.findEntityByName(commitment.from);
      if (fromEntity) {
        fromEntityId = fromEntity.id;
      }
    }

    if (commitment.to !== 'self') {
      const toEntity = await this.findEntityByName(commitment.to);
      if (toEntity) {
        toEntityId = toEntity.id;
      }
    }

    // Create draft Commitment using injected repository
    const entity = this.commitmentRepo.create({
      type: this.mapCommitmentType(commitment.type),
      title: commitment.what,
      fromEntityId,
      toEntityId,
      status: CommitmentStatus.DRAFT,
      priority: this.mapCommitmentPriority(commitment.priority),
      dueDate: commitment.deadline ? new Date(commitment.deadline) : null,
      confidence: commitment.confidence,
      metadata: {
        extractedFrom: 'daily_synthesis',
        synthesisDate: input.synthesisDate,
        focusTopic: input.focusTopic,
        sourceQuote: commitment.sourceQuote,
        draftBatchId: batchId,
      },
    });

    const savedEntity = await this.commitmentRepo.save(entity);

    // Create PendingApproval linking to the draft
    const approval = this.approvalRepo.create({
      itemType: PendingApprovalItemType.COMMITMENT,
      targetId: savedEntity.id,
      batchId,
      confidence: commitment.confidence ?? 0.8,
      sourceQuote: commitment.sourceQuote,
      sourceInteractionId: input.sourceInteractionId ?? null,
      messageRef: input.messageRef ?? null,
      status: PendingApprovalStatus.PENDING,
    });

    const savedApproval = await this.approvalRepo.save(approval);

    return { entity: savedEntity, approval: savedApproval };
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Entity Resolution
  // ─────────────────────────────────────────────────────────────

  /**
   * Find entity by name (fuzzy match).
   */
  private async findEntityByName(name: string): Promise<EntityRecord | null> {
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :pattern', { pattern: `%${name}%` })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Mapping Functions
  // ─────────────────────────────────────────────────────────────

  private mapPriority(priority?: string): ActivityPriority {
    switch (priority?.toLowerCase()) {
      case 'high':
        return ActivityPriority.HIGH;
      case 'low':
        return ActivityPriority.LOW;
      case 'medium':
      default:
        return ActivityPriority.MEDIUM;
    }
  }

  private mapCommitmentType(type: string): CommitmentType {
    switch (type) {
      case 'promise':
        return CommitmentType.PROMISE;
      case 'request':
        return CommitmentType.REQUEST;
      case 'agreement':
        return CommitmentType.AGREEMENT;
      case 'deadline':
        return CommitmentType.DEADLINE;
      case 'reminder':
        return CommitmentType.REMINDER;
      default:
        return CommitmentType.PROMISE;
    }
  }

  private mapCommitmentPriority(priority?: string): CommitmentPriority {
    switch (priority?.toLowerCase()) {
      case 'high':
        return CommitmentPriority.HIGH;
      case 'low':
        return CommitmentPriority.LOW;
      case 'critical':
        return CommitmentPriority.CRITICAL;
      case 'medium':
      default:
        return CommitmentPriority.MEDIUM;
    }
  }
}
