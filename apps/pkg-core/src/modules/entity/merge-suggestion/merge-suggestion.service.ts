import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
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

/**
 * Regex to match orphaned Telegram entities.
 * Format: "Telegram 1234567890" where digits are the telegram_user_id.
 */
const TELEGRAM_NAME_PATTERN = /^Telegram (\d+)$/;

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
   * Get merge suggestions for orphaned Telegram entities.
   * Returns groups where each group has a primary entity and candidates.
   */
  async getSuggestions(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<MergeSuggestionsResponseDto> {
    const { limit = 50, offset = 0 } = options;

    // Find orphaned Telegram entities (name matches pattern, no telegram_user_id identifier)
    const orphanedEntities = await this.findOrphanedTelegramEntities();

    if (orphanedEntities.length === 0) {
      return { groups: [], total: 0 };
    }

    // Get dismissed pairs to filter out
    const dismissedPairs = await this.getDismissedPairs();

    // Build suggestion groups
    const groups: MergeSuggestionGroupDto[] = [];

    for (const orphan of orphanedEntities) {
      // Extract telegram_user_id from name
      const match = TELEGRAM_NAME_PATTERN.exec(orphan.name);
      if (!match) continue;

      const telegramUserId = match[1];

      // Find entity with this telegram_user_id identifier
      const identifier = await this.identifierRepo.findOne({
        where: {
          identifierType: 'telegram_user_id',
          identifierValue: telegramUserId,
        },
        relations: ['entity', 'entity.identifiers'],
      });

      if (!identifier || !identifier.entity) continue;

      const primaryEntity = identifier.entity;

      // Skip if this pair was dismissed
      const dismissKey = `${primaryEntity.id}:${orphan.id}`;
      if (dismissedPairs.has(dismissKey)) continue;

      // Get message count for the orphan
      const messageCount = await this.getMessageCount(orphan.id);

      // Check if group for this primary entity already exists
      const existingGroup = groups.find(
        (g) => g.primaryEntity.id === primaryEntity.id,
      );

      const candidate = {
        id: orphan.id,
        name: orphan.name,
        extractedUserId: telegramUserId,
        createdAt: orphan.createdAt,
        messageCount,
      };

      if (existingGroup) {
        existingGroup.candidates.push(candidate);
      } else {
        groups.push({
          primaryEntity: {
            id: primaryEntity.id,
            name: primaryEntity.name,
            type: primaryEntity.type,
            profilePhoto: primaryEntity.profilePhoto,
            identifiers: (primaryEntity.identifiers || []).map((i) => ({
              id: i.id,
              identifierType: i.identifierType,
              identifierValue: i.identifierValue,
            })),
          },
          candidates: [candidate],
          reason: 'orphaned_telegram_id',
        });
      }
    }

    // Apply pagination
    const total = groups.length;
    const paginatedGroups = groups.slice(offset, offset + limit);

    return { groups: paginatedGroups, total };
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
            await manager.delete(EntityIdentifier, { id: targetIdentifier.id });
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
      // Update all relation memberships from source to target
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
      await manager.query(
        `UPDATE interaction_participants SET entity_id = $1 WHERE entity_id = $2`,
        [targetId, sourceId],
      );

      // Remove any dismissed suggestions involving the source
      await manager.delete(DismissedMergeSuggestion, { primaryEntityId: sourceId });
      await manager.delete(DismissedMergeSuggestion, { dismissedEntityId: sourceId });

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
  }

  /**
   * Find orphaned Telegram entities.
   * These are entities with names like "Telegram 1234567890" but no telegram_user_id identifier.
   */
  private async findOrphanedTelegramEntities(): Promise<EntityRecord[]> {
    // Use raw query for pattern matching and NOT EXISTS
    const results = await this.entityRepo.query(`
      SELECT e.*
      FROM entities e
      WHERE e.name ~ '^Telegram [0-9]+$'
        AND NOT EXISTS (
          SELECT 1 FROM entity_identifiers ei
          WHERE ei.entity_id = e.id
            AND ei.identifier_type = 'telegram_user_id'
        )
      ORDER BY e.created_at DESC
    `);

    return results as EntityRecord[];
  }

  /**
   * Get set of dismissed pairs as "primaryId:candidateId".
   */
  private async getDismissedPairs(): Promise<Set<string>> {
    const dismissed = await this.dismissedRepo.find();
    return new Set(
      dismissed.map((d) => `${d.primaryEntityId}:${d.dismissedEntityId}`),
    );
  }

  /**
   * Get message count for an entity (as sender or recipient).
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

    const messageCount = await this.getMessageCount(entityId);
    const relationsCount = await this.getRelationsCount(entityId);

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
