import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
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
import { ClientResolutionService } from './client-resolution.service';
import { ActivityMemberService } from '../activity/activity-member.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { FactDedupReviewService, ReviewCandidate } from './fact-dedup-review.service';
import { SettingsService } from '../settings/settings.service';

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
    private readonly clientResolutionService: ClientResolutionService,
    private readonly activityMemberService: ActivityMemberService,
    private readonly factDeduplicationService: FactDeduplicationService,
    private readonly factDedupReviewService: FactDedupReviewService,
    private readonly settingsService: SettingsService,
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

    // 0. Create draft facts — two-pass hybrid deduplication (text + semantic + LLM review)
    let reviewThreshold = 0.40;
    try {
      const settings = await this.settingsService.getDedupSettings();
      reviewThreshold = settings.reviewThreshold;
    } catch (error) {
      this.logger.error(
        `Failed to load dedup settings, using default reviewThreshold=${reviewThreshold}: ` +
          (error instanceof Error ? error.message : 'Unknown error'),
      );
    }
    // Clamp: reviewThreshold must be < 0.70 (SEMANTIC_SIMILARITY_THRESHOLD)
    if (reviewThreshold >= 0.70) {
      this.logger.warn(
        `reviewThreshold=${reviewThreshold} is >= 0.70, clamping to 0.40 to avoid skipping grey zone`,
      );
      reviewThreshold = 0.40;
    }

    // Pass 1: Hybrid dedup check — collect auto-skip, auto-create, and review candidates
    const factsToCreate: Array<{ fact: ExtractedFact; embedding?: number[] }> = [];
    const reviewCandidates: ReviewCandidate[] = [];

    for (let i = 0; i < (input.facts || []).length; i++) {
      const fact = input.facts[i];
      try {
        const dedupResult = await this.factDeduplicationService.checkDuplicateHybrid(
          fact.entityId,
          fact,
          reviewThreshold,
        );

        if (dedupResult.action === 'create') {
          factsToCreate.push({ fact, embedding: dedupResult.embedding });
        } else if (dedupResult.action === 'review') {
          // Grey zone — collect for LLM batch review
          reviewCandidates.push({
            index: i,
            entityId: fact.entityId,
            newFact: fact,
            matchedFactId: dedupResult.matchedFactId!,
            similarity: dedupResult.similarity!,
            embedding: dedupResult.embedding,
          });
        } else {
          // skip, update, supersede — auto-skip
          this.logger.debug(
            `Skipping duplicate fact "${fact.factType}:${fact.value}" for entity ${fact.entityId} — ` +
              `${dedupResult.reason}` +
              (dedupResult.existingFactId ? ` (existing: ${dedupResult.existingFactId})` : ''),
          );
          result.skipped.facts++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `fact:${fact.factType}:${fact.value}`, error: message });
        this.logger.error(
          `Failed dedup check for fact "${fact.factType}:${fact.value}": ${message}`,
        );
      }
    }

    // Pass 2: LLM review for grey-zone candidates
    if (reviewCandidates.length > 0) {
      this.logger.log(
        `${reviewCandidates.length} fact(s) in grey zone (similarity ${reviewThreshold.toFixed(2)}-0.70), sending to LLM review`,
      );

      const decisions = await this.factDedupReviewService.reviewBatch(reviewCandidates);

      for (const decision of decisions) {
        const candidate = reviewCandidates.find((c) => c.index === decision.newFactIndex);
        if (!candidate) {
          this.logger.warn(
            `LLM returned decision for unknown index ${decision.newFactIndex}, skipping`,
          );
          continue;
        }

        if (decision.action === 'create') {
          factsToCreate.push({ fact: candidate.newFact, embedding: candidate.embedding });
        } else {
          this.logger.debug(
            `LLM review: skipping "${candidate.newFact.factType}:${candidate.newFact.value}" — ${decision.reason}`,
          );
          result.skipped.facts++;
        }
      }
    }

    // Pass 3: Create all approved draft facts
    for (const { fact, embedding } of factsToCreate) {
      try {
        const { entity, approval } = await this.createDraftFact(
          fact, input, batchId, embedding,
        );

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
        const normalizedKey = ProjectMatchingService.normalizeName(project.name);

        // Skip if already matched to existing activity
        if (project.existingActivityId) {
          this.logger.debug(`Skipping existing project: ${project.existingActivityId}`);
          projectMap.set(normalizedKey, project.existingActivityId);
          continue;
        }

        // DEDUPLICATION: Enhanced check -- pending approvals + two-tier fuzzy match
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
          projectMap.set(normalizedKey, existing.activityId);
          result.skipped.projects++;
          continue;
        }

        const { activity, approval } = await this.createDraftProject(
          project,
          input,
          batchId,
          existing.weakMatch,
        );

        projectMap.set(normalizedKey, activity.id);
        result.approvals.push(approval);
        result.counts.projects++;
        this.logger.debug(`Created draft project: ${activity.name} (${activity.id})`);

        // Create ActivityMember records for project participants
        if (project.participants?.length) {
          try {
            await this.activityMemberService.resolveAndCreateMembers({
              activityId: activity.id,
              participants: project.participants,
              ownerEntityId: input.ownerEntityId,
              clientEntityId: activity.clientEntityId ?? undefined,
            });
          } catch (memberError) {
            this.logger.warn(
              `Failed to create members for project "${project.name}": ${memberError instanceof Error ? memberError.message : 'Unknown'}`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({ item: `project:${project.name}`, error: message });
        this.logger.error(`Failed to create draft project "${project.name}": ${message}`);
      }
    }

    // 2. Create draft tasks (may link to projects)
    for (const task of input.tasks) {
      try {
        // DEDUPLICATION: Enhanced check -- pending approvals + active tasks via fuzzy match
        const existingTask = await this.findExistingTaskEnhanced(
          task.title,
          input.ownerEntityId,
        );
        if (existingTask.found) {
          this.logger.debug(
            `Skipping duplicate task "${task.title}" - ` +
              `matched via ${existingTask.source} (activityId: ${existingTask.activityId}` +
              `${existingTask.similarity != null ? `, similarity: ${existingTask.similarity.toFixed(3)}` : ''})`,
          );
          result.skipped.tasks++;
          continue;
        }

        const parentId = task.projectName
          ? projectMap.get(ProjectMatchingService.normalizeName(task.projectName))
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

        // Resolve activityId from projectMap for commitment
        let commitmentActivityId: string | undefined;
        if (commitment.projectName) {
          commitmentActivityId = projectMap.get(
            ProjectMatchingService.normalizeName(commitment.projectName),
          );
        }

        const { entity, approval } = await this.createDraftCommitment(
          commitment,
          input,
          batchId,
          commitmentActivityId,
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
   * Saves embedding if provided (from semantic dedup check) so future
   * facts in the same batch can be found via pgvector search.
   */
  private async createDraftFact(
    fact: ExtractedFact,
    input: DraftExtractionInput,
    batchId: string,
    embedding?: number[],
  ): Promise<{ entity: EntityFact; approval: PendingApproval }> {
    // Determine fact category from fact type
    const category = this.inferFactCategory(fact.factType);

    // Create draft EntityFact — with embedding for future semantic dedup
    const entity = this.factRepo.create({
      entityId: fact.entityId,
      factType: fact.factType,
      category,
      value: fact.value,
      source: FactSource.EXTRACTED,
      confidence: fact.confidence,
      status: EntityFactStatus.DRAFT,
      sourceInteractionId: input.sourceInteractionId ?? null,
      embedding: embedding ?? null,
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
    weakMatch?: { matchedActivityId: string; matchedName: string; similarity: number },
  ): Promise<{ activity: Activity; approval: PendingApproval }> {
    // Try to resolve client entity via 3-strategy approach
    let clientEntityId: string | null = null;
    let clientResolutionMethod: string | undefined;
    const clientResult = await this.clientResolutionService.resolveClient({
      clientName: project.client,
      participants: project.participants,
      ownerEntityId: input.ownerEntityId,
    });
    if (clientResult) {
      clientEntityId = clientResult.entityId;
      clientResolutionMethod = clientResult.method;
      this.logger.debug(
        `Resolved client for project "${project.name}": "${clientResult.entityName}" via ${clientResult.method}`,
      );
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
        description: project.description ?? null,
        tags: project.tags ?? null,
        lastActivityAt: new Date(),
        depth: 0,
        materializedPath: null,
        metadata: {
          extractedFrom: 'daily_synthesis',
          synthesisDate: input.synthesisDate,
          focusTopic: input.focusTopic,
          sourceQuote: project.sourceQuote,
          confidence: project.confidence,
          clientResolutionMethod,
          draftBatchId: batchId,
          ...(weakMatch && {
            possibleDuplicate: {
              matchedActivityId: weakMatch.matchedActivityId,
              matchedName: weakMatch.matchedName,
              similarity: weakMatch.similarity,
            },
          }),
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
      if (DraftExtractionService.UUID_PATTERN.test(task.requestedBy)) {
        const clientEntity = await this.entityRepo.findOne({ where: { id: task.requestedBy } });
        if (clientEntity) clientEntityId = clientEntity.id;
        else this.logger.warn(`Could not resolve 'requestedBy' entity by UUID: "${task.requestedBy}"`);
      } else {
        const clientEntity = await this.clientResolutionService.findEntityByName(task.requestedBy);
        if (clientEntity) clientEntityId = clientEntity.id;
        else this.logger.warn(`Could not resolve 'requestedBy' entity: "${task.requestedBy}"`);
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
    activityId?: string,
  ): Promise<{ entity: Commitment; approval: PendingApproval }> {
    // Resolve from/to entities
    let fromEntityId = input.ownerEntityId;
    let toEntityId = input.ownerEntityId;

    if (commitment.from !== 'self') {
      if (DraftExtractionService.UUID_PATTERN.test(commitment.from)) {
        const fromEntity = await this.entityRepo.findOne({ where: { id: commitment.from } });
        if (fromEntity) fromEntityId = fromEntity.id;
        else this.logger.warn(`Could not resolve 'from' entity by UUID: "${commitment.from}"`);
      } else {
        const fromEntity = await this.clientResolutionService.findEntityByName(commitment.from);
        if (fromEntity) fromEntityId = fromEntity.id;
        else this.logger.warn(`Could not resolve 'from' entity: "${commitment.from}"`);
      }
    }

    if (commitment.to !== 'self') {
      if (DraftExtractionService.UUID_PATTERN.test(commitment.to)) {
        const toEntity = await this.entityRepo.findOne({ where: { id: commitment.to } });
        if (toEntity) toEntityId = toEntity.id;
        else this.logger.warn(`Could not resolve 'to' entity by UUID: "${commitment.to}"`);
      } else {
        const toEntity = await this.clientResolutionService.findEntityByName(commitment.to);
        if (toEntity) toEntityId = toEntity.id;
        else this.logger.warn(`Could not resolve 'to' entity: "${commitment.to}"`);
      }
    }

    // Create draft Commitment using injected repository
    const entity = this.commitmentRepo.create({
      type: this.mapCommitmentType(commitment.type),
      title: commitment.what,
      fromEntityId,
      toEntityId,
      activityId: activityId ?? null,
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
   * Enhanced project deduplication check with two-tier matching.
   *
   * Checks two layers:
   * 1. Existing pending approvals (exact ILIKE match)
   * 2. Active/Draft activities via fuzzy Levenshtein matching (ProjectMatchingService)
   *
   * Two-tier threshold:
   * - >= 0.8 (strong match) → found=true, skip creation
   * - 0.6-0.8 (weak match)  → found=false, weakMatch populated for metadata flag
   * - < 0.6 (no match)      → found=false, create normally
   */
  private async findExistingProjectEnhanced(
    projectName: string,
    ownerEntityId: string,
  ): Promise<{
    found: boolean;
    activityId?: string;
    similarity?: number;
    source?: string;
    weakMatch?: { matchedActivityId: string; matchedName: string; similarity: number };
  }> {
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
    // Use a lower threshold (0.6) to capture weak matches too
    const matchResult = await this.projectMatchingService.findBestMatch({
      name: projectName,
      ownerEntityId,
      threshold: DraftExtractionService.WEAK_MATCH_THRESHOLD,
    });

    if (matchResult.matched && matchResult.activity) {
      // Strong match (>= 0.8): skip creation
      if (matchResult.similarity >= DraftExtractionService.STRONG_MATCH_THRESHOLD) {
        this.logger.log(
          `Strong match project "${projectName}" -> "${matchResult.activity.name}" ` +
            `(similarity: ${matchResult.similarity.toFixed(3)})`,
        );
        return {
          found: true,
          activityId: matchResult.activity.id,
          similarity: matchResult.similarity,
          source: 'fuzzy_match',
        };
      }

      // Weak match (0.6-0.8): create but flag as possible duplicate
      this.logger.log(
        `Weak match project "${projectName}" -> "${matchResult.activity.name}" ` +
          `(similarity: ${matchResult.similarity.toFixed(3)}) — will create with possibleDuplicate flag`,
      );
      return {
        found: false,
        weakMatch: {
          matchedActivityId: matchResult.activity.id,
          matchedName: matchResult.activity.name,
          similarity: matchResult.similarity,
        },
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
   * Enhanced task deduplication check.
   *
   * Checks two layers:
   * 1. Existing pending approvals (exact ILIKE match)
   * 2. Active tasks owned by the same user via fuzzy Levenshtein matching
   *
   * Uses TASK_DEDUP_THRESHOLD (0.7) for fuzzy matching.
   */
  private async findExistingTaskEnhanced(
    taskTitle: string,
    ownerEntityId: string,
  ): Promise<{ found: boolean; activityId?: string; similarity?: number; source?: string }> {
    // Step 1: Check pending approvals (existing exact ILIKE logic)
    const pendingMatch = await this.findExistingPendingTask(taskTitle);
    if (pendingMatch) {
      return {
        found: true,
        activityId: pendingMatch.targetId,
        source: 'pending_approval',
      };
    }

    // Step 2: Check active tasks via fuzzy matching
    const activeTasks = await this.activityRepo.find({
      where: {
        ownerEntityId,
        activityType: ActivityType.TASK,
        status: Not(In([ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED])),
      },
      select: ['id', 'name'],
    });

    if (activeTasks.length === 0) return { found: false };

    const normalizedTitle = ProjectMatchingService.normalizeName(taskTitle);
    let bestMatch: { activity: Activity; similarity: number } | null = null;

    for (const task of activeTasks) {
      const similarity = this.projectMatchingService.calculateSimilarity(
        normalizedTitle,
        ProjectMatchingService.normalizeName(task.name),
      );
      if (
        similarity >= DraftExtractionService.TASK_DEDUP_THRESHOLD &&
        (!bestMatch || similarity > bestMatch.similarity)
      ) {
        bestMatch = { activity: task, similarity };
      }
    }

    if (bestMatch) {
      this.logger.log(
        `Fuzzy matched task "${taskTitle}" -> "${bestMatch.activity.name}" ` +
          `(similarity: ${bestMatch.similarity.toFixed(3)})`,
      );
      return {
        found: true,
        activityId: bestMatch.activity.id,
        similarity: bestMatch.similarity,
        source: 'fuzzy_match',
      };
    }

    return { found: false };
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

  /** Strong match threshold — skip creation entirely */
  private static readonly STRONG_MATCH_THRESHOLD = 0.8;
  /** Weak match threshold — create with possibleDuplicate flag */
  private static readonly WEAK_MATCH_THRESHOLD = 0.6;
  /** Task dedup threshold — skip creation if existing task is similar enough */
  private static readonly TASK_DEDUP_THRESHOLD = 0.7;


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
