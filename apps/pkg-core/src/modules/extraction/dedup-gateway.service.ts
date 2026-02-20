import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType, ActivityStatus, EntityRecord } from '@pkg/entities';
import { EmbeddingService } from '../embedding/embedding.service';
import { ProjectMatchingService } from './project-matching.service';
import { LlmDedupService, DedupPair } from './llm-dedup.service';

// --- Constants ---

/** Minimum cosine similarity for pgvector candidate retrieval */
const COSINE_THRESHOLD = 0.5;

/** Maximum number of candidates to consider */
const TOP_K = 5;

/** Confidence threshold for automatic merge (no user confirmation needed) */
const AUTO_MERGE_CONFIDENCE = 0.9;

/** Confidence threshold for pending approval (user must confirm) */
const APPROVAL_CONFIDENCE = 0.7;

// --- Exported types ---

export enum DedupAction {
  CREATE = 'create',
  MERGE = 'merge',
  PENDING_APPROVAL = 'pending_approval',
}

export interface DedupDecision {
  action: DedupAction;
  existingId?: string;
  confidence: number;
  reason: string;
}

export interface TaskCandidate {
  name: string;
  ownerEntityId: string;
  description?: string;
  projectName?: string;
}

export interface EntityCandidate {
  name: string;
  type: string; // 'person' | 'organization'
  context?: string;
}

export interface CommitmentCandidate {
  what: string;
  entityId?: string;
  activityContext?: string;
}

// --- Service ---

