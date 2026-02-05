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
  EntityRecord,
  EntityFact,
  EntityFactStatus,
  FactSource,
  FactCategory,
} from '@pkg/entities';
import {
  ExtractedProject,
  ExtractedTask,
  ExtractedCommitment,
  ExtractedFact,
} from './daily-synthesis-extraction.types';
import { ProjectMatchingService } from './project-matching.service';

/**
 * Input for creating draft entities with pending approvals.
 */
export interface DraftExtractionInput {
  /** Owner entity ID (usually the user's own entity) */
  ownerEntityId: string;
  /** Facts to create as drafts */
  facts: ExtractedFact[];
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
    facts: number;
    projects: number;
    tasks: number;
    commitments: number;
  };
  /** Count of items skipped due to deduplication */
  skipped: {
    facts: number;
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
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    private readonly projectMatchingService: ProjectMatchingService,
  ) {}

  /**
   * Create draft entities from extracted items.
   *
   * NOTE: We intentionally don't use transactions here due to TypeORM 0.3.x bug
   * with closure-table entities inside transactions (getEntityValue undefined).
   * Orphaned drafts (Activity without PendingApproval) are cleaned up by
   * PendingApprovalCleanupService which runs daily.
   *
   * DEDUPLICATION: Before creating each draft, we check for existing pending
   * approvals with similar content. If found, we skip creating a duplicate.
   *
   * @see https://github.com/typeorm/typeorm/issues/9658
   * @see https://github.com/typeorm/typeorm/issues/11302
   */
  async createDrafts(input: DraftExtractionInput): Promise<DraftExtractionResult> {
    const batchId = randomUUID();
    const result: DraftExtractionResult = {
      batchId,
      approvals: [],
      counts: { facts: 0, projects: 0, tasks: 0, commitments: 0 },
      skipped: { facts: 0, projects: 0, tasks: 0, commitments: 0 },
      errors: [],
    };

    // 0. Create draft facts first
    for (const fact of input.facts || []) {
      try {
        // DEDUPLICATION: Check for existing pending fact with same entity + factType + value
        const existingFact = await this.findExistingPendingFact(
          fact.entityId,
          fact.factType,
          fact.value,
        );
        if (existingFact) {
          this.logger.debug(
            `Skipping duplicate fact "${fact.factType}:${fact.value}" for entity ${fact.entityId} - ` +
              `already pending as ${existingFact.targetId}`,
          );
          result.skipped.facts++;
          continue;
        }

        const { entity, approval } = await this.createDraftFact(fact, input, batchId);

        result.approvals.push(approval);
        result.counts.facts++;
        this.logger.debug(
          `Created draft fact: ${entity.factType}="${entity.value}" (${entity.id})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `fact:${fact.factType}:${fact.value}`, error: message });
        this.logger.error(
          `Failed to create draft fact "${fact.factType}:${fact.value}": ${message}`,
        );
      }
    }

    // Build project name → Activity ID map for task parent resolution
    const projectMap = new Map<string, string>();

    // 1. Create draft projects (tasks may reference them)
    for (const project of input.projects) {
      try {
        // Skip if already matched to existing activity
        if (project.existingActivityId) {
          this.logger.debug(`Skipping existing project: ${project.existingActivityId}`);
          projectMap.set(project.name.toLowerCase(), project.existingActivityId);
          continue;
        }

        // DEDUPLICATION: Enhanced check -- pending approvals + fuzzy match via ProjectMatchingService
        const existing = await this.findExistingProjectEnhanced(
          project.name,
          input.ownerEntityId,
        );
        if (existing.found && existing.activityId) {
          this.logger.debug(
            `Skipping duplicate project "${project.name}" - ` +
              `matched via ${existing.source} (activityId: ${existing.activityId}` +
              `${existing.similarity != null ? `, similarity: ${existing.similarity.toFixed(3)}` : ''})`,
          );
          // Add to projectMap so tasks can still reference the existing activity
          projectMap.set(project.name.toLowerCase(), existing.activityId);
          result.skipped.projects++;
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
        // DEDUPLICATION: Check for existing pending task with similar title
        const existingTask = await this.findExistingPendingTask(task.title);
        if (existingTask) {
          this.logger.debug(
            `Skipping duplicate task "${task.title}" - ` +
              `already pending as ${existingTask.targetId}`,
          );
          result.skipped.tasks++;
          continue;
        }

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
        // DEDUPLICATION: Check for existing pending commitment with similar title
        const existingCommitment = await this.findExistingPendingCommitment(commitment.what);
        if (existingCommitment) {
          this.logger.debug(
            `Skipping duplicate commitment "${commitment.what}" - ` +
              `already pending as ${existingCommitment.targetId}`,
          );
          result.skipped.commitments++;
          continue;
        }

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

    const totalSkipped =
      result.skipped.facts +
      result.skipped.projects +
      result.skipped.tasks +
      result.skipped.commitments;
    this.logger.log(
      `Draft extraction complete (batch=${batchId}): ` +
        `${result.counts.facts} facts, ${result.counts.projects} projects, ` +
        `${result.counts.tasks} tasks, ${result.counts.commitments} commitments ` +
        `(${totalSkipped} skipped as duplicates, ${result.errors.length} errors)`,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Draft Creation Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Create draft EntityFact + PendingApproval.
   */
  private async createDraftFact(
    fact: ExtractedFact,
    input: DraftExtractionInput,
    batchId: string,
  ): Promise<{ entity: EntityFact; approval: PendingApproval }> {
    // Determine fact category from fact type
    const category = this.inferFactCategory(fact.factType);

    // Create draft EntityFact
    const entity = this.factRepo.create({
      entityId: fact.entityId,
      factType: fact.factType,
      category,
      value: fact.value,
      source: FactSource.EXTRACTED,
      confidence: fact.confidence,
      status: EntityFactStatus.DRAFT,
      sourceInteractionId: input.sourceInteractionId ?? null,
    });

    const savedEntity = await this.factRepo.save(entity);

    // Create PendingApproval linking to the draft
    const approval = this.approvalRepo.create({
      itemType: PendingApprovalItemType.FACT,
      targetId: savedEntity.id,
      batchId,
      confidence: fact.confidence ?? 0.8,
      sourceQuote: fact.sourceQuote ?? null,
      sourceInteractionId: input.sourceInteractionId ?? null,
      messageRef: input.messageRef ?? null,
      status: PendingApprovalStatus.PENDING,
    });

    const savedApproval = await this.approvalRepo.save(approval);

    return { entity: savedEntity, approval: savedApproval };
  }

  /**
   * Create draft Activity (PROJECT) + PendingApproval.
   *
   * CRITICAL: Uses QueryBuilder.insert() to bypass TypeORM closure-table bug.
   * The save() method triggers ClosureSubjectExecutor which fails with
   * "Cannot read properties of undefined (reading 'getEntityValue')".
   *
   * @see https://github.com/typeorm/typeorm/issues/9658
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

    // Generate ID manually since QueryBuilder doesn't return the entity
    const activityId = randomUUID();

    // Use QueryBuilder to bypass closure-table logic
    await this.activityRepo
      .createQueryBuilder()
      .insert()
      .into(Activity)
      .values({
        id: activityId,
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
      })
      .execute();

    // Fetch the inserted entity
    const savedActivity = await this.activityRepo.findOneOrFail({
      where: { id: activityId },
    });

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
   * CRITICAL: Uses QueryBuilder.insert() to bypass TypeORM closure-table bug.
   * The save() method triggers ClosureSubjectExecutor which fails with
   * "Cannot read properties of undefined (reading 'getEntityValue')".
   *
   * @see https://github.com/typeorm/typeorm/issues/9658
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

    // Resolve requestedBy to clientEntityId
    // clientEntityId = who requested the task (counterparty)
    let clientEntityId: string | null = null;
    if (task.requestedBy && task.requestedBy !== 'self') {
      const clientEntity = await this.findEntityByNameOrId(task.requestedBy);
      if (clientEntity) {
        clientEntityId = clientEntity.id;
      } else {
        this.logger.warn(`Could not resolve 'requestedBy' entity: "${task.requestedBy}"`);
      }
    }

    // Generate ID manually since QueryBuilder doesn't return the entity
    const activityId = randomUUID();

    // Use QueryBuilder to bypass closure-table logic
    await this.activityRepo
      .createQueryBuilder()
      .insert()
      .into(Activity)
      .values({
        id: activityId,
        name: task.title,
        activityType: ActivityType.TASK,
        status: ActivityStatus.DRAFT,
        priority: this.mapPriority(task.priority),
        parentId: parentId ?? null,
        depth,
        materializedPath,
        ownerEntityId: input.ownerEntityId,
        clientEntityId, // Who requested the task (counterparty)
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
      })
      .execute();

    // Fetch the inserted entity
    const savedActivity = await this.activityRepo.findOneOrFail({
      where: { id: activityId },
    });

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
      const fromEntity = await this.findEntityByNameOrId(commitment.from);
      if (fromEntity) {
        fromEntityId = fromEntity.id;
      } else {
        this.logger.warn(`Could not resolve 'from' entity: "${commitment.from}"`);
      }
    }

    if (commitment.to !== 'self') {
      const toEntity = await this.findEntityByNameOrId(commitment.to);
      if (toEntity) {
        toEntityId = toEntity.id;
      } else {
        this.logger.warn(`Could not resolve 'to' entity: "${commitment.to}"`);
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
  // Private: Deduplication Helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Find existing pending fact with same entity, factType, and value.
   * Returns the PendingApproval if found, null otherwise.
   */
  private async findExistingPendingFact(
    entityId: string,
    factType: string,
    value: string,
  ): Promise<PendingApproval | null> {
    // Find pending approval for FACT type
    const pendingApprovals = await this.approvalRepo.find({
      where: {
        itemType: PendingApprovalItemType.FACT,
        status: PendingApprovalStatus.PENDING,
      },
    });

    if (pendingApprovals.length === 0) return null;

    // Check each pending approval's target EntityFact for match
    const targetIds = pendingApprovals.map((p) => p.targetId);
    const matchingFact = await this.factRepo
      .createQueryBuilder('f')
      .where('f.id IN (:...ids)', { ids: targetIds })
      .andWhere('f.entity_id = :entityId', { entityId })
      .andWhere('f.fact_type = :factType', { factType })
      .andWhere('f.value ILIKE :value', { value })
      .getOne();

    if (!matchingFact) return null;

    return pendingApprovals.find((p) => p.targetId === matchingFact.id) ?? null;
  }

  /**
   * Find existing pending project with similar name.
   * Returns the PendingApproval if found, null otherwise.
   */
  private async findExistingPendingProject(name: string): Promise<PendingApproval | null> {
    // First find pending approval for PROJECT type
    const pendingApprovals = await this.approvalRepo.find({
      where: {
        itemType: PendingApprovalItemType.PROJECT,
        status: PendingApprovalStatus.PENDING,
      },
    });

    if (pendingApprovals.length === 0) return null;

    // Check each pending approval's target Activity for name match
    const targetIds = pendingApprovals.map((p) => p.targetId);
    const matchingActivity = await this.activityRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: targetIds })
      .andWhere('a.name ILIKE :pattern', { pattern: name })
      .getOne();

    if (!matchingActivity) return null;

    return pendingApprovals.find((p) => p.targetId === matchingActivity.id) ?? null;
  }

  /**
   * Enhanced project deduplication check.
   *
   * Checks two layers:
   * 1. Existing pending approvals (exact ILIKE match -- current behavior)
   * 2. Active/Draft activities via fuzzy Levenshtein matching (ProjectMatchingService)
   *
   * Returns the activity ID if a match is found so the caller can skip
   * creating a new draft and instead reference the existing activity.
   */
  private async findExistingProjectEnhanced(
    projectName: string,
    ownerEntityId: string,
  ): Promise<{ found: boolean; activityId?: string; similarity?: number; source?: string }> {
    // Step 1: Check pending approvals (existing exact ILIKE logic)
    const pendingMatch = await this.findExistingPendingProject(projectName);
    if (pendingMatch) {
      return {
        found: true,
        activityId: pendingMatch.targetId,
        source: 'pending_approval',
      };
    }

    // Step 2: Check active activities via ProjectMatchingService (fuzzy Levenshtein)
    const matchResult = await this.projectMatchingService.findBestMatch({
      name: projectName,
      ownerEntityId,
    });

    if (matchResult.matched && matchResult.activity) {
      this.logger.log(
        `Fuzzy matched project "${projectName}" -> "${matchResult.activity.name}" ` +
          `(similarity: ${matchResult.similarity.toFixed(3)})`,
      );
      return {
        found: true,
        activityId: matchResult.activity.id,
        similarity: matchResult.similarity,
        source: 'fuzzy_match',
      };
    }

    return { found: false };
  }

  /**
   * Find existing pending task with similar title.
   * Returns the PendingApproval if found, null otherwise.
   */
  private async findExistingPendingTask(title: string): Promise<PendingApproval | null> {
    // First find pending approval for TASK type
    const pendingApprovals = await this.approvalRepo.find({
      where: {
        itemType: PendingApprovalItemType.TASK,
        status: PendingApprovalStatus.PENDING,
      },
    });

    if (pendingApprovals.length === 0) return null;

    // Check each pending approval's target Activity for name match
    const targetIds = pendingApprovals.map((p) => p.targetId);
    const matchingActivity = await this.activityRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids: targetIds })
      .andWhere('a.name ILIKE :pattern', { pattern: title })
      .getOne();

    if (!matchingActivity) return null;

    return pendingApprovals.find((p) => p.targetId === matchingActivity.id) ?? null;
  }

  /**
   * Find existing pending commitment with similar title.
   * Returns the PendingApproval if found, null otherwise.
   */
  private async findExistingPendingCommitment(what: string): Promise<PendingApproval | null> {
    // First find pending approval for COMMITMENT type
    const pendingApprovals = await this.approvalRepo.find({
      where: {
        itemType: PendingApprovalItemType.COMMITMENT,
        status: PendingApprovalStatus.PENDING,
      },
    });

    if (pendingApprovals.length === 0) return null;

    // Check each pending approval's target Commitment for title match
    const targetIds = pendingApprovals.map((p) => p.targetId);
    const matchingCommitment = await this.commitmentRepo
      .createQueryBuilder('c')
      .where('c.id IN (:...ids)', { ids: targetIds })
      .andWhere('c.title ILIKE :pattern', { pattern: what })
      .getOne();

    if (!matchingCommitment) return null;

    return pendingApprovals.find((p) => p.targetId === matchingCommitment.id) ?? null;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Entity Resolution
  // ─────────────────────────────────────────────────────────────

  /**
   * UUID v4 regex pattern.
   */
  private static readonly UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Find entity by name or ID.
   * If value looks like a UUID, search by ID directly.
   * Otherwise, do a fuzzy name search.
   */
  private async findEntityByNameOrId(value: string): Promise<EntityRecord | null> {
    // If it looks like a UUID, search by ID
    if (DraftExtractionService.UUID_PATTERN.test(value)) {
      return this.entityRepo.findOne({ where: { id: value } });
    }

    // Otherwise, fuzzy search by name
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :pattern', { pattern: `%${value}%` })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();
  }

  /**
   * Find entity by name (fuzzy match).
   * @deprecated Use findEntityByNameOrId instead
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
      case 'meeting':
        return CommitmentType.MEETING;
      default:
        return CommitmentType.PROMISE;
    }
  }

  /**
   * Infer fact category from fact type.
   */
  private inferFactCategory(factType: string): FactCategory {
    const categoryMap: Record<string, FactCategory> = {
      // Personal
      birthday: FactCategory.PERSONAL,
      name_full: FactCategory.PERSONAL,
      nickname: FactCategory.PERSONAL,
      // Contact
      phone_work: FactCategory.CONTACT,
      phone_personal: FactCategory.CONTACT,
      email_work: FactCategory.CONTACT,
      email_personal: FactCategory.CONTACT,
      address: FactCategory.CONTACT,
      telegram: FactCategory.CONTACT,
      // Professional
      position: FactCategory.PROFESSIONAL,
      department: FactCategory.PROFESSIONAL,
      company: FactCategory.PROFESSIONAL,
      specialization: FactCategory.PROFESSIONAL,
      // Business
      inn: FactCategory.BUSINESS,
      kpp: FactCategory.BUSINESS,
      ogrn: FactCategory.BUSINESS,
      legal_address: FactCategory.BUSINESS,
      actual_address: FactCategory.BUSINESS,
      bank_account: FactCategory.FINANCIAL,
      // Preferences
      communication_preference: FactCategory.PREFERENCES,
      timezone: FactCategory.PREFERENCES,
      language: FactCategory.PREFERENCES,
    };

    return categoryMap[factType.toLowerCase()] ?? FactCategory.PERSONAL;
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
