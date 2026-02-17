import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
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
  FactType,
  RelationType,
  RelationSource,
} from '@pkg/entities';
import {
  ExtractedProject,
  ExtractedTask,
  ExtractedCommitment,
  ExtractedFact,
  InferredRelation,
} from './daily-synthesis-extraction.types';
import { ProjectMatchingService } from './project-matching.service';
import { ClientResolutionService } from './client-resolution.service';
import { ActivityMemberService } from '../activity/activity-member.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { FactDedupReviewService, ReviewCandidate } from './fact-dedup-review.service';
import { EntityRelationService } from '../entity/entity-relation/entity-relation.service';
import { ActivityService } from '../activity/activity.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { SettingsService } from '../settings/settings.service';
import { FactFusionService } from '../entity/entity-fact/fact-fusion.service';
import { FusionAction } from '../entity/entity-fact/fact-fusion.constants';
import { ExtractionFusionAction } from './fusion-action.enum';
import { CreateFactDto } from '../entity/dto/create-entity.dto';
import { CreateFactResult } from '../entity/entity-fact/entity-fact.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

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
  /** Inferred relations to persist */
  inferredRelations?: InferredRelation[];
  /** Source interaction ID for tracking */
  sourceInteractionId?: string;
  /** Message reference for Telegram updates */
  messageRef?: string;
  /** Optional: synthesis date for metadata */
  synthesisDate?: string;
  /** Optional: focus topic for metadata */
  focusTopic?: string;
  /** Optional: TopicalSegment ID for knowledge traceability */
  sourceSegmentId?: string;
}

/**
 * Detail record for a single Smart Fusion action applied during extraction.
 */
