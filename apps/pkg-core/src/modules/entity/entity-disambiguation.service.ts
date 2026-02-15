import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { EntityRecord, EntityType } from '@pkg/entities';

/**
 * Context used to score disambiguation candidates.
 * Provides signals from the current conversation to help
 * disambiguate between multiple entities with similar names.
 */
export interface DisambiguationContext {
  /** Telegram chat ID where the mention occurred */
  chatId?: string;
  /** Other entity names co-occurring in the same context */
  mentionedWith?: string[];
  /** Recent interaction IDs for additional context */
  recentInteractionIds?: string[];
  /** Timestamp of the message containing the mention */
  messageTimestamp?: Date;
}

/**
 * Entity candidate with computed disambiguation score and explanations.
 */
export interface ScoredEntity {
  entity: EntityRecord;
  /** Aggregate score (higher = more likely the intended entity) */
  score: number;
  /** Human-readable reasons explaining why each signal contributed */
  reasons: string[];
}

/**
 * EntityDisambiguationService
 *
 * Resolves ambiguity when multiple Entity records match the same name.
 * Uses contextual signals (recent interactions, chat co-participation,
 * organization overlap with co-mentioned entities, active status) to
 * score and rank candidates.
 *
 * This service is advisory only -- it does NOT merge or modify entities.
 */
@Injectable()
export class EntityDisambiguationService {
  private readonly logger = new Logger(EntityDisambiguationService.name);

  /** Score awarded when the entity has a recent interaction (last 7 days) */
  private static readonly SCORE_RECENT_INTERACTION = 0.3;
  /** Score awarded when the entity participated in the same chat */
  private static readonly SCORE_SAME_CHAT = 0.2;
  /** Score awarded when the entity is linked to an organization mentioned alongside */
  private static readonly SCORE_ORG_OVERLAP = 0.4;
  /** Score awarded for an active (non-archived, non-deleted) entity */
  private static readonly SCORE_ACTIVE = 0.1;

  /** Window in days for "recent" interaction scoring */
  private static readonly RECENT_DAYS = 7;

  constructor(
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
  ) {}

  /**
   * Score and rank entity candidates that match a given name.
   *
   * Algorithm:
   * 1. Find all entities whose name matches (ILIKE) the query.
   * 2. For each candidate, compute contextual score based on:
   *    - Recent interactions (last 7 days): +0.3
   *    - Same chat participation: +0.2
   *    - Organization overlap with mentionedWith entities: +0.4
   *    - Active (not deleted) status: +0.1
   * 3. Return candidates sorted by score DESC.
   *
   * @param name - The name to search for (ILIKE match)
   * @param context - Contextual signals from the current conversation
   * @returns Scored and sorted candidates
   */
  async disambiguate(
    name: string,
    context: DisambiguationContext,
  ): Promise<ScoredEntity[]> {
    const manager = this.entityRepo.manager;

    // 1. Find all name-matching candidates (including identifiers, organization)
    const candidates = await this.findCandidates(name);

    if (candidates.length === 0) {
      return [];
    }

    if (candidates.length === 1) {
      // Single match -- no disambiguation needed, still apply scoring for transparency
      const scored = await this.scoreSingle(candidates[0], context, manager);
      this.logger.debug(
        `[disambiguate] Single match for "${name}": ${candidates[0].name} (score=${scored.score})`,
      );
      return [scored];
    }

    // 2. Score all candidates in parallel
    const candidateIds = candidates.map((c) => c.id);
    const [recentMap, chatMap, orgOverlapSet] = await Promise.all([
      this.buildRecentInteractionMap(candidateIds, context, manager),
      this.buildChatParticipationMap(candidateIds, context, manager),
      this.buildOrgOverlapSet(candidates, context, manager),
    ]);

    // 3. Compute scores
    const scored: ScoredEntity[] = candidates.map((entity) => {
      let score = 0;
      const reasons: string[] = [];

      // Active entity bonus
      if (!entity.deletedAt) {
        score += EntityDisambiguationService.SCORE_ACTIVE;
        reasons.push('entity is active (+0.1)');
      }

      // Recent interaction bonus
      if (recentMap.has(entity.id)) {
        score += EntityDisambiguationService.SCORE_RECENT_INTERACTION;
        const daysAgo = recentMap.get(entity.id)!;
        reasons.push(
          `recent interaction ${daysAgo} day(s) ago (+${EntityDisambiguationService.SCORE_RECENT_INTERACTION})`,
        );
      }

      // Same chat participation bonus
      if (chatMap.has(entity.id)) {
        score += EntityDisambiguationService.SCORE_SAME_CHAT;
        reasons.push(
          `participated in the same chat (+${EntityDisambiguationService.SCORE_SAME_CHAT})`,
        );
      }

      // Organization overlap bonus
      if (orgOverlapSet.has(entity.id)) {
        score += EntityDisambiguationService.SCORE_ORG_OVERLAP;
        reasons.push(
          `linked to co-mentioned organization (+${EntityDisambiguationService.SCORE_ORG_OVERLAP})`,
        );
      }

      return { entity, score, reasons };
    });

    // 4. Sort by score DESC, then by updatedAt DESC as tiebreaker
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = a.entity.updatedAt?.getTime() ?? 0;
      const bTime = b.entity.updatedAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    this.logger.debug(
      `[disambiguate] "${name}": ${scored.length} candidates. ` +
        `Top: ${scored[0].entity.name} (score=${scored[0].score}, reasons=[${scored[0].reasons.join('; ')}])`,
    );

    return scored;
  }

