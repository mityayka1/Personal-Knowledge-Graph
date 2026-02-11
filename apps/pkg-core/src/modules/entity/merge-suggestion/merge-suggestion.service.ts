import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  EntityType,
  DismissedMergeSuggestion,
} from '@pkg/entities';
import {
  MergeSuggestionGroupDto,
  MergeSuggestionsResponseDto,
  EntityIdentifierDto,
  EntityFactDto,
} from './dto/merge-suggestion.dto';
import {
  MergePreviewDto,
  EntityMergeDataDto,
  MergeConflictDto,
} from './dto/merge-preview.dto';
import { MergeRequestDto, ConflictResolution } from './dto/merge-request.dto';

@Injectable()
export class MergeSuggestionService {
  private readonly logger = new Logger(MergeSuggestionService.name);

  constructor(
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    @InjectRepository(EntityIdentifier)
    private identifierRepo: Repository<EntityIdentifier>,
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    @InjectRepository(DismissedMergeSuggestion)
    private dismissedRepo: Repository<DismissedMergeSuggestion>,
    private dataSource: DataSource,
  ) {}

  /**
   * Get merge suggestions from multiple detection strategies.
   * Combines orphaned Telegram entities + identifier-based matches.
   */
  async getSuggestions(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<MergeSuggestionsResponseDto> {
    const [orphanResult, identifierResult] = await Promise.all([
      this.getOrphanTelegramSuggestions(options),
      this.getIdentifierBasedSuggestions(options),
    ]);

    // Combine groups, dedup by primaryEntity.id
    const groupsMap = new Map<string, MergeSuggestionGroupDto>();
    for (const group of [...orphanResult.groups, ...identifierResult.groups]) {
      const existing = groupsMap.get(group.primaryEntity.id);
      if (existing) {
        // Merge candidates from both sources, dedup by candidate id
        const existingIds = new Set(existing.candidates.map((c) => c.id));
        for (const candidate of group.candidates) {
          if (!existingIds.has(candidate.id)) {
            existing.candidates.push(candidate);
          }
        }
      } else {
        groupsMap.set(group.primaryEntity.id, group);
      }
    }

    const groups = Array.from(groupsMap.values());
    return {
      groups,
      total: groups.length,
    };
  }

  /**
   * Detect orphaned "Telegram NNNN" entities that match a primary entity's telegram_user_id.
   */
  private async getOrphanTelegramSuggestions(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<MergeSuggestionsResponseDto> {
    const { limit = 50, offset = 0 } = options;

    const rows: Array<{
      orphan_id: string;
      orphan_name: string;
      orphan_created_at: Date;
      telegram_user_id: string;
      primary_id: string;
      primary_name: string;
      primary_type: string;
      primary_profile_photo: string | null;
      total_groups: string;
    }> = await this.entityRepo.query(
      `
      WITH orphan_primary_pairs AS (
        SELECT
          e.id AS orphan_id,
          e.name AS orphan_name,
          e.created_at AS orphan_created_at,
          (regexp_match(e.name, '^Telegram (\\d+)$'))[1] AS telegram_user_id,
          ei.entity_id AS primary_id
        FROM entities e
        JOIN entity_identifiers ei
          ON ei.identifier_type = 'telegram_user_id'
          AND ei.identifier_value = (regexp_match(e.name, '^Telegram (\\d+)$'))[1]
        WHERE e.name ~ '^Telegram [0-9]+$'
          AND e.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM entity_identifiers ei2
            WHERE ei2.entity_id = e.id
              AND ei2.identifier_type = 'telegram_user_id'
          )
          AND NOT EXISTS (
            SELECT 1 FROM dismissed_merge_suggestions dms
            WHERE dms.primary_entity_id = ei.entity_id
              AND dms.dismissed_entity_id = e.id
          )
      ),
      grouped AS (
        SELECT DISTINCT primary_id FROM orphan_primary_pairs
      ),
      total AS (
        SELECT COUNT(*) AS cnt FROM grouped
      ),
      paginated AS (
        SELECT primary_id FROM grouped
        ORDER BY primary_id
        LIMIT $1 OFFSET $2
      )
      SELECT
        opp.orphan_id,
        opp.orphan_name,
        opp.orphan_created_at,
        opp.telegram_user_id,
        opp.primary_id,
        pe.name AS primary_name,
        pe.type AS primary_type,
        pe.profile_photo AS primary_profile_photo,
        (SELECT cnt FROM total) AS total_groups
      FROM orphan_primary_pairs opp
      JOIN paginated p ON p.primary_id = opp.primary_id
      JOIN entities pe ON pe.id = opp.primary_id
      ORDER BY opp.primary_id, opp.orphan_created_at DESC
      `,
      [limit, offset],
    );

    if (rows.length === 0) {
      return { groups: [], total: 0 };
    }

    const totalGroups = parseInt(rows[0].total_groups || '0', 10);
    const orphanIds = [...new Set(rows.map((r) => r.orphan_id))];
    const primaryIds = [...new Set(rows.map((r) => r.primary_id))];

    const [messageCounts, primaryIdentifiers] = await Promise.all([
      this.getMessageCountsBatch(orphanIds),
      this.getIdentifiersBatch(primaryIds),
    ]);

    const groupsMap = new Map<string, MergeSuggestionGroupDto>();

    for (const row of rows) {
      if (!groupsMap.has(row.primary_id)) {
        groupsMap.set(row.primary_id, {
          primaryEntity: {
            id: row.primary_id,
            name: row.primary_name,
            type: row.primary_type as EntityType,
            profilePhoto: row.primary_profile_photo,
            identifiers: primaryIdentifiers.get(row.primary_id) || [],
          },
          candidates: [],
          reason: 'orphaned_telegram_id',
        });
      }

      groupsMap.get(row.primary_id)!.candidates.push({
        id: row.orphan_id,
        name: row.orphan_name,
        extractedUserId: row.telegram_user_id,
        createdAt: row.orphan_created_at,
        messageCount: messageCounts.get(row.orphan_id) || 0,
      });
    }

    return {
      groups: Array.from(groupsMap.values()),
      total: totalGroups,
    };
  }

  /**
   * Detect entities whose name matches a telegram_username identifier on a different entity.
   * Example: entity "vasunya91" → primary entity "Александра" with telegram_username "vasunya91".
   */
  private async getIdentifierBasedSuggestions(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<MergeSuggestionsResponseDto> {
    const { limit = 50, offset = 0 } = options;

    const rows: Array<{
      candidate_id: string;
      candidate_name: string;
      candidate_created_at: Date;
      matched_value: string;
      primary_id: string;
      primary_name: string;
      primary_type: string;
      primary_profile_photo: string | null;
      total_groups: string;
    }> = await this.entityRepo.query(
      `
      WITH username_matches AS (
        SELECT
          e.id AS candidate_id,
          e.name AS candidate_name,
          e.created_at AS candidate_created_at,
          ei.identifier_value AS matched_value,
          ei.entity_id AS primary_id
        FROM entities e
        JOIN entity_identifiers ei
          ON ei.identifier_type = 'telegram_username'
          AND LOWER(ei.identifier_value) = LOWER(REPLACE(e.name, '@', ''))
          AND ei.entity_id != e.id
        WHERE e.deleted_at IS NULL
          AND LENGTH(REPLACE(e.name, '@', '')) >= 3
          AND NOT EXISTS (
            SELECT 1 FROM dismissed_merge_suggestions dms
            WHERE dms.primary_entity_id = ei.entity_id
              AND dms.dismissed_entity_id = e.id
          )
      ),
      grouped AS (
        SELECT DISTINCT primary_id FROM username_matches
      ),
      total AS (
        SELECT COUNT(*) AS cnt FROM grouped
      ),
      paginated AS (
        SELECT primary_id FROM grouped
        ORDER BY primary_id
        LIMIT $1 OFFSET $2
      )
      SELECT
        um.candidate_id,
        um.candidate_name,
        um.candidate_created_at,
        um.matched_value,
        um.primary_id,
        pe.name AS primary_name,
        pe.type AS primary_type,
        pe.profile_photo AS primary_profile_photo,
        (SELECT cnt FROM total) AS total_groups
      FROM username_matches um
      JOIN paginated p ON p.primary_id = um.primary_id
      JOIN entities pe ON pe.id = um.primary_id
      ORDER BY um.primary_id, um.candidate_created_at DESC
      `,
      [limit, offset],
    );

    if (rows.length === 0) {
      return { groups: [], total: 0 };
    }

    const totalGroups = parseInt(rows[0].total_groups || '0', 10);
    const candidateIds = [...new Set(rows.map((r) => r.candidate_id))];
    const primaryIds = [...new Set(rows.map((r) => r.primary_id))];

    const [messageCounts, primaryIdentifiers] = await Promise.all([
      this.getMessageCountsBatch(candidateIds),
      this.getIdentifiersBatch(primaryIds),
    ]);

    const groupsMap = new Map<string, MergeSuggestionGroupDto>();

    for (const row of rows) {
      if (!groupsMap.has(row.primary_id)) {
        groupsMap.set(row.primary_id, {
          primaryEntity: {
            id: row.primary_id,
            name: row.primary_name,
            type: row.primary_type as EntityType,
            profilePhoto: row.primary_profile_photo,
            identifiers: primaryIdentifiers.get(row.primary_id) || [],
          },
          candidates: [],
          reason: 'shared_identifier',
        });
      }

      groupsMap.get(row.primary_id)!.candidates.push({
        id: row.candidate_id,
        name: row.candidate_name,
        extractedUserId: row.matched_value,
        createdAt: row.candidate_created_at,
        messageCount: messageCounts.get(row.candidate_id) || 0,
      });
    }

    return {
      groups: Array.from(groupsMap.values()),
      total: totalGroups,
    };
  }

  /**
   * Dismiss a merge suggestion.
   */
  async dismiss(
    primaryEntityId: string,
    candidateId: string,
    dismissedBy = 'user',
  ): Promise<void> {
    // Validate entities exist
    const [primary, candidate] = await Promise.all([
      this.entityRepo.findOne({ where: { id: primaryEntityId } }),
      this.entityRepo.findOne({ where: { id: candidateId } }),
    ]);

    if (!primary) {
      throw new NotFoundException(`Primary entity ${primaryEntityId} not found`);
    }
    if (!candidate) {
      throw new NotFoundException(`Candidate entity ${candidateId} not found`);
    }

    // Check if already dismissed
    const existing = await this.dismissedRepo.findOne({
      where: {
        primaryEntityId,
        dismissedEntityId: candidateId,
      },
    });

    if (existing) {
      this.logger.debug(`Suggestion already dismissed: ${primaryEntityId} -> ${candidateId}`);
      return;
    }

    // Create dismissal record
    const dismissal = this.dismissedRepo.create({
      primaryEntityId,
      dismissedEntityId: candidateId,
      dismissedBy,
    });

    await this.dismissedRepo.save(dismissal);
    this.logger.log(`Dismissed merge suggestion: ${primaryEntityId} -> ${candidateId}`);
  }

  /**
   * Get merge preview with detailed field information.
   */
  async getMergePreview(
    sourceId: string,
    targetId: string,
  ): Promise<MergePreviewDto> {
    const [source, target] = await Promise.all([
      this.getEntityMergeData(sourceId),
      this.getEntityMergeData(targetId),
    ]);

    // Detect conflicts
    const conflicts = this.detectConflicts(source, target);

    return { source, target, conflicts };
  }

  /**
   * Execute merge with selected fields.
   * Uses transaction to ensure data consistency.
   */
  async mergeWithOptions(dto: MergeRequestDto): Promise<{
    mergedEntityId: string;
    sourceEntityDeleted: boolean;
    identifiersMoved: number;
    factsMoved: number;
  }> {
    const { sourceId, targetId, includeIdentifiers, includeFacts, conflictResolutions } = dto;

    // Validate entities exist before transaction
    const [source, target] = await Promise.all([
      this.entityRepo.findOne({
        where: { id: sourceId },
        relations: ['identifiers', 'facts'],
      }),
      this.entityRepo.findOne({
        where: { id: targetId },
        relations: ['identifiers', 'facts'],
      }),
    ]);

    if (!source) {
      throw new NotFoundException(`Source entity ${sourceId} not found`);
    }
    if (!target) {
      throw new NotFoundException(`Target entity ${targetId} not found`);
    }
    if (sourceId === targetId) {
      throw new ConflictException('Cannot merge entity with itself');
    }

    // Build conflict resolution map
    const resolutionMap = new Map<string, ConflictResolution>();
    for (const res of conflictResolutions) {
      const key = `${res.field}:${res.type}`;
      resolutionMap.set(key, res.resolution);
    }

    // Execute merge in transaction
    try {
    return await this.dataSource.transaction(async (manager) => {
      let identifiersMoved = 0;
      let factsMoved = 0;

      // Process identifiers
      for (const idId of includeIdentifiers) {
        const identifier = source.identifiers?.find((i) => i.id === idId);
        if (!identifier) continue;

        const conflictKey = `identifier:${identifier.identifierType}`;
        const resolution = resolutionMap.get(conflictKey);

        const targetIdentifier = target.identifiers?.find(
          (i) => i.identifierType === identifier.identifierType,
        );

        if (targetIdentifier) {
          // Conflict exists
          if (resolution === ConflictResolution.KEEP_TARGET) {
            // Skip source identifier - keep target's
            continue;
          } else if (resolution === ConflictResolution.KEEP_SOURCE) {
            // Delete target's identifier, move source's
            await manager.query(
              `DELETE FROM entity_identifiers WHERE id = $1`,
              [targetIdentifier.id],
            );
          }
          // KEEP_BOTH: For identifiers, we keep target's and skip source's
          // (can't have duplicate identifier types for same entity)
          else if (resolution === ConflictResolution.KEEP_BOTH) {
            // Skip - identifiers must be unique per type
            continue;
          }
        }

        // Move identifier to target
        await manager.update(EntityIdentifier, { id: identifier.id }, { entityId: targetId });
        identifiersMoved++;
      }

      // Process facts
      for (const factId of includeFacts) {
        const fact = source.facts?.find((f) => f.id === factId);
        if (!fact) continue;

        const conflictKey = `fact:${fact.factType}`;
        const resolution = resolutionMap.get(conflictKey);

        const targetFact = target.facts?.find(
          (f) => f.factType === fact.factType && !f.validUntil,
        );

        if (targetFact) {
          // Conflict exists
          if (resolution === ConflictResolution.KEEP_TARGET) {
            // Skip source fact - keep target's
            continue;
          } else if (resolution === ConflictResolution.KEEP_SOURCE) {
            // Mark target's fact as historical, move source's
            await manager.update(EntityFact, { id: targetFact.id }, { validUntil: new Date() });
          } else if (resolution === ConflictResolution.KEEP_BOTH) {
            // Mark target's fact as historical, move source's (preserves history)
            await manager.update(EntityFact, { id: targetFact.id }, { validUntil: new Date() });
          }
        }

        // Move fact to target
        await manager.update(EntityFact, { id: fact.id }, { entityId: targetId });
        factsMoved++;
      }

      // Transfer entity relations (entity_relation_members)
      // First, remove source memberships that would conflict with existing target memberships
      // (same relation_id + role = duplicate composite PK)
      await manager.query(
        `DELETE FROM entity_relation_members
         WHERE entity_id = $1 AND valid_until IS NULL
           AND EXISTS (
             SELECT 1 FROM entity_relation_members t
             WHERE t.relation_id = entity_relation_members.relation_id
               AND t.role = entity_relation_members.role
               AND t.entity_id = $2
               AND t.valid_until IS NULL
           )`,
        [sourceId, targetId],
      );
      // Then update remaining source memberships to target
      await manager.query(
        `UPDATE entity_relation_members
         SET entity_id = $1
         WHERE entity_id = $2 AND valid_until IS NULL`,
        [targetId, sourceId],
      );

      // Update messages - messages have sender_entity_id and recipient_entity_id, not entity_id
      await manager.query(
        `UPDATE messages SET sender_entity_id = $1 WHERE sender_entity_id = $2`,
        [targetId, sourceId],
      );
      await manager.query(
        `UPDATE messages SET recipient_entity_id = $1 WHERE recipient_entity_id = $2`,
        [targetId, sourceId],
      );

      // Update interactions where source was a participant
      // First, remove source participations where target already participates
      // in the same interaction (prevents duplicate entity_id per interaction)
      await manager.query(
        `DELETE FROM interaction_participants
         WHERE entity_id = $1
           AND interaction_id IN (
             SELECT interaction_id FROM interaction_participants
             WHERE entity_id = $2
           )`,
        [sourceId, targetId],
      );
      // Then update remaining source participations to target
      await manager.query(
        `UPDATE interaction_participants SET entity_id = $1 WHERE entity_id = $2`,
        [targetId, sourceId],
      );

      // Remove any dismissed suggestions involving the source
      await manager.query(
        `DELETE FROM dismissed_merge_suggestions WHERE primary_entity_id = $1`,
        [sourceId],
      );
      await manager.query(
        `DELETE FROM dismissed_merge_suggestions WHERE dismissed_entity_id = $1`,
        [sourceId],
      );

      // Transfer pending_entity_resolutions
      await manager.query(
        `UPDATE pending_entity_resolutions SET resolved_entity_id = $1 WHERE resolved_entity_id = $2`,
        [targetId, sourceId],
      );

      // Transfer activities (owner and client references)
      await manager.query(
        `UPDATE activities SET owner_entity_id = $1 WHERE owner_entity_id = $2`,
        [targetId, sourceId],
      );
      await manager.query(
        `UPDATE activities SET client_entity_id = $1 WHERE client_entity_id = $2`,
        [targetId, sourceId],
      );

      // Transfer commitments
      await manager.query(
        `UPDATE commitments SET from_entity_id = $1 WHERE from_entity_id = $2`,
        [targetId, sourceId],
      );
      await manager.query(
        `UPDATE commitments SET to_entity_id = $1 WHERE to_entity_id = $2`,
        [targetId, sourceId],
      );

      // Transfer entity_events
      await manager.query(
        `UPDATE entity_events SET entity_id = $1 WHERE entity_id = $2`,
        [targetId, sourceId],
      );
      await manager.query(
        `UPDATE entity_events SET related_entity_id = $1 WHERE related_entity_id = $2`,
        [targetId, sourceId],
      );

      // Transfer transcript_segments
      await manager.query(
        `UPDATE transcript_segments SET speaker_entity_id = $1 WHERE speaker_entity_id = $2`,
        [targetId, sourceId],
      );

      // Transfer group_memberships (delete duplicates first)
      await manager.query(
        `DELETE FROM group_memberships
         WHERE entity_id = $1
           AND group_id IN (
             SELECT group_id FROM group_memberships WHERE entity_id = $2
           )`,
        [sourceId, targetId],
      );
      await manager.query(
        `UPDATE group_memberships SET entity_id = $1 WHERE entity_id = $2`,
        [targetId, sourceId],
      );

      // Transfer entity_relationship_profiles
      await manager.query(
        `DELETE FROM entity_relationship_profiles WHERE entity_id = $1`,
        [sourceId],
      );

      // Delete source entity (cascade will clean up remaining references)
      await manager.remove(EntityRecord, source);

      this.logger.log(
        `Merged entity ${sourceId} into ${targetId}: ${identifiersMoved} identifiers, ${factsMoved} facts`,
      );

      return {
        mergedEntityId: targetId,
        sourceEntityDeleted: true,
        identifiersMoved,
        factsMoved,
      };
    });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Merge failed: source=${sourceId}, target=${targetId}, error=${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  /**
   * Get message counts for multiple entities in a single query.
   */
  private async getMessageCountsBatch(
    entityIds: string[],
  ): Promise<Map<string, number>> {
    if (entityIds.length === 0) return new Map();

    const results: Array<{ entity_id: string; count: string }> =
      await this.entityRepo.query(
        `SELECT entity_id, SUM(cnt)::int AS count FROM (
          SELECT sender_entity_id AS entity_id, COUNT(*) AS cnt
          FROM messages
          WHERE sender_entity_id = ANY($1)
          GROUP BY sender_entity_id
          UNION ALL
          SELECT recipient_entity_id AS entity_id, COUNT(*) AS cnt
          FROM messages
          WHERE recipient_entity_id = ANY($1)
          GROUP BY recipient_entity_id
        ) sub
        GROUP BY entity_id`,
        [entityIds],
      );

    const map = new Map<string, number>();
    for (const row of results) {
      map.set(row.entity_id, parseInt(row.count, 10));
    }
    return map;
  }

  /**
   * Get identifiers for multiple entities in a single query.
   */
  private async getIdentifiersBatch(
    entityIds: string[],
  ): Promise<Map<string, EntityIdentifierDto[]>> {
    if (entityIds.length === 0) return new Map();

    const identifiers = await this.identifierRepo.find({
      where: { entityId: In(entityIds) },
    });

    const map = new Map<string, EntityIdentifierDto[]>();
    for (const ident of identifiers) {
      if (!map.has(ident.entityId)) {
        map.set(ident.entityId, []);
      }
      map.get(ident.entityId)!.push({
        id: ident.id,
        identifierType: ident.identifierType,
        identifierValue: ident.identifierValue,
      });
    }
    return map;
  }

  /**
   * Get message count for a single entity (as sender or recipient).
   */
  private async getMessageCount(entityId: string): Promise<number> {
    const result = await this.entityRepo.query(
      `SELECT COUNT(*) as count FROM messages
       WHERE sender_entity_id = $1 OR recipient_entity_id = $1`,
      [entityId],
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Get detailed entity data for merge preview.
   */
  private async getEntityMergeData(entityId: string): Promise<EntityMergeDataDto> {
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
      relations: ['identifiers', 'facts'],
    });

    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }

    const [messageCount, relationsCount] = await Promise.all([
      this.getMessageCount(entityId),
      this.getRelationsCount(entityId),
    ]);

    // Map identifiers
    const identifiers: EntityIdentifierDto[] = (entity.identifiers || []).map((i) => ({
      id: i.id,
      identifierType: i.identifierType,
      identifierValue: i.identifierValue,
    }));

    // Map facts (only current, not historical)
    const facts: EntityFactDto[] = (entity.facts || [])
      .filter((f) => !f.validUntil)
      .map((f) => ({
        id: f.id,
        factType: f.factType,
        value: f.value,
        ranking: f.rank || 'normal',
      }));

    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      identifiers,
      facts,
      messageCount,
      relationsCount,
    };
  }

  /**
   * Get relations count for an entity.
   */
  private async getRelationsCount(entityId: string): Promise<number> {
    const result = await this.entityRepo.query(
      `SELECT COUNT(DISTINCT relation_id) as count
       FROM entity_relation_members
       WHERE entity_id = $1 AND valid_until IS NULL`,
      [entityId],
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Detect conflicts between source and target entities.
   */
  private detectConflicts(
    source: EntityMergeDataDto,
    target: EntityMergeDataDto,
  ): MergeConflictDto[] {
    const conflicts: MergeConflictDto[] = [];

    // Check identifier conflicts (same type, different value)
    for (const sourceId of source.identifiers) {
      const targetId = target.identifiers.find(
        (t) => t.identifierType === sourceId.identifierType,
      );
      if (targetId && targetId.identifierValue !== sourceId.identifierValue) {
        conflicts.push({
          field: 'identifier',
          type: sourceId.identifierType,
          sourceValue: sourceId.identifierValue,
          targetValue: targetId.identifierValue,
        });
      }
    }

    // Check fact conflicts (same type, different value)
    for (const sourceFact of source.facts) {
      const targetFact = target.facts.find(
        (t) => t.factType === sourceFact.factType,
      );
      if (targetFact && targetFact.value !== sourceFact.value) {
        conflicts.push({
          field: 'fact',
          type: sourceFact.factType,
          sourceValue: sourceFact.value,
          targetValue: targetFact.value,
        });
      }
    }

    return conflicts;
  }
}