export interface FusionActionDetail {
  /** The extraction-level fusion action (confirm, supersede, enrich, conflict, coexist) */
  action: ExtractionFusionAction;
  /** Entity ID the fact belongs to */
  entityId: string;
  /** Fact type (e.g., "position", "company") */
  factType: string;
  /** New value from extraction */
  newValue: string;
  /** Existing fact ID that triggered fusion */
  existingFactId: string;
  /** Result fact ID (may differ from existingFactId for SUPERSEDE/COEXIST) */
  resultFactId?: string;
  /** Explanation from LLM fusion decision */
  reason: string;
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
    relations: number;
  };
  /** Count of items skipped due to deduplication */
  skipped: {
    facts: number;
    projects: number;
    tasks: number;
    commitments: number;
    relations: number;
  };
  /** Items that failed to create */
  errors: Array<{ item: string; error: string }>;
  /** Smart Fusion actions applied (CONFIRM, SUPERSEDE, ENRICH, CONFLICT, COEXIST) */
  fusionActions: FusionActionDetail[];
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
 * Smart Fusion: When dedup detects a potential duplicate, routes through
 * FactFusionService for intelligent resolution (CONFIRM/SUPERSEDE/ENRICH/
 * CONFLICT/COEXIST) instead of simple skip.
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
    @Optional()
    @Inject(forwardRef(() => EmbeddingService))
    private readonly embeddingService: EmbeddingService | null,
    @Optional()
    @Inject(forwardRef(() => EntityRelationService))
    private readonly entityRelationService: EntityRelationService | null,
    @Optional()
    @Inject(forwardRef(() => ActivityService))
    private readonly activityService: ActivityService | null,
    @Optional()
    @Inject(forwardRef(() => FactFusionService))
    private readonly factFusionService: FactFusionService | null,
    @Optional()
    @Inject(forwardRef(() => ClaudeAgentService))
    private readonly claudeAgentService: ClaudeAgentService | null,
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
   * SMART FUSION: When dedup finds a potential duplicate with an existing fact,
   * we route through FactFusionService for LLM-based resolution instead of
   * simple skip. This enables CONFIRM, SUPERSEDE, ENRICH, CONFLICT, COEXIST.
   *
   * @see https://github.com/typeorm/typeorm/issues/9658
   * @see https://github.com/typeorm/typeorm/issues/11302
   */
  async createDrafts(input: DraftExtractionInput): Promise<DraftExtractionResult> {
    const batchId = randomUUID();
    const result: DraftExtractionResult = {
      batchId,
      approvals: [],
      counts: { facts: 0, projects: 0, tasks: 0, commitments: 0, relations: 0 },
      skipped: { facts: 0, projects: 0, tasks: 0, commitments: 0, relations: 0 },
      errors: [],
      fusionActions: [],
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
        } else if (dedupResult.existingFactId && this.factFusionService) {
          // Smart Fusion: route through FactFusionService for intelligent resolution
          try {
            const fusionDetail = await this.applySmartFusion(
              fact,
              dedupResult.existingFactId,
              result,
            );
            if (fusionDetail) {
              result.fusionActions.push(fusionDetail);
            }
          } catch (fusionError) {
            const msg = fusionError instanceof Error ? fusionError.message : 'Unknown';
            this.logger.warn(
              `Smart fusion failed for "${fact.factType}:${fact.value}", falling back to skip: ${msg}`,
            );
            result.skipped.facts++;
          }
        } else {
          // skip, update, supersede — auto-skip (no fusion service or no existing fact ID)
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
        } else if (candidate.matchedFactId && this.factFusionService) {
          // Smart Fusion for grey-zone candidates that LLM decided to skip
          try {
            const fusionDetail = await this.applySmartFusion(
              candidate.newFact,
              candidate.matchedFactId,
              result,
            );
            if (fusionDetail) {
              result.fusionActions.push(fusionDetail);
            }
          } catch (fusionError) {
            const msg = fusionError instanceof Error ? fusionError.message : 'Unknown';
            this.logger.warn(
              `Smart fusion failed for grey-zone "${candidate.newFact.factType}:${candidate.newFact.value}", falling back to skip: ${msg}`,
            );
            result.skipped.facts++;
          }
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
    let projectDedupStrong = 0;
    let projectDedupPending = 0;
    let projectDedupWeak = 0;
    let projectDedupCreated = 0;
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
        // Client boost: passing client name lowers strong threshold from 0.8 to 0.7
        // Description + tags boosts: help resolve grey zone matches
        const existing = await this.findExistingProjectEnhanced(
          project.name,
          input.ownerEntityId,
          project.client,
          project.description,
          project.tags,
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
          if (existing.source === 'pending_approval') projectDedupPending++;
          else projectDedupStrong++;

          // Enrich existing activity with new extraction data (fill empty fields only)
          if (this.activityService) {
            try {
              await this.activityService.enrichActivity(existing.activityId, {
                description: project.description,
                tags: project.tags,
                deadline: project.deadline ? new Date(project.deadline) : undefined,
                priority: project.priority,
              });
            } catch (enrichError) {
              this.logger.warn(
                `Failed to enrich activity ${existing.activityId}: ${enrichError instanceof Error ? enrichError.message : 'Unknown'}`,
              );
            }
          }

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
        projectDedupCreated++;
        if (existing.weakMatch) projectDedupWeak++;
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

    if (input.projects.length > 0) {
      this.logger.log(
        `[ProjectDedup] Summary: total=${input.projects.length}, ` +
          `skipped=${projectDedupStrong + projectDedupPending} (strong=${projectDedupStrong}, pending=${projectDedupPending}), ` +
          `created=${projectDedupCreated}, weak=${projectDedupWeak}`,
      );
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

          // Re-link: if duplicate has no parent but new task has projectName, resolve and update
          if (
            existingTask.activityId &&
            existingTask.parentId == null &&
            task.projectName
          ) {
            let resolvedParentId: string | undefined;
            resolvedParentId = projectMap.get(
              ProjectMatchingService.normalizeName(task.projectName),
            );
            if (!resolvedParentId) {
              const fuzzyMatch = await this.findExistingProjectEnhanced(
                task.projectName,
                input.ownerEntityId,
              );
              if (fuzzyMatch.found && fuzzyMatch.activityId) {
                resolvedParentId = fuzzyMatch.activityId;
              }
            }
            if (!resolvedParentId && this.activityService) {
              const mentionMatch = await this.activityService.findByMention(
                task.projectName,
              );
              if (mentionMatch) resolvedParentId = mentionMatch.id;
            }
            if (resolvedParentId) {
              await this.activityRepo
                .createQueryBuilder()
                .update()
                .set({ parentId: resolvedParentId })
                .where('id = :id', { id: existingTask.activityId })
                .execute();
              this.logger.log(
                `Re-linked duplicate task "${task.title}" (${existingTask.activityId}) ` +
                  `to project ${resolvedParentId} via projectName="${task.projectName}"`,
              );
            }
          }

          result.skipped.tasks++;
          continue;
        }

        // SEMANTIC DEDUP: Embedding-based cosine similarity check (after Levenshtein)
        let taskEmbedding: number[] | undefined;
        try {
          if (this.embeddingService) {
            taskEmbedding = await this.embeddingService.generate(task.title);

            if (taskEmbedding) {
              const similar = await this.activityRepo
                .createQueryBuilder('a')
                .select(['a.id', 'a.name'])
                .addSelect(`a.embedding <=> :emb`, 'distance')
                .where('a.embedding IS NOT NULL')
                .andWhere('a.activityType = :type', { type: ActivityType.TASK })
                .andWhere('a.ownerEntityId = :owner', { owner: input.ownerEntityId })
                .andWhere('a.status NOT IN (:...excluded)', {
                  excluded: [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED],
                })
                .setParameter('emb', `[${taskEmbedding.join(',')}]`)
                .orderBy('distance', 'ASC')
                .limit(1)
                .getRawOne();

              if (similar && 1 - similar.distance >= DraftExtractionService.SEMANTIC_DEDUP_THRESHOLD) {
                result.skipped.tasks++;
                this.logger.log(
                  `[SemanticDedup] Task "${task.title}" is semantic duplicate of "${similar.a_name}" ` +
                    `(cosine: ${(1 - similar.distance).toFixed(3)})`,
                );
                continue;
              }
            }
          }
        } catch (embError) {
          this.logger.warn(
            `[SemanticDedup] Embedding generation failed for task "${task.title}", ` +
              `proceeding without semantic dedup: ${embError instanceof Error ? embError.message : 'Unknown'}`,
          );
        }

        let parentId = task.projectName
          ? projectMap.get(ProjectMatchingService.normalizeName(task.projectName))
          : undefined;
        // Fallback: fuzzy match against existing activities (for unified extraction path)
        if (!parentId && task.projectName) {
          const fuzzyMatch = await this.findExistingProjectEnhanced(
            task.projectName,
            input.ownerEntityId,
          );
          if (fuzzyMatch.found && fuzzyMatch.activityId) {
            parentId = fuzzyMatch.activityId;
          }
        }
        // 3rd fallback: substring match via ActivityService.findByMention()
        if (!parentId && task.projectName && this.activityService) {
          const mentionMatch = await this.activityService.findByMention(
            task.projectName,
          );
          if (mentionMatch) {
            parentId = mentionMatch.id;
            this.logger.debug(
              `Linked task "${task.title}" to activity "${mentionMatch.name}" via mention match`,
            );
          }
        }
        if (!parentId && task.projectName) {
          this.logger.warn(
            `Task "${task.title}" references project "${task.projectName}" ` +
              `but no matching activity found (batch/fuzzy/mention all failed)`,
          );
        }

        const { activity, approval } = await this.createDraftTask(
          task,
          input,
          batchId,
          parentId,
          taskEmbedding,
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
        // DEDUPLICATION: Check pending approvals + fuzzy match against active commitments
        const existingCommitment = await this.findExistingCommitmentEnhanced(
          commitment.what,
          input.ownerEntityId,
        );
        if (existingCommitment.found) {
          this.logger.debug(
            `Skipping duplicate commitment "${commitment.what}" - ` +
              `matched via ${existingCommitment.source} (id: ${existingCommitment.commitmentId}, ` +
              `similarity: ${existingCommitment.similarity?.toFixed(3) ?? 'exact'})`,
          );
          result.skipped.commitments++;
          continue;
        }

        // SEMANTIC DEDUP: Embedding-based cosine similarity check (after Levenshtein)
        const commitmentEmbeddingText =
          commitment.what +
          (commitment.from ? ` от ${commitment.from}` : '') +
          (commitment.to ? ` для ${commitment.to}` : '');
        let commitmentEmbedding: number[] | undefined;
        try {
          if (this.embeddingService) {
            commitmentEmbedding = await this.embeddingService.generate(commitmentEmbeddingText);

            if (commitmentEmbedding) {
              const similar = await this.commitmentRepo
                .createQueryBuilder('c')
                .select(['c.id', 'c.title'])
                .addSelect(`c.embedding <=> :emb`, 'distance')
                .where('c.embedding IS NOT NULL')
                .andWhere('c.status NOT IN (:...excluded)', {
                  excluded: [CommitmentStatus.COMPLETED, CommitmentStatus.CANCELLED],
                })
                .setParameter('emb', `[${commitmentEmbedding.join(',')}]`)
                .orderBy('distance', 'ASC')
                .limit(1)
                .getRawOne();

              if (similar && 1 - similar.distance >= DraftExtractionService.SEMANTIC_DEDUP_THRESHOLD) {
                result.skipped.commitments++;
                this.logger.log(
                  `[SemanticDedup] Commitment "${commitment.what}" is semantic duplicate of "${similar.c_title}" ` +
                    `(cosine: ${(1 - similar.distance).toFixed(3)})`,
                );
                continue;
              }
            }
          }
        } catch (embError) {
          this.logger.warn(
            `[SemanticDedup] Embedding generation failed for commitment "${commitment.what}", ` +
              `proceeding without semantic dedup: ${embError instanceof Error ? embError.message : 'Unknown'}`,
          );
        }

        // Resolve activityId from projectMap or fuzzy match for commitment
        let commitmentActivityId: string | undefined;
        if (commitment.projectName) {
          // 1st: exact match in current batch's projectMap
          commitmentActivityId = projectMap.get(
            ProjectMatchingService.normalizeName(commitment.projectName),
          );
          // 2nd: fuzzy match against existing activities (two-tier Levenshtein)
          if (!commitmentActivityId) {
            const fuzzyMatch = await this.findExistingProjectEnhanced(
              commitment.projectName,
              input.ownerEntityId,
            );
            if (fuzzyMatch.found && fuzzyMatch.activityId) {
              commitmentActivityId = fuzzyMatch.activityId;
            }
          }
          // 3rd: substring match via ActivityService.findByMention()
          if (!commitmentActivityId && this.activityService) {
            const mentionMatch = await this.activityService.findByMention(
              commitment.projectName,
            );
            if (mentionMatch) {
              commitmentActivityId = mentionMatch.id;
              this.logger.debug(
                `Linked commitment "${commitment.what}" to activity "${mentionMatch.name}" via mention match`,
              );
            }
          }
          // Log unlinked commitments for debugging
          if (!commitmentActivityId) {
            this.logger.warn(
              `Commitment "${commitment.what}" references project "${commitment.projectName}" ` +
                `but no matching activity found (batch/fuzzy/mention all failed)`,
            );
          }
        }

        const { entity, approval } = await this.createDraftCommitment(
          commitment,
          input,
          batchId,
          commitmentActivityId,
          commitmentEmbedding,
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

    // 4. Create relations from inferred relations
    if (input.inferredRelations?.length) {
      await this.createDraftRelations(input.inferredRelations, input.ownerEntityId, result);
    }

    const totalSkipped =
      result.skipped.facts +
      result.skipped.projects +
      result.skipped.tasks +
      result.skipped.commitments +
      result.skipped.relations;
    const fusionSummary = this.summarizeFusionActions(result.fusionActions);
    this.logger.log(
      `Draft extraction complete (batch=${batchId}): ` +
        `${result.counts.facts} facts, ${result.counts.projects} projects, ` +
        `${result.counts.tasks} tasks, ${result.counts.commitments} commitments, ` +
        `${result.counts.relations} relations ` +
        `(${totalSkipped} skipped as duplicates, ${result.errors.length} errors)` +
        fusionSummary,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Smart Fusion Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Apply Smart Fusion for a fact that has a matching existing fact.
   *
   * Loads the existing fact, calls FactFusionService.decideFusion() for
   * LLM-based resolution, then applies the decision via applyDecision().
   *
   * @returns FusionActionDetail if fusion was applied, null otherwise
   */
  private async applySmartFusion(
    fact: ExtractedFact,
    existingFactId: string,
    result: DraftExtractionResult,
  ): Promise<FusionActionDetail | null> {
    const existingFact = await this.factRepo.findOne({ where: { id: existingFactId } });
    if (!existingFact) {
      this.logger.warn(
        `Smart fusion: existing fact ${existingFactId} not found, skipping`,
      );
      result.skipped.facts++;
      return null;
    }

    // Ask LLM for fusion decision
    const decision = await this.factFusionService!.decideFusion(
      existingFact,
      fact.value,
      FactSource.EXTRACTED,
    );

    // Build CreateFactDto for applyDecision
    const newFactDto: CreateFactDto = {
      type: fact.factType as FactType,
      category: this.inferFactCategory(fact.factType),
      value: fact.value,
      source: FactSource.EXTRACTED,
      confidence: fact.confidence,
    };

    // Apply the decision
    const applyResult = await this.factFusionService!.applyDecision(
      existingFact,
      newFactDto,
      decision,
      fact.entityId,
    );

    this.logger.log(
      `[SmartFusion] ${decision.action} for "${fact.factType}:${fact.value}" ` +
        `(existing: ${existingFactId}) → result: ${applyResult.action}, reason: ${decision.explanation}`,
    );

    return this.mapFusionToDetail(fact, existingFactId, decision, applyResult, result);
  }

  /**
   * Map a FactFusionService decision to a FusionActionDetail record
   * and update the result counters accordingly.
   */
  private mapFusionToDetail(
    fact: ExtractedFact,
    existingFactId: string,
    decision: { action: FusionAction; explanation: string },
    applyResult: CreateFactResult,
    result: DraftExtractionResult,
  ): FusionActionDetail {
    // Map FusionAction → ExtractionFusionAction
    const actionMap: Record<FusionAction, ExtractionFusionAction> = {
      [FusionAction.CONFIRM]: ExtractionFusionAction.CONFIRM,
      [FusionAction.ENRICH]: ExtractionFusionAction.ENRICH,
      [FusionAction.SUPERSEDE]: ExtractionFusionAction.SUPERSEDE,
      [FusionAction.COEXIST]: ExtractionFusionAction.COEXIST,
      [FusionAction.CONFLICT]: ExtractionFusionAction.CONFLICT,
    };

    const extractionAction = actionMap[decision.action] ?? ExtractionFusionAction.SKIP;

    // Update counters: CONFIRM/ENRICH/CONFLICT count as "skipped" (no new draft),
    // SUPERSEDE/COEXIST count as "created" (new fact was made)
    switch (decision.action) {
      case FusionAction.CONFIRM:
      case FusionAction.ENRICH:
      case FusionAction.CONFLICT:
        result.skipped.facts++;
        break;
      case FusionAction.SUPERSEDE:
      case FusionAction.COEXIST:
        result.counts.facts++;
        break;
    }

    return {
      action: extractionAction,
      entityId: fact.entityId,
      factType: fact.factType,
      newValue: fact.value,
      existingFactId,
      resultFactId: applyResult.fact?.id !== existingFactId ? applyResult.fact?.id : undefined,
      reason: decision.explanation,
    };
  }

  /**
   * Generate a compact summary string of fusion actions for logging.
   * Returns empty string if no fusion actions occurred.
   */
  private summarizeFusionActions(actions: FusionActionDetail[]): string {
    if (actions.length === 0) return '';

    const counts: Record<string, number> = {};
    for (const a of actions) {
      counts[a.action] = (counts[a.action] || 0) + 1;
    }

    const parts = Object.entries(counts)
      .map(([action, count]) => `${action}=${count}`)
      .join(', ');

    return ` | fusion: ${parts}`;
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
      sourceSegmentId: input.sourceSegmentId ?? null,
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
      sourceEntityId: fact.entityId ?? null,
      context: `${fact.factType}: ${fact.value}`,
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
        sourceSegmentId: input.sourceSegmentId ?? null,
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
      sourceEntityId: input.ownerEntityId ?? null,
      context: `Проект: ${project.name}`,
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
    embedding?: number[],
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
        sourceSegmentId: input.sourceSegmentId ?? null,
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

    // Save embedding for future semantic dedup searches (raw SQL for vector type)
    if (embedding) {
      await this.activityRepo.query(
        `UPDATE activities SET embedding = $1::vector WHERE id = $2`,
        [`[${embedding.join(',')}]`, activityId],
      );
    }

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
      sourceEntityId: input.ownerEntityId ?? null,
      context: `Задача: ${task.title}`,
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
    embedding?: number[],
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
      sourceSegmentId: input.sourceSegmentId ?? null,
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

    // Save embedding for future semantic dedup searches (raw SQL for vector type)
    if (embedding) {
      await this.commitmentRepo.query(
        `UPDATE commitments SET embedding = $1::vector WHERE id = $2`,
        [`[${embedding.join(',')}]`, savedEntity.id],
      );
    }

    // Create PendingApproval linking to the draft
    const approval = this.approvalRepo.create({
      itemType: PendingApprovalItemType.COMMITMENT,
      targetId: savedEntity.id,
      batchId,
      confidence: commitment.confidence ?? 0.8,
      sourceQuote: commitment.sourceQuote,
      sourceInteractionId: input.sourceInteractionId ?? null,
      messageRef: input.messageRef ?? null,
      sourceEntityId: input.ownerEntityId ?? null,
      context: `Обещание: ${commitment.what}`,
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
    clientName?: string,
    description?: string,
    tags?: string[],
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
      this.logger.log(
        `[ProjectDedup] "${projectName}" → decision=skip, ` +
          `similarity=1.000, descBoost=false, tagsBoost=false, ` +
          `matchedActivity=pending:${pendingMatch.targetId}, source=pending_approval`,
      );
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
      // Client boost: lower strong threshold from 0.8 to 0.7 when client matches
      let effectiveStrongThreshold = DraftExtractionService.STRONG_MATCH_THRESHOLD;
      if (clientName && matchResult.activity.clientEntityId) {
        const clientEntity = await this.entityRepo.findOne({
          where: { id: matchResult.activity.clientEntityId },
          select: ['id', 'name'],
        });
        if (clientEntity) {
          const clientSimilarity = this.projectMatchingService.calculateSimilarity(
            ProjectMatchingService.normalizeName(clientName),
            ProjectMatchingService.normalizeName(clientEntity.name),
          );
          if (clientSimilarity >= 0.7) {
            effectiveStrongThreshold = DraftExtractionService.STRONG_MATCH_THRESHOLD - 0.1;
            this.logger.debug(
              `Client boost: "${clientName}" ~ "${clientEntity.name}" (similarity: ${clientSimilarity.toFixed(3)}) → threshold lowered to ${effectiveStrongThreshold}`,
            );
          }
        }
      }

      // Tags overlap boost: add bonus to similarity score when tags overlap
      let tagsBoost = 0;
      const existingTags = matchResult.activity.tags;
      if (tags?.length && existingTags?.length) {
        const newSet = new Set(tags.map((t) => t.toLowerCase()));
        const existingSet = new Set(existingTags.map((t) => t.toLowerCase()));
        const intersection = [...newSet].filter((t) => existingSet.has(t));
        const union = new Set([...newSet, ...existingSet]);
        const jaccard = intersection.length / union.size;
        if (jaccard >= 0.3) {
          tagsBoost = 0.05;
        }
      }

      const boostedSimilarity = matchResult.similarity + tagsBoost;

      // Strong match (>= threshold): skip creation
      if (boostedSimilarity >= effectiveStrongThreshold) {
        const source =
          effectiveStrongThreshold !== DraftExtractionService.STRONG_MATCH_THRESHOLD
            ? 'fuzzy_match_client_boosted'
            : tagsBoost > 0
              ? 'fuzzy_match_tags_boosted'
              : 'fuzzy_match';
        this.logger.log(
          `[ProjectDedup] "${projectName}" → decision=skip, ` +
            `similarity=${boostedSimilarity.toFixed(3)}, descBoost=false, tagsBoost=${tagsBoost > 0}, ` +
            `matchedActivity="${matchResult.activity.name}", source=${source}`,
        );
        return {
          found: true,
          activityId: matchResult.activity.id,
          similarity: boostedSimilarity,
          source,
        };
      }

      // Grey zone (0.6-effectiveStrongThreshold): try description similarity boost
      let descBoost = false;
      if (
        boostedSimilarity >= DraftExtractionService.WEAK_MATCH_THRESHOLD &&
        boostedSimilarity < effectiveStrongThreshold &&
        description &&
        matchResult.activity.description
      ) {
        const descSimilarity = this.projectMatchingService.calculateSimilarity(
          ProjectMatchingService.normalizeName(description),
          ProjectMatchingService.normalizeName(matchResult.activity.description),
        );
        if (descSimilarity >= 0.5) {
          descBoost = true;
          this.logger.log(
            `[ProjectDedup] "${projectName}" → decision=skip, ` +
              `similarity=${boostedSimilarity.toFixed(3)}, descBoost=true (descSim=${descSimilarity.toFixed(3)}), tagsBoost=${tagsBoost > 0}, ` +
              `matchedActivity="${matchResult.activity.name}", source=fuzzy_match_description_boosted`,
          );
          return {
            found: true,
            activityId: matchResult.activity.id,
            similarity: boostedSimilarity,
            source: 'fuzzy_match_description_boosted',
          };
        }
      }

      // Weak match (0.6-threshold): create but flag as possible duplicate
      this.logger.log(
        `[ProjectDedup] "${projectName}" → decision=create_with_flag, ` +
          `similarity=${boostedSimilarity.toFixed(3)}, descBoost=false, tagsBoost=${tagsBoost > 0}, ` +
          `matchedActivity="${matchResult.activity.name}", source=weak_match`,
      );
      return {
        found: false,
        weakMatch: {
          matchedActivityId: matchResult.activity.id,
          matchedName: matchResult.activity.name,
          similarity: boostedSimilarity,
        },
      };
    }

    // Step 3: LLM fallback — handles cross-script (Latin/Cyrillic), abbreviations, synonyms
    if (this.claudeAgentService) {
      const llmMatch = await this.llmMatchProjectName(projectName, ownerEntityId);
      if (llmMatch) {
        this.logger.log(
          `[ProjectDedup] "${projectName}" → decision=skip, ` +
            `similarity=1.000, descBoost=false, tagsBoost=false, ` +
            `matchedActivity="${llmMatch.name}" [${llmMatch.id}], source=llm_match`,
        );
        return {
          found: true,
          activityId: llmMatch.id,
          similarity: 1.0,
          source: 'llm_match',
        };
      }
    }

    // No match found
    this.logger.log(
      `[ProjectDedup] "${projectName}" → decision=create, ` +
        `similarity=0.000, descBoost=false, tagsBoost=false, ` +
        `matchedActivity=none, source=no_match`,
    );
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
  ): Promise<{ found: boolean; activityId?: string; parentId?: string | null; similarity?: number; source?: string }> {
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
      select: ['id', 'name', 'parentId'],
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
        parentId: bestMatch.activity.parentId ?? null,
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

  /**
   * Enhanced commitment dedup: pending ILIKE + fuzzy Levenshtein against active commitments.
   * Mirrors findExistingTaskEnhanced() pattern.
   */
  private async findExistingCommitmentEnhanced(
    what: string,
    entityId?: string,
  ): Promise<{ found: boolean; commitmentId?: string; similarity?: number; source?: string }> {
    // Step 1: Pending ILIKE (existing exact logic)
    const pendingMatch = await this.findExistingPendingCommitment(what);
    if (pendingMatch) {
      return { found: true, commitmentId: pendingMatch.targetId, source: 'pending_approval' };
    }

    // Step 2: Fuzzy Levenshtein against active commitments
    if (!entityId) return { found: false };

    const candidates = await this.commitmentRepo.find({
      where: {
        status: In([CommitmentStatus.PENDING, CommitmentStatus.IN_PROGRESS]),
      },
      select: ['id', 'title'],
      take: 100,
    });

    if (candidates.length === 0) return { found: false };

    const normalizedWhat = ProjectMatchingService.normalizeName(what);
    let bestMatch: { commitment: Commitment; similarity: number } | null = null;

    for (const c of candidates) {
      const similarity = this.projectMatchingService.calculateSimilarity(
        normalizedWhat,
        ProjectMatchingService.normalizeName(c.title),
      );
      if (
        similarity >= DraftExtractionService.COMMITMENT_DEDUP_THRESHOLD &&
        (!bestMatch || similarity > bestMatch.similarity)
      ) {
        bestMatch = { commitment: c, similarity };
      }
    }

    if (bestMatch) {
      this.logger.log(
        `Fuzzy matched commitment "${what}" -> "${bestMatch.commitment.title}" ` +
          `(similarity: ${bestMatch.similarity.toFixed(3)})`,
      );
      return {
        found: true,
        commitmentId: bestMatch.commitment.id,
        similarity: bestMatch.similarity,
        source: 'fuzzy_match',
      };
    }

    return { found: false };
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Relation Creation
  // ─────────────────────────────────────────────────────────────

  /**
   * Create EntityRelation records from inferred relations.
   *
   * For each InferredRelation:
   * 1. Map relation type → RelationType + roles
   * 2. Resolve entity names → entity IDs
   * 3. Check for duplicate (EntityRelationService handles this)
   * 4. Create EntityRelation + EntityRelationMember records
   */
  private async createDraftRelations(
    inferredRelations: InferredRelation[],
    ownerEntityId: string,
    result: DraftExtractionResult,
  ): Promise<void> {
    if (!this.entityRelationService) {
      this.logger.warn('EntityRelationService not available, skipping relation creation');
      return;
    }

    for (const rel of inferredRelations) {
      try {
        if (!rel.entities?.length || rel.entities.length < 2) {
          this.logger.debug(
            `Skipping relation "${rel.type}" — need at least 2 entities, got ${rel.entities?.length ?? 0}`,
          );
          result.skipped.relations++;
          continue;
        }

        if (rel.confidence < 0.5) {
          this.logger.debug(
            `Skipping low-confidence relation "${rel.type}" (${rel.confidence})`,
          );
          result.skipped.relations++;
          continue;
        }

        // Map InferredRelation type → RelationType + role assignments
        const mapping = this.mapInferredRelationType(rel.type);
        if (!mapping) {
          this.logger.debug(`Unknown inferred relation type: "${rel.type}", skipping`);
          result.skipped.relations++;
          continue;
        }

        // Resolve entity names → IDs
        const resolvedEntities: Array<{ entityId: string; name: string }> = [];
        for (const entityName of rel.entities) {
          const entity = await this.findEntityByName(entityName);
          if (entity) {
            resolvedEntities.push({ entityId: entity.id, name: entity.name });
          } else {
            this.logger.debug(
              `Could not resolve entity "${entityName}" for relation "${rel.type}", skipping entity`,
            );
          }
        }

        if (resolvedEntities.length < 2) {
          this.logger.debug(
            `Only ${resolvedEntities.length} entity resolved for relation "${rel.type}" ` +
              `(need 2+), entities: [${rel.entities.join(', ')}]`,
          );
          result.skipped.relations++;
          continue;
        }

        // Create pair-wise relations for 2+ entities
        // (most common case: exactly 2 entities)
        const members = resolvedEntities.map((e, idx) => ({
          entityId: e.entityId,
          role: mapping.roles[Math.min(idx, mapping.roles.length - 1)],
          label: e.name,
        }));

        // EntityRelationService.create() handles deduplication internally
        await this.entityRelationService.create({
          relationType: mapping.relationType,
          members,
          source: RelationSource.INFERRED,
          confidence: rel.confidence,
          metadata: {
            inferredFrom: 'daily_synthesis',
            activityName: rel.activityName,
          },
        });

        result.counts.relations++;
        this.logger.debug(
          `Created relation ${mapping.relationType}: [${resolvedEntities.map((e) => e.name).join(', ')}]` +
            (rel.activityName ? ` (activity: ${rel.activityName})` : ''),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({
          item: `relation:${rel.type}:[${rel.entities.join(',')}]`,
          error: message,
        });
        this.logger.error(
          `Failed to create relation "${rel.type}" for [${rel.entities.join(', ')}]: ${message}`,
        );
      }
    }
  }

  /**
   * Map InferredRelation.type to RelationType + role names.
   */
  private mapInferredRelationType(
    type: string,
  ): { relationType: RelationType; roles: string[] } | null {
    switch (type) {
      case 'project_member':
      case 'works_on':
        return { relationType: RelationType.TEAM, roles: ['member', 'member'] };
      case 'client_of':
        return { relationType: RelationType.CLIENT_VENDOR, roles: ['client', 'vendor'] };
      case 'responsible_for':
        return { relationType: RelationType.REPORTING, roles: ['manager', 'subordinate'] };
      default:
        return null;
    }
  }

  /**
   * Find entity by name (case-insensitive ILIKE search).
   * Returns the most recently updated match.
   */
  private async findEntityByName(name: string): Promise<EntityRecord | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const escaped = trimmed.replace(/[%_\\]/g, '\\$&');
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :pattern', { pattern: `%${escaped}%` })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();
  }

  // ─────────────────────────────────────────────────────────────
  // Private: LLM-based Project Name Matching
  // ─────────────────────────────────────────────────────────────

  private static readonly LLM_MATCH_SCHEMA = {
    type: 'object',
    properties: {
      matchedIndex: {
        type: ['integer', 'null'],
        description: 'Zero-based index of matched project, or null if no match',
      },
      reason: {
        type: 'string',
        description: 'Brief explanation',
      },
    },
    required: ['matchedIndex', 'reason'],
  };

  /**
   * Use LLM to match a project name against existing activities.
   * Handles cross-script (Latin↔Cyrillic), abbreviations, synonyms.
   * Called only when heuristic matching returns similarity ≈ 0.
   */
  private async llmMatchProjectName(
    projectName: string,
    ownerEntityId: string,
  ): Promise<{ id: string; name: string } | null> {
    try {
      // Load candidate activities (same query as ProjectMatchingService)
      const activities = await this.activityRepo.find({
        where: {
          ownerEntityId,
          activityType: In([
            ActivityType.PROJECT,
            ActivityType.TASK,
            ActivityType.INITIATIVE,
            ActivityType.BUSINESS,
            ActivityType.AREA,
          ]),
          status: Not(In([ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED])),
        },
        select: ['id', 'name'],
        order: { lastActivityAt: { direction: 'DESC', nulls: 'LAST' } },
        take: 50,
      });

      if (activities.length === 0) return null;

      // Normalize input to strip metadata annotations like "(клиент: ...)"
      const normalizedInput = ProjectMatchingService.normalizeName(projectName);

      const activityList = activities
        .map((a, i) => `${i}. ${a.name}`)
        .join('\n');

      const prompt =
        `Имя проекта из извлечения: "${normalizedInput}"\n\n` +
        `Существующие проекты:\n${activityList}\n\n` +
        `Указывает ли "${projectName}" на один из существующих проектов? ` +
        `Учитывай транслитерацию (Panavto=Панавто), сокращения, синонимы. ` +
        `Если да — верни matchedIndex (номер строки). Если нет — верни null.`;

      const { data } = await this.claudeAgentService!.call<{
        matchedIndex: number | null;
        reason: string;
      }>({
        mode: 'oneshot',
        taskType: 'project_name_match',
        prompt,
        schema: DraftExtractionService.LLM_MATCH_SCHEMA,
        model: 'haiku',
      });

      if (data?.matchedIndex != null && data.matchedIndex >= 0 && data.matchedIndex < activities.length) {
        const matched = activities[data.matchedIndex];
        this.logger.log(
          `[ProjectDedup] LLM matched "${projectName}" → "${matched.name}" (reason: ${data.reason})`,
        );
        return { id: matched.id, name: matched.name };
      }

      this.logger.debug(
        `[ProjectDedup] LLM found no match for "${projectName}" (reason: ${data?.reason ?? 'no response'})`,
      );
      return null;
    } catch (error) {
      this.logger.warn(
        `[ProjectDedup] LLM match failed for "${projectName}": ${(error as Error).message}`,
      );
      return null;
    }
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
  /** Commitment dedup threshold — skip creation if existing commitment is similar enough */
  private static readonly COMMITMENT_DEDUP_THRESHOLD = 0.7;
  /** Semantic dedup threshold — skip if cosine similarity >= this value */
  private static readonly SEMANTIC_DEDUP_THRESHOLD = 0.85;


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