  /**
   * Find all entity candidates matching the name via ILIKE.
   * Includes organization relation and identifiers for downstream scoring.
   */
  private async findCandidates(name: string): Promise<EntityRecord[]> {
    return this.entityRepo
      .createQueryBuilder('e')
      .leftJoinAndSelect('e.organization', 'org')
      .leftJoinAndSelect('e.identifiers', 'ident')
      .where('e.name ILIKE :pattern', { pattern: `%${name}%` })
      .orderBy('e.updatedAt', 'DESC')
      .take(20)
      .getMany();
  }

  /**
   * Build a map: entityId -> days since most recent interaction.
   * Only entities with interactions within RECENT_DAYS are included.
   */
  private async buildRecentInteractionMap(
    candidateIds: string[],
    context: DisambiguationContext,
    manager: EntityManager,
  ): Promise<Map<string, number>> {
    if (candidateIds.length === 0) return new Map();

    const cutoff = new Date();
    cutoff.setDate(
      cutoff.getDate() - EntityDisambiguationService.RECENT_DAYS,
    );

    const rows: Array<{ entity_id: string; days_ago: number }> =
      await manager.query(
        `
        SELECT
          ip.entity_id,
          EXTRACT(DAY FROM NOW() - MAX(i.started_at))::int AS days_ago
        FROM interaction_participants ip
        JOIN interactions i ON i.id = ip.interaction_id
        WHERE ip.entity_id = ANY($1)
          AND i.started_at >= $2
        GROUP BY ip.entity_id
        `,
        [candidateIds, cutoff.toISOString()],
      );

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.entity_id, row.days_ago);
    }
    return map;
  }

  /**
   * Build a set of entity IDs that participated in the given chatId.
   */
  private async buildChatParticipationMap(
    candidateIds: string[],
    context: DisambiguationContext,
    manager: EntityManager,
  ): Promise<Set<string>> {
    if (!context.chatId || candidateIds.length === 0) return new Set();

    const rows: Array<{ entity_id: string }> = await manager.query(
      `
      SELECT DISTINCT ip.entity_id
      FROM interaction_participants ip
      JOIN interactions i ON i.id = ip.interaction_id
      WHERE ip.entity_id = ANY($1)
        AND i.source_metadata->>'telegram_chat_id' = $2
      `,
      [candidateIds, context.chatId],
    );

    return new Set(rows.map((r) => r.entity_id));
  }

  /**
   * Build a set of entity IDs whose organization matches any
   * of the co-mentioned entity names in the context.
   *
   * For example, if mentionedWith = ["Sber"] and candidate X has
   * organizationId pointing to an entity named "Sber", X gets the bonus.
   *
   * Additionally checks entity_relation_members for employment relations.
   */
  private async buildOrgOverlapSet(
    candidates: EntityRecord[],
    context: DisambiguationContext,
    manager: EntityManager,
  ): Promise<Set<string>> {
    if (
      !context.mentionedWith ||
      context.mentionedWith.length === 0 ||
      candidates.length === 0
    ) {
      return new Set();
    }

    const result = new Set<string>();
    const candidateIds = candidates.map((c) => c.id);
    const mentionedLower = context.mentionedWith.map((n) => n.toLowerCase());

    // Strategy 1: Direct organizationId check (already loaded via findCandidates)
    for (const candidate of candidates) {
      if (
        candidate.organization &&
        mentionedLower.includes(candidate.organization.name.toLowerCase())
      ) {
        result.add(candidate.id);
      }
    }

    // Strategy 2: Check entity_relation_members for employment-type relations
    // where the other member is an organization matching mentionedWith
    if (candidateIds.length > 0 && mentionedLower.length > 0) {
      const patterns = mentionedLower.map((n) => `%${n}%`);
      const rows: Array<{ entity_id: string }> = await manager.query(
        `
        SELECT DISTINCT erm.entity_id
        FROM entity_relation_members erm
        JOIN entity_relations er ON er.id = erm.relation_id
        JOIN entity_relation_members erm2 ON erm2.relation_id = er.id AND erm2.entity_id != erm.entity_id
        JOIN entities org ON org.id = erm2.entity_id
        WHERE erm.entity_id = ANY($1)
          AND er.relation_type IN ('employment', 'team', 'client_vendor')
          AND erm.valid_until IS NULL
          AND org.type = 'organization'
          AND (${patterns.map((_, i) => `LOWER(org.name) LIKE $${i + 2}`).join(' OR ')})
        `,
        [candidateIds, ...patterns],
      );

      for (const row of rows) {
        result.add(row.entity_id);
      }
    }

    return result;
  }

  /**
   * Score a single candidate (used when only one match is found).
   */
  private async scoreSingle(
    entity: EntityRecord,
    context: DisambiguationContext,
    manager: EntityManager,
  ): Promise<ScoredEntity> {
    const recentMap = await this.buildRecentInteractionMap(
      [entity.id],
      context,
      manager,
    );
    const chatMap = await this.buildChatParticipationMap(
      [entity.id],
      context,
      manager,
    );
    const orgOverlapSet = await this.buildOrgOverlapSet(
      [entity],
      context,
      manager,
    );

    let score = 0;
    const reasons: string[] = [];

    if (!entity.deletedAt) {
      score += EntityDisambiguationService.SCORE_ACTIVE;
      reasons.push('entity is active (+0.1)');
    }

    if (recentMap.has(entity.id)) {
      score += EntityDisambiguationService.SCORE_RECENT_INTERACTION;
      reasons.push(
        `recent interaction ${recentMap.get(entity.id)} day(s) ago (+${EntityDisambiguationService.SCORE_RECENT_INTERACTION})`,
      );
    }

    if (chatMap.has(entity.id)) {
      score += EntityDisambiguationService.SCORE_SAME_CHAT;
      reasons.push(
        `participated in the same chat (+${EntityDisambiguationService.SCORE_SAME_CHAT})`,
      );
    }

    if (orgOverlapSet.has(entity.id)) {
      score += EntityDisambiguationService.SCORE_ORG_OVERLAP;
      reasons.push(
        `linked to co-mentioned organization (+${EntityDisambiguationService.SCORE_ORG_OVERLAP})`,
      );
    }

    return { entity, score, reasons };
  }
}
