import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  TopicalSegment,
  SegmentStatus,
  Activity,
  ActivityType,
  ActivityStatus,
} from '@pkg/entities';
import { ProjectMatchingService } from '../extraction/project-matching.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

/**
 * Result of attempting to link a single orphan segment.
 */
export interface LinkResult {
  /** Linked activity ID (null if no match found) */
  activityId: string | null;
  /** Best similarity score achieved */
  similarity: number;
  /** Activity name (for logging) */
  activityName?: string;
  /** Reason for skip (if not linked) */
  skipReason?: string;
}

/**
 * Result of bulk orphan linking.
 */
export interface BulkLinkResult {
  /** Number of segments successfully linked */
  linked: number;
  /** Total orphan segments processed */
  total: number;
  /** Number of segments skipped (already linked before processing) */
  skipped: number;
  /** Number of errors encountered */
  errors: number;
}

/**
 * Activity types eligible for segment linking.
 */
const LINKABLE_ACTIVITY_TYPES: ActivityType[] = [
  ActivityType.PROJECT,
  ActivityType.TASK,
  ActivityType.INITIATIVE,
];

/**
 * Statuses that exclude an activity from linking (terminal states).
 */
const EXCLUDED_STATUSES: ActivityStatus[] = [
  ActivityStatus.ARCHIVED,
  ActivityStatus.CANCELLED,
];

/**
 * Minimum similarity score to link a segment to an activity.
 * Lowered from 0.8 to 0.5 — segment topics are verbose descriptions
 * while activity names are short labels, so token overlap is naturally low.
 * Combined with participant filtering this prevents false positives.
 */
const SIMILARITY_THRESHOLD = 0.5;

/**
 * Minimum LLM confidence to accept a classification result.
 */
const LLM_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Maximum number of orphan segments to send in a single LLM batch.
 */
const LLM_BATCH_SIZE = 15;