@Injectable()
export class DeduplicationGatewayService {
  private readonly logger = new Logger(DeduplicationGatewayService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
    private readonly projectMatchingService: ProjectMatchingService,
    private readonly llmDedupService: LlmDedupService,
    @Optional()
    private readonly embeddingService: EmbeddingService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /**
   * Check whether a task (Activity of type TASK) is a duplicate.
   *
   * Algorithm:
   * 1. Normalize name
   * 2. Exact match (LOWER(name)) -> MERGE
   * 3. Generate embedding -> pgvector cosine >= 0.5, top-5
   * 4. LLM decision for top candidate
   * 5. Route by confidence: >=0.9 MERGE, 0.7-0.9 PENDING_APPROVAL, <0.7 CREATE
   */
  async checkTask(candidate: TaskCandidate): Promise<DedupDecision> {
    const normalized = ProjectMatchingService.normalizeName(candidate.name);

    if (!normalized) {
      return this.createDecision('Empty name after normalization');
    }

    // Step 1: Exact match by normalized name
    const exactMatch = await this.findExactTaskMatch(
      normalized,
      candidate.ownerEntityId,
    );

    if (exactMatch) {
      this.logger.log(
        `Exact task match: "${candidate.name}" -> "${exactMatch.name}" [${exactMatch.id}]`,
      );
      return {
        action: DedupAction.MERGE,
        existingId: exactMatch.id,
        confidence: 1.0,
        reason: `Exact name match: "${exactMatch.name}"`,
      };
    }

    // Step 2: Semantic search via pgvector embeddings
    const semanticCandidates = await this.findSemanticTaskCandidates(
      normalized,
      candidate.ownerEntityId,
      candidate.description,
    );

    if (semanticCandidates.length === 0) {
      this.logger.debug(
        `No semantic candidates for task "${candidate.name}", creating new`,
      );
      return this.createDecision('No similar tasks found');
    }

    // Step 3: LLM decision for the top candidate
    const topCandidate = semanticCandidates[0];

    const pair: DedupPair = {
      newItem: {
        type: 'task',
        name: candidate.name,
        description: candidate.description,
      },
      existingItem: {
        id: topCandidate.id,
        type: 'task',
        name: topCandidate.name,
        description: topCandidate.description ?? undefined,
      },
      activityContext: candidate.projectName,
    };

    const llmDecision = await this.llmDedupService.decideDuplicate(pair);

    // Step 4: Route by confidence
    return this.routeByConfidence(llmDecision, topCandidate.id, topCandidate.name);
  }

  /**
   * Check whether an entity (person/organization) is a duplicate.
   *
   * Algorithm:
   * 1. Normalize name
   * 2. Exact match (LOWER(name) + type) -> MERGE
   * 3. ILIKE partial match, top-5
   * 4. LLM decision for top candidate
   * 5. Route by confidence
   */
  async checkEntity(candidate: EntityCandidate): Promise<DedupDecision> {
    const normalized = ProjectMatchingService.normalizeName(candidate.name);

    if (!normalized) {
      return this.createDecision('Empty name after normalization');
    }

    // Step 1: Exact match by normalized name + type
    const exactMatch = await this.findExactEntityMatch(
      normalized,
      candidate.type,
    );

    if (exactMatch) {
      this.logger.log(
        `Exact entity match: "${candidate.name}" -> "${exactMatch.name}" [${exactMatch.id}]`,
      );
      return {
        action: DedupAction.MERGE,
        existingId: exactMatch.id,
        confidence: 1.0,
        reason: `Exact name match: "${exactMatch.name}"`,
      };
    }

    // Step 2: ILIKE partial match (entities have no embedding column)
    const partialCandidates = await this.findPartialEntityMatches(
      normalized,
      candidate.type,
    );

    if (partialCandidates.length === 0) {
      this.logger.debug(
        `No partial matches for entity "${candidate.name}", creating new`,
      );
      return this.createDecision('No similar entities found');
    }

    // Step 3: LLM decision for the top candidate
    const topCandidate = partialCandidates[0];

    const pair: DedupPair = {
      newItem: {
        type: 'entity',
        name: candidate.name,
        context: candidate.context,
      },
      existingItem: {
        id: topCandidate.id,
        type: 'entity',
        name: topCandidate.name,
      },
    };

    const llmDecision = await this.llmDedupService.decideDuplicate(pair);

    // Step 4: Route by confidence
    return this.routeByConfidence(llmDecision, topCandidate.id, topCandidate.name);
  }

  /**
   * Check whether a commitment is a duplicate.
   * Delegates to checkTask since commitments map to Activity records.
   */
  async checkCommitment(candidate: CommitmentCandidate): Promise<DedupDecision> {
    // Commitments need an ownerEntityId for task dedup; use entityId if available
    const ownerEntityId = candidate.entityId ?? '';

    if (!ownerEntityId) {
      this.logger.debug(
        'Commitment has no entityId, cannot check for duplicates, creating new',
      );
      return this.createDecision('No entityId for commitment dedup');
    }

    return this.checkTask({
      name: candidate.what,
      ownerEntityId,
      projectName: candidate.activityContext,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Task helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Find an exact match for a task by normalized name (case-insensitive).
   */
  private async findExactTaskMatch(
    normalizedName: string,
    ownerEntityId: string,
  ): Promise<Activity | null> {
    const result = await this.activityRepo
      .createQueryBuilder('a')
      .where('LOWER(a.name) = :name', { name: normalizedName })
      .andWhere('a.ownerEntityId = :ownerId', { ownerId: ownerEntityId })
      .andWhere('a.activityType = :type', { type: ActivityType.TASK })
      .andWhere('a.status != :cancelled', {
        cancelled: ActivityStatus.CANCELLED,
      })
      .getOne();

    return result;
  }

  /**
   * Find semantic candidates via pgvector cosine similarity.
   * Returns up to TOP_K activities with similarity >= COSINE_THRESHOLD.
   *
   * Graceful degradation: if EmbeddingService is unavailable, returns empty array.
   */
  private async findSemanticTaskCandidates(
    normalizedName: string,
    ownerEntityId: string,
    description?: string,
  ): Promise<Array<{ id: string; name: string; description: string | null; similarity: number }>> {
    if (!this.embeddingService) {
      this.logger.warn(
        'EmbeddingService unavailable, skipping semantic task search',
      );
      return [];
    }

    let embedding: number[];
    try {
      const textForEmbedding = description
        ? `${normalizedName} - ${description}`
        : normalizedName;
      embedding = await this.embeddingService.generate(textForEmbedding);
    } catch (error: any) {
      this.logger.warn(
        `Failed to generate embedding for task "${normalizedName}": ${error.message}`,
      );
      return [];
    }

    try {
      const candidates = await this.activityRepo
        .createQueryBuilder('a')
        .select('a.id', 'id')
        .addSelect('a.name', 'name')
        .addSelect('a.description', 'description')
        .addSelect('1 - (a.embedding <=> :embedding)', 'similarity')
        .where('a.ownerEntityId = :ownerId', { ownerId: ownerEntityId })
        .andWhere('a.activityType = :type', { type: ActivityType.TASK })
        .andWhere('a.status != :cancelled', {
          cancelled: ActivityStatus.CANCELLED,
        })
        .andWhere('a.embedding IS NOT NULL')
        .andWhere('1 - (a.embedding <=> :embedding) >= :threshold')
        .orderBy('similarity', 'DESC')
        .limit(TOP_K)
        .setParameter('embedding', `[${embedding.join(',')}]`)
        .setParameter('threshold', COSINE_THRESHOLD)
        .getRawMany();

      return candidates;
    } catch (error: any) {
      this.logger.error(
        `Semantic task search failed: ${error.message}`,
        error.stack,
      );
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Entity helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Find an exact match for an entity by normalized name + type.
   */
  private async findExactEntityMatch(
    normalizedName: string,
    type: string,
  ): Promise<EntityRecord | null> {
    const result = await this.entityRepo
      .createQueryBuilder('e')
      .where('LOWER(e.name) = :name', { name: normalizedName })
      .andWhere('e.type = :type', { type })
      .getOne();

    return result;
  }

  /**
   * Find partial entity matches using ILIKE.
   * Since EntityRecord has no embedding column, we use name-based search.
   */
  private async findPartialEntityMatches(
    normalizedName: string,
    type: string,
  ): Promise<EntityRecord[]> {
    try {
      const candidates = await this.entityRepo
        .createQueryBuilder('e')
        .where('e.type = :type', { type })
        .andWhere('LOWER(e.name) LIKE :pattern', {
          pattern: `%${normalizedName}%`,
        })
        .andWhere('LOWER(e.name) != :exact', { exact: normalizedName })
        .limit(TOP_K)
        .getMany();

      return candidates;
    } catch (error: any) {
      this.logger.error(
        `Entity partial match search failed: ${error.message}`,
        error.stack,
      );
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Decision routing
  // ─────────────────────────────────────────────────────────────

  /**
   * Route LLM decision to the appropriate action based on confidence thresholds.
   */
  private routeByConfidence(
    llmDecision: { isDuplicate: boolean; confidence: number; reason: string },
    existingId: string,
    existingName: string,
  ): DedupDecision {
    if (!llmDecision.isDuplicate) {
      return this.createDecision(
        `LLM says not duplicate: ${llmDecision.reason}`,
      );
    }

    if (llmDecision.confidence >= AUTO_MERGE_CONFIDENCE) {
      this.logger.log(
        `Auto-merge: confidence ${llmDecision.confidence} >= ${AUTO_MERGE_CONFIDENCE} -> "${existingName}" [${existingId}]`,
      );
      return {
        action: DedupAction.MERGE,
        existingId,
        confidence: llmDecision.confidence,
        reason: llmDecision.reason,
      };
    }

    if (llmDecision.confidence >= APPROVAL_CONFIDENCE) {
      this.logger.log(
        `Pending approval: confidence ${llmDecision.confidence} (${APPROVAL_CONFIDENCE}-${AUTO_MERGE_CONFIDENCE}) -> "${existingName}" [${existingId}]`,
      );
      return {
        action: DedupAction.PENDING_APPROVAL,
        existingId,
        confidence: llmDecision.confidence,
        reason: llmDecision.reason,
      };
    }

    // Low confidence duplicate -- treat as CREATE
    return this.createDecision(
      `Low confidence duplicate (${llmDecision.confidence}): ${llmDecision.reason}`,
    );
  }

  /**
   * Shorthand for a CREATE decision.
   */
  private createDecision(reason: string): DedupDecision {
    return {
      action: DedupAction.CREATE,
      confidence: 0,
      reason,
    };
  }
}
