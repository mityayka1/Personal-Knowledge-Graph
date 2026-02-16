import { Injectable, Logger } from '@nestjs/common';
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
 * Matches the project matching threshold to avoid false positives
 * that would pack segments into wrong Activities.
 */
const SIMILARITY_THRESHOLD = 0.8;

/**
 * OrphanSegmentLinkerService — автоматическая привязка TopicalSegment к Activity.
 *
 * Сегменты без activityId ("orphans") пропускаются PackingJobService.
 * Этот сервис пытается найти наиболее подходящую Activity для каждого orphan:
 *
 * 1. Из сегмента получает interactionId → participants → entityIds
 * 2. Для каждого участника ищет его активные Activities (PROJECT/TASK/INITIATIVE)
 * 3. Сравнивает summary/topic сегмента с name/description Activity (Levenshtein similarity)
 * 4. Если similarity >= 0.8 — привязывает сегмент к лучшей Activity
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Injectable()
export class OrphanSegmentLinkerService {
  private readonly logger = new Logger(OrphanSegmentLinkerService.name);

  constructor(
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    private readonly dataSource: DataSource,
    private readonly projectMatchingService: ProjectMatchingService,
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

    // 2. Resolve participant entity IDs
    const participantEntityIds = await this.resolveParticipantEntityIds(segment);
    if (participantEntityIds.length === 0) {
      this.logger.debug(
        `[orphan-linker] Segment ${segmentId} has no resolvable participant entities, skipping`,
      );
      return { activityId: null, similarity: 0, skipReason: 'no_participants' };
    }

    // 3. Find candidate activities for these participants
    const candidateActivities = await this.findCandidateActivities(participantEntityIds);
    if (candidateActivities.length === 0) {
      this.logger.debug(
        `[orphan-linker] No candidate activities found for segment ${segmentId} participants`,
      );
      return { activityId: null, similarity: 0, skipReason: 'no_candidate_activities' };
    }

    // 4. Score each activity against segment text
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

    // 5. Link segment to activity
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
   * Processes each segment independently — errors on one segment
   * do not block processing of the rest.
   */
  async linkAllOrphans(): Promise<BulkLinkResult> {
    // Use QueryBuilder for proper IS NULL check (TypeORM find() doesn't support null equality)
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
      return { linked: 0, total: 0, errors: 0 };
    }

    this.logger.log(`[orphan-linker] Processing ${total} orphan segments`);

    let linked = 0;
    let errors = 0;

    for (const { id } of orphanRows) {
      try {
        const result = await this.linkOrphanSegment(id);
        if (result.activityId && !result.skipReason) {
          linked++;
        }
      } catch (error: unknown) {
        errors++;
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `[orphan-linker] Error processing segment ${id}: ${err.message}`,
          err.stack,
        );
      }
    }

    this.logger.log(
      `[orphan-linker] Completed: ${linked}/${total} linked, ${errors} errors`,
    );

    return { linked, total, errors };
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

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

    return participants.map((p) => p.entity_id);
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