/**
 * OrphanSegmentLinkerService — автоматическая привязка TopicalSegment к Activity.
 *
 * Сегменты без activityId ("orphans") пропускаются PackingJobService.
 * Этот сервис пытается найти наиболее подходящую Activity для каждого orphan:
 *
 * 1. Chat→Activity mapping — если чат однозначно связан с одной Activity
 * 2. Из сегмента получает interactionId → participants → entityIds
 * 3. Для каждого участника ищет его активные Activities (PROJECT/TASK/INITIATIVE)
 * 4. Сравнивает summary/topic сегмента с name/description Activity (Levenshtein similarity)
 * 5. Если similarity >= 0.5 — привязывает сегмент к лучшей Activity
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Injectable()
export class OrphanSegmentLinkerService {
  private readonly logger = new Logger(OrphanSegmentLinkerService.name);
  private isRunning = false;

  constructor(
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    private readonly dataSource: DataSource,
    private readonly projectMatchingService: ProjectMatchingService,
    @Optional()
    private readonly claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Attempt to link a single orphan segment to the best matching Activity.
   *
   * Steps:
   * 1. Load segment (verify it's orphaned)
   * 2. Resolve participant entity IDs from interaction
   * 3. Find candidate activities for those participants
   * 4. Score each activity against segment summary/topic
   * 5. Link to best match if similarity >= threshold
   */
  async linkOrphanSegment(segmentId: string): Promise<LinkResult> {
    // 1. Load segment
    const segment = await this.segmentRepo.findOne({ where: { id: segmentId } });
    if (!segment) {
      this.logger.warn(`[orphan-linker] Segment ${segmentId} not found`);
      return { activityId: null, similarity: 0, skipReason: 'segment_not_found' };
    }

    // Already linked — skip
    if (segment.activityId) {
      this.logger.debug(`[orphan-linker] Segment ${segmentId} already linked to activity ${segment.activityId}`);
      return { activityId: segment.activityId, similarity: 1.0, skipReason: 'already_linked' };
    }

    // 2. Try chat→activity mapping (fast path for single-activity chats)
    const chatMapping = await this.linkByChatActivityMapping(segment);
    if (chatMapping) {
      await this.segmentRepo.update(segmentId, { activityId: chatMapping.activityId });
      this.logger.log(
        `[orphan-linker] Linked segment ${segmentId} → activity "${chatMapping.activityName}" ` +
          `(${chatMapping.activityId}) via chat mapping`,
      );
      return {
        activityId: chatMapping.activityId,
        similarity: 1.0,
        activityName: chatMapping.activityName,
      };
    }

    // 3. Resolve participant entity IDs
    const participantEntityIds = await this.resolveParticipantEntityIds(segment);
    if (participantEntityIds.length === 0) {
      this.logger.debug(
        `[orphan-linker] Segment ${segmentId} has no resolvable participant entities, skipping`,
      );
      return { activityId: null, similarity: 0, skipReason: 'no_participants' };
    }

    // 4. Find candidate activities for these participants
    const candidateActivities = await this.findCandidateActivities(participantEntityIds);
    if (candidateActivities.length === 0) {
      this.logger.debug(
        `[orphan-linker] No candidate activities found for segment ${segmentId} participants`,
      );
      return { activityId: null, similarity: 0, skipReason: 'no_candidate_activities' };
    }

    // 5. Score each activity against segment text
    const segmentText = this.buildSegmentText(segment);
    const bestMatch = this.findBestActivityMatch(segmentText, candidateActivities);

    if (!bestMatch || bestMatch.similarity < SIMILARITY_THRESHOLD) {
      this.logger.debug(
        `[orphan-linker] Segment ${segmentId} best match similarity=${bestMatch?.similarity.toFixed(3) ?? 0} ` +
          `below threshold ${SIMILARITY_THRESHOLD}, skipping`,
      );
      return {
        activityId: null,
        similarity: bestMatch?.similarity ?? 0,
        skipReason: 'below_threshold',
      };
    }

    // 6. Link segment to activity
    await this.segmentRepo.update(segmentId, { activityId: bestMatch.activity.id });

    this.logger.log(
      `[orphan-linker] Linked segment ${segmentId} → activity "${bestMatch.activity.name}" ` +
        `(${bestMatch.activity.id}), similarity=${bestMatch.similarity.toFixed(3)}`,
    );

    return {
      activityId: bestMatch.activity.id,
      similarity: bestMatch.similarity,
      activityName: bestMatch.activity.name,
    };
  }

  /**
   * Link all orphan segments (no activityId, status ACTIVE or CLOSED).
   *
   * Two-phase approach:
   * Phase 1 (bulk, in-memory): Load all segments + all candidate activities
   *   in 2 DB queries, then do similarity matching in memory.
   * Phase 2 (LLM): Classify remaining orphans via Claude Haiku batches.
   */
  async linkAllOrphans(): Promise<BulkLinkResult> {
    if (this.isRunning) {
      this.logger.warn('[orphan-linker] Already running, skipping concurrent call');
      return { linked: 0, total: 0, skipped: 0, errors: 0 };
    }

    this.isRunning = true;
    try {
      return await this._linkAllOrphansInternal();
    } finally {
      this.isRunning = false;
    }
  }

  private async _linkAllOrphansInternal(): Promise<BulkLinkResult> {
    // Load all orphan segments in bulk (not just IDs — need topic/summary/participantIds)
    const CHUNK_SIZE = 500;
    const orphanSegments: TopicalSegment[] = [];

    // First get IDs (lightweight query)
    const orphanRows = await this.segmentRepo
      .createQueryBuilder('s')
      .select('s.id', 'id')
      .where('s.activity_id IS NULL')
      .andWhere('s.status IN (:...statuses)', {
        statuses: [SegmentStatus.ACTIVE, SegmentStatus.CLOSED],
      })
      .getRawMany<{ id: string }>();

    const total = orphanRows.length;
    if (total === 0) {
      this.logger.log('[orphan-linker] No orphan segments found');
      return { linked: 0, total: 0, skipped: 0, errors: 0 };
    }

    this.logger.log(`[orphan-linker] Processing ${total} orphan segments (bulk mode)`);

    // Load full segments in chunks
    const orphanIds = orphanRows.map((r) => r.id);
    for (let j = 0; j < orphanIds.length; j += CHUNK_SIZE) {
      const chunk = orphanIds.slice(j, j + CHUNK_SIZE);
      const loaded = await this.segmentRepo
        .createQueryBuilder('s')
        .where('s.id IN (:...ids)', { ids: chunk })
        .andWhere('s.activity_id IS NULL')
        .getMany();
      orphanSegments.push(...loaded);
    }

    this.logger.log(`[orphan-linker] Loaded ${orphanSegments.length} orphan segments`);

    // Collect all unique participant entity IDs across all segments
    const allParticipantIds = new Set<string>();
    for (const seg of orphanSegments) {
      if (seg.participantIds?.length > 0) {
        for (const pid of seg.participantIds) {
          allParticipantIds.add(pid);
        }
      }
    }

    // Load all candidate activities for ALL participants in one query
    let allCandidateActivities: Activity[] = [];
    if (allParticipantIds.size > 0) {
      allCandidateActivities = await this.findCandidateActivities(
        Array.from(allParticipantIds),
      );
    }

    this.logger.log(
      `[orphan-linker] Found ${allCandidateActivities.length} candidate activities ` +
        `for ${allParticipantIds.size} unique participants`,
    );

    let linked = 0;
    const skipped = 0;
    let errors = 0;
    const remainingOrphans: TopicalSegment[] = [];

    // Phase 1: In-memory similarity matching (no per-segment DB queries)
    if (allCandidateActivities.length > 0) {
      for (const segment of orphanSegments) {
        try {
          const segmentText = this.buildSegmentText(segment);
          if (!segmentText) {
            remainingOrphans.push(segment);
            continue;
          }

          // Filter candidate activities to those relevant for this segment's participants
          const segParticipants = new Set(segment.participantIds ?? []);
          const relevantActivities = segParticipants.size > 0
            ? allCandidateActivities.filter(
                (a) =>
                  (a.ownerEntityId && segParticipants.has(a.ownerEntityId)) ||
                  // For members/client — we already loaded all activities for all participants,
                  // so the full set is a superset of what's relevant. Use the full set
                  // if there's no ownerEntityId match to avoid missing member-based matches.
                  true,
              )
            : allCandidateActivities;

          const bestMatch = this.findBestActivityMatch(segmentText, relevantActivities);

          if (bestMatch && bestMatch.similarity >= SIMILARITY_THRESHOLD) {
            await this.segmentRepo.update(segment.id, {
              activityId: bestMatch.activity.id,
            });
            linked++;
            this.logger.debug(
              `[orphan-linker] Phase1: linked segment ${segment.id} → "${bestMatch.activity.name}" ` +
                `(similarity=${bestMatch.similarity.toFixed(3)})`,
            );
          } else {
            remainingOrphans.push(segment);
          }
        } catch (error: unknown) {
          errors++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            `[orphan-linker] Phase1 error for segment ${segment.id}: ${err.message}`,
          );
          remainingOrphans.push(segment);
        }
      }
    } else {
      // No candidate activities at all — all segments go to LLM
      remainingOrphans.push(...orphanSegments);
    }

    this.logger.log(
      `[orphan-linker] Phase 1 complete: ${linked} linked, ${remainingOrphans.length} remaining for LLM`,
    );

    // Phase 2: LLM fallback for remaining orphans
    if (remainingOrphans.length > 0 && this.claudeAgentService) {
      this.logger.log(
        `[orphan-linker] Phase 2: classifying ${remainingOrphans.length} orphans via LLM`,
      );

      try {
        // Load all linkable activities for LLM context (broader set than Phase 1)
        const allActivities = allCandidateActivities.length > 0
          ? allCandidateActivities
          : await this.activityRepo
              .createQueryBuilder('a')
              .where('a.activityType IN (:...types)', { types: LINKABLE_ACTIVITY_TYPES })
              .andWhere('a.status NOT IN (:...excludedStatuses)', { excludedStatuses: EXCLUDED_STATUSES })
              .andWhere('a.deleted_at IS NULL')
              .select(['a.id', 'a.name', 'a.description', 'a.activityType'])
              .orderBy('a.last_activity_at', 'DESC', 'NULLS LAST')
              .limit(100)
              .getMany();

        if (allActivities.length > 0) {
          const llmLinked = await this.linkByLlmClassification(
            remainingOrphans,
            allActivities,
          );
          linked += llmLinked;
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `[orphan-linker] LLM fallback failed: ${err.message}`,
          err.stack,
        );
      }
    }

    this.logger.log(
      `[orphan-linker] Completed: ${linked}/${total} linked, ${skipped} skipped, ${errors} errors`,
    );

    return { linked, total, skipped, errors };
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Try to link segment by chat→activity mapping.
   *
   * If ALL segments in a given chat belong to a single Activity, this segment
   * likely belongs to the same Activity. This is a fast path that avoids
   * similarity scoring entirely.
   *
   * Returns null if the chat maps to 0 or 2+ distinct activities.
   */
  private async linkByChatActivityMapping(
    segment: TopicalSegment,
  ): Promise<{ activityId: string; activityName: string } | null> {
    if (!segment.chatId) return null;

    // Find distinct activities already linked to segments in this chat
    const chatActivities: Array<{ activity_id: string; activity_name: string }> =
      await this.dataSource.query(
        `SELECT DISTINCT a.id AS activity_id, a.name AS activity_name
         FROM topical_segments ts
         JOIN activities a ON a.id = ts.activity_id
         WHERE ts.chat_id = $1
           AND ts.activity_id IS NOT NULL
           AND a.deleted_at IS NULL
           AND a.status NOT IN ($2, $3)`,
        [segment.chatId, ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED],
      );

    // Only link when chat unambiguously maps to exactly one activity
    if (chatActivities.length !== 1) {
      return null;
    }

    return {
      activityId: chatActivities[0].activity_id,
      activityName: chatActivities[0].activity_name,
    };
  }

  /**
   * LLM-based classification of orphan segments into activities.
   *
   * Sends batches of orphan segments + available activities to Claude Haiku.
   * The LLM returns a classification with confidence for each segment.
   * Only classifications with confidence >= LLM_CONFIDENCE_THRESHOLD are applied.
   *
   * @returns Number of segments successfully linked
   */
  private async linkByLlmClassification(
    segments: TopicalSegment[],
    activities: Activity[],
  ): Promise<number> {
    if (segments.length === 0 || activities.length === 0) return 0;
    if (!this.claudeAgentService) {
      this.logger.debug('[orphan-linker] ClaudeAgentService not available, skipping LLM classification');
      return 0;
    }

    // Build activity context for LLM (compact: skip description to reduce tokens)
    const activityContext = activities
      .map((a) => `- ${a.id}: "${a.name}" (${a.activityType})`)
      .join('\n');

    // Validate activity IDs for fast lookup
    const activityIdSet = new Set(activities.map((a) => a.id));

    let totalLinked = 0;

    // Process in batches to respect context window limits
    const totalBatches = Math.ceil(segments.length / LLM_BATCH_SIZE);
    for (let i = 0; i < segments.length; i += LLM_BATCH_SIZE) {
      const batchNum = Math.floor(i / LLM_BATCH_SIZE) + 1;
      const batch = segments.slice(i, i + LLM_BATCH_SIZE);
      const segmentIdSet = new Set(batch.map((s) => s.id));

      this.logger.log(
        `[orphan-linker] LLM batch ${batchNum}/${totalBatches} (${batch.length} segments)`,
      );

      const segmentContext = batch
        .map(
          (s) =>
            `- ${s.id}: topic="${s.topic}"${s.summary ? `, summary="${s.summary}"` : ''}` +
            ` (chat=${s.chatId})`,
        )
        .join('\n');

      const prompt = `Ты — классификатор сегментов обсуждений. Определи, к какой Activity относится каждый сегмент.

Доступные Activity:
${activityContext}

Сегменты для классификации:
${segmentContext}

Для каждого сегмента определи наиболее подходящую Activity.
Если сегмент не подходит ни к одной Activity (например, личная беседа, не связанная с работой), установи activityId = "none".
Верни confidence от 0 до 1, где 1 = полная уверенность.`;

      try {
        const result = await this.claudeAgentService.call<{
          classifications: Array<{
            segmentId: string;
            activityId: string | null;
            confidence: number;
            reasoning: string;
          }>;
        }>({
          mode: 'oneshot',
          taskType: 'orphan_classification',
          prompt,
          model: 'haiku',
          schema: {
            type: 'object',
            properties: {
              classifications: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    segmentId: { type: 'string', description: 'UUID сегмента' },
                    activityId: {
                      type: 'string',
                      description: 'UUID Activity или строка "none" если сегмент не подходит ни к одной Activity',
                    },
                    confidence: {
                      type: 'number',
                      description: 'Уверенность классификации от 0 до 1',
                    },
                    reasoning: {
                      type: 'string',
                      description: 'Краткое обоснование решения',
                    },
                  },
                  required: ['segmentId', 'activityId', 'confidence', 'reasoning'],
                },
              },
            },
            required: ['classifications'],
          },
          timeout: 120000,
        });

        if (!result.data?.classifications) {
          this.logger.warn('[orphan-linker] LLM returned no classifications');
          continue;
        }

        for (const classification of result.data.classifications) {
          // Guard: verify segmentId belongs to this batch
          if (!segmentIdSet.has(classification.segmentId)) {
            this.logger.warn(
              `[orphan-linker] LLM returned unknown segmentId ${classification.segmentId}, skipping`,
            );
            continue;
          }

          if (
            classification.activityId &&
            classification.activityId !== 'none' &&
            classification.confidence >= LLM_CONFIDENCE_THRESHOLD &&
            activityIdSet.has(classification.activityId)
          ) {
            await this.segmentRepo.update(classification.segmentId, {
              activityId: classification.activityId,
            });

            const activityName = activities.find(
              (a) => a.id === classification.activityId,
            )?.name;
            this.logger.log(
              `[orphan-linker] LLM linked segment ${classification.segmentId} → ` +
                `"${activityName}" (confidence=${classification.confidence.toFixed(2)}, ` +
                `reason: ${classification.reasoning})`,
            );
            totalLinked++;
          }
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `[orphan-linker] LLM batch classification failed: ${err.message}`,
          err.stack,
        );
        // Continue with next batch
      }

      // Rate limiting between batches to avoid API rate limits
      if (i + LLM_BATCH_SIZE < segments.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    this.logger.log(`[orphan-linker] LLM classified ${totalLinked}/${segments.length} segments`);
    return totalLinked;
  }

  /**
   * Resolve participant entity IDs for a segment.
   *
   * Strategy:
   * 1. Use segment.participantIds if available
   * 2. Fall back to querying interaction_participants via segment.interactionId
   */
  private async resolveParticipantEntityIds(segment: TopicalSegment): Promise<string[]> {
    // Strategy 1: Use participantIds from segment directly
    if (segment.participantIds?.length > 0) {
      return segment.participantIds;
    }

    // Strategy 2: Query via interactionId
    if (!segment.interactionId) {
      return [];
    }

    const participants: Array<{ entity_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT ip.entity_id
       FROM interaction_participants ip
       WHERE ip.interaction_id = $1
         AND ip.entity_id IS NOT NULL`,
      [segment.interactionId],
    );

    return participants
      .filter((p) => p.entity_id && typeof p.entity_id === 'string')
      .map((p) => p.entity_id);
  }

  /**
   * Find candidate activities for the given participant entity IDs.
   *
   * Searches for activities where any participant is either:
   * - The owner (ownerEntityId)
   * - A member (via activity_members table)
   * - The client (clientEntityId)
   *
   * Only returns activities with linkable types and non-terminal statuses.
   */
  private async findCandidateActivities(entityIds: string[]): Promise<Activity[]> {
    if (entityIds.length === 0) return [];

    // Query activities where the participant is owner, client, or member
    const activities = await this.activityRepo
      .createQueryBuilder('a')
      .where('a.activityType IN (:...types)', { types: LINKABLE_ACTIVITY_TYPES })
      .andWhere('a.status NOT IN (:...excludedStatuses)', { excludedStatuses: EXCLUDED_STATUSES })
      .andWhere('a.deleted_at IS NULL')
      .andWhere(
        `(
          a.owner_entity_id IN (:...entityIds)
          OR a.client_entity_id IN (:...entityIds)
          OR a.id IN (
            SELECT am.activity_id FROM activity_members am
            WHERE am.entity_id IN (:...entityIds) AND am.is_active = true
          )
        )`,
        { entityIds },
      )
      .select(['a.id', 'a.name', 'a.description', 'a.activityType', 'a.status', 'a.ownerEntityId'])
      .orderBy('a.last_activity_at', 'DESC', 'NULLS LAST')
      .limit(50)
      .getMany();

    return activities;
  }

  /**
   * Build a comparison text from segment topic and summary.
   */
  private buildSegmentText(segment: TopicalSegment): string {
    const parts: string[] = [];

    if (segment.topic) {
      parts.push(segment.topic);
    }
    if (segment.summary) {
      parts.push(segment.summary);
    }

    return parts.join(' ').trim();
  }

  /**
   * Find the best matching activity for a segment text.
   *
   * Compares segment text against both activity name and description,
   * taking the higher score for each activity.
   */
  private findBestActivityMatch(
    segmentText: string,
    activities: Activity[],
  ): { activity: Activity; similarity: number } | null {
    if (!segmentText || activities.length === 0) return null;

    const normalizedSegmentText = ProjectMatchingService.normalizeName(segmentText);
    let bestActivity: Activity | null = null;
    let bestSimilarity = 0;

    for (const activity of activities) {
      // Compare against activity name
      const nameSimilarity = this.projectMatchingService.calculateSimilarity(
        normalizedSegmentText,
        ProjectMatchingService.normalizeName(activity.name),
      );

      // Compare against activity description (if exists)
      let descriptionSimilarity = 0;
      if (activity.description) {
        descriptionSimilarity = this.projectMatchingService.calculateSimilarity(
          normalizedSegmentText,
          ProjectMatchingService.normalizeName(activity.description),
        );
      }

      // Take the better score
      const similarity = Math.max(nameSimilarity, descriptionSimilarity);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestActivity = activity;
      }
    }

    return bestActivity ? { activity: bestActivity, similarity: bestSimilarity } : null;
  }
}
