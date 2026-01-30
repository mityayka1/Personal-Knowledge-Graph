import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Optional,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { EntityRecord, EntityType } from '@pkg/entities';
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { EntityRelationService } from './entity-relation/entity-relation.service';

/**
 * Graph node representing an entity.
 */
export interface GraphNode {
  id: string;
  name: string;
  type: EntityType;
  profilePhoto?: string | null;
}

/**
 * Graph edge representing a relation.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  sourceRole: string;
  targetRole: string;
}

/**
 * Entity graph data for visualization.
 */
export interface EntityGraph {
  centralEntityId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

@Injectable()
export class EntityService {
  private readonly logger = new Logger(EntityService.name);

  constructor(
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    private identifierService: EntityIdentifierService,
    private factService: EntityFactService,
    @Optional()
    private relationService?: EntityRelationService,
  ) {}

  async findAll(options: {
    type?: EntityType;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const { type, search, limit = 50, offset = 0 } = options;

    const qb = this.entityRepo.createQueryBuilder('entity')
      .leftJoinAndSelect('entity.organization', 'organization')
      .leftJoinAndSelect('entity.identifiers', 'identifiers')
      .take(limit)
      .skip(offset)
      .orderBy('entity.updatedAt', 'DESC');

    if (type) {
      qb.andWhere('entity.type = :type', { type });
    }

    if (search) {
      // Check if search is a username (starts with @)
      if (search.startsWith('@')) {
        const username = search.slice(1); // Remove @
        qb.andWhere(
          '(identifiers.identifierType = :usernameType AND identifiers.identifierValue ILIKE :username)',
          { usernameType: 'telegram_username', username: `%${username}%` },
        );
      }
      // Check if search looks like a phone number
      else if (/^\+?\d[\d\s-]{5,}$/.test(search)) {
        const phone = search.replace(/[\s-]/g, ''); // Remove spaces and dashes
        qb.andWhere(
          '(identifiers.identifierType = :phoneType AND identifiers.identifierValue LIKE :phone)',
          { phoneType: 'phone', phone: `%${phone}%` },
        );
      }
      // Default: search by name OR by any identifier value
      else {
        qb.andWhere(
          '(entity.name ILIKE :search OR identifiers.identifierValue ILIKE :search)',
          { search: `%${search}%` },
        );
      }
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total, limit, offset };
  }

  async findOne(id: string) {
    const entity = await this.entityRepo.findOne({
      where: { id },
      relations: ['organization', 'identifiers', 'facts'],
    });

    if (!entity) {
      throw new NotFoundException(`Entity with id '${id}' not found`);
    }

    // Hide organization link if organization is soft-deleted
    if (entity.organization?.deletedAt) {
      entity.organization = null;
      entity.organizationId = null;
    }

    return entity;
  }

  async create(dto: CreateEntityDto) {
    const entity = this.entityRepo.create({
      type: dto.type,
      name: dto.name,
      organizationId: dto.organizationId,
      notes: dto.notes,
      profilePhoto: dto.profilePhoto,
      creationSource: dto.creationSource,
      isBot: dto.isBot ?? false,
    });

    const saved = await this.entityRepo.save(entity);

    // Create identifiers
    if (dto.identifiers?.length) {
      for (const ident of dto.identifiers) {
        await this.identifierService.create(saved.id, ident);
      }
    }

    // Create facts
    if (dto.facts?.length) {
      for (const fact of dto.facts) {
        await this.factService.create(saved.id, fact);
      }
    }

    return this.findOne(saved.id);
  }

  async update(id: string, dto: UpdateEntityDto) {
    const entity = await this.findOne(id);

    if (dto.name) entity.name = dto.name;
    if (dto.organizationId !== undefined) entity.organizationId = dto.organizationId;
    if (dto.notes !== undefined) entity.notes = dto.notes;
    if (dto.profilePhoto !== undefined) entity.profilePhoto = dto.profilePhoto;

    await this.entityRepo.save(entity);

    return this.findOne(id);
  }

  /**
   * Soft delete an entity.
   * Marks entity as deleted but preserves all data.
   * Related Activity/Commitment records remain intact.
   *
   * @param id - Entity UUID to soft delete
   * @returns Deletion result with timestamp
   * @throws BadRequestException if entity is the system owner
   */
  async remove(id: string) {
    const entity = await this.findOne(id);

    // Prevent deleting the owner entity - would break the system
    if (entity.isOwner) {
      throw new BadRequestException(
        'Cannot delete the owner entity. Assign ownership to another entity first with POST /entities/:id/set-owner.',
      );
    }

    // Use TypeORM softRemove which sets deletedAt
    await this.entityRepo.softRemove(entity);

    this.logger.log(`Soft deleted entity: ${entity.name} (${id})`);

    return {
      deleted: true,
      id,
      deletedAt: new Date(),
      message: 'Entity soft deleted. Use POST /entities/:id/restore to recover.',
    };
  }

  /**
   * Restore a soft-deleted entity.
   * Uses pessimistic locking to prevent race conditions.
   *
   * @param id - Entity UUID to restore
   * @returns Restored entity
   */
  async restore(id: string): Promise<EntityRecord> {
    return this.entityRepo.manager.transaction(async (manager) => {
      // SELECT FOR UPDATE prevents race condition when multiple requests try to restore
      const entity = await manager
        .createQueryBuilder(EntityRecord, 'e')
        .setLock('pessimistic_write')
        .where('e.id = :id', { id })
        .withDeleted()
        .getOne();

      if (!entity) {
        throw new NotFoundException(`Entity with id '${id}' not found`);
      }

      if (!entity.deletedAt) {
        throw new BadRequestException(`Entity '${id}' is not deleted`);
      }

      // Clear deletedAt to restore the entity
      entity.deletedAt = null;
      await manager.save(EntityRecord, entity);

      this.logger.log(`Restored entity: ${entity.name} (${id})`);

      // Fetch with relations for return
      return manager.findOne(EntityRecord, {
        where: { id },
        relations: ['organization', 'identifiers', 'facts'],
      }) as Promise<EntityRecord>;
    });
  }

  /**
   * Find all soft-deleted entities.
   *
   * @returns List of deleted entities with deletion timestamps
   */
  async findDeleted(options: { limit?: number; offset?: number } = {}) {
    const { limit = 50, offset = 0 } = options;

    const [items, total] = await this.entityRepo.findAndCount({
      where: { deletedAt: Not(IsNull()) },
      withDeleted: true,
      relations: ['organization', 'identifiers'],
      take: limit,
      skip: offset,
      order: { deletedAt: 'DESC' },
    });

    return { items, total, limit, offset };
  }

  /**
   * Permanently delete an entity (hard delete).
   * USE WITH CAUTION: This cannot be undone.
   *
   * @param id - Entity UUID to permanently delete
   * @param confirm - Must be true to proceed
   */
  async hardDelete(id: string, confirm: boolean) {
    if (!confirm) {
      throw new BadRequestException(
        'Hard delete requires explicit confirmation. Set confirm=true to proceed.',
      );
    }

    // Find with soft-deleted included
    const entity = await this.entityRepo.findOne({
      where: { id },
      withDeleted: true,
    });

    if (!entity) {
      throw new NotFoundException(`Entity with id '${id}' not found`);
    }

    // Check FK references before hard delete
    const hasReferences = await this.checkEntityReferences(id);
    if (hasReferences.total > 0) {
      throw new ConflictException(
        `Cannot hard delete: entity has ${hasReferences.total} references ` +
        `(${hasReferences.activities} activities, ${hasReferences.commitments} commitments, ` +
        `${hasReferences.participations} participations). ` +
        `These must be deleted or reassigned first.`,
      );
    }

    // Permanently remove from database
    await this.entityRepo.remove(entity);

    this.logger.warn(`HARD deleted entity: ${entity.name} (${id})`);

    return {
      hardDeleted: true,
      id,
      message: 'Entity permanently deleted. This cannot be undone.',
    };
  }

  async merge(sourceId: string, targetId: string) {
    const source = await this.findOne(sourceId);
    await this.findOne(targetId); // Validate target exists

    if (sourceId === targetId) {
      throw new ConflictException('Cannot merge entity with itself');
    }

    // Prevent merging owner entity
    if (source.isOwner) {
      throw new BadRequestException(
        'Cannot merge the owner entity. Assign ownership to target entity first.',
      );
    }

    // Move identifiers
    const identifiersMoved = await this.identifierService.moveToEntity(sourceId, targetId);

    // Move facts
    const factsMoved = await this.factService.moveToEntity(sourceId, targetId);

    // Soft delete source entity (preserves FK references in Activity/Commitment)
    await this.entityRepo.softRemove(source);

    this.logger.log(`Merged entity ${source.name} (${sourceId}) into ${targetId}`);

    return {
      mergedEntityId: targetId,
      sourceEntityDeleted: true,
      identifiersMoved,
      factsMoved,
    };
  }

  /**
   * Find the owner entity ("me").
   * Returns null if no owner is set.
   */
  async findMe(): Promise<EntityRecord | null> {
    return this.entityRepo.findOne({
      where: { isOwner: true },
      relations: ['organization', 'identifiers', 'facts'],
    });
  }

  /**
   * Set entity as the system owner ("me").
   * Only one entity can be owner at a time.
   * If another entity is currently owner, it will be unset first.
   *
   * Uses transaction to prevent race conditions when multiple
   * requests try to set owner simultaneously.
   *
   * @param id - Entity ID to set as owner
   * @returns The updated entity
   */
  async setOwner(id: string): Promise<EntityRecord> {
    // Validate entity exists before starting transaction
    await this.findOne(id);

    await this.entityRepo.manager.transaction(async (manager) => {
      // Find current owner (if any) and unset
      const currentOwner = await manager.findOne(EntityRecord, {
        where: { isOwner: true },
      });

      if (currentOwner && currentOwner.id !== id) {
        currentOwner.isOwner = false;
        await manager.save(currentOwner);
      }

      // Set new owner
      const entity = await manager.findOne(EntityRecord, { where: { id } });
      if (entity) {
        entity.isOwner = true;
        await manager.save(entity);
      }
    });

    return this.findOne(id);
  }

  /**
   * Get entity graph for visualization.
   * Returns nodes (entities) and edges (relations) centered around the given entity.
   *
   * @param entityId - Central entity ID
   * @param depth - How many levels of relations to include (default: 1, max: 1)
   */
  async getGraph(entityId: string, depth = 1): Promise<EntityGraph> {
    if (!this.relationService) {
      throw new ServiceUnavailableException(
        'Entity graph is temporarily unavailable. EntityRelationService is not configured.',
      );
    }

    // Validate depth parameter
    if (depth > 1) {
      throw new BadRequestException(
        'depth > 1 is not yet supported. Please use depth=1.',
      );
    }

    const centralEntity = await this.findOne(entityId);

    const nodes: Map<string, GraphNode> = new Map();
    const edges: GraphEdge[] = [];

    // Add central entity
    nodes.set(centralEntity.id, {
      id: centralEntity.id,
      name: centralEntity.name,
      type: centralEntity.type,
      profilePhoto: centralEntity.profilePhoto,
    });

    // Get relations for central entity
    const relations = await this.relationService.findByEntity(entityId);

    for (const relation of relations) {
      // Process all members (exclude soft-deleted)
      const members = relation.members.filter((m) => !m.validUntil);

      // First pass: add all valid nodes
      for (const member of members) {
        if (!nodes.has(member.entityId) && member.entity) {
          nodes.set(member.entityId, {
            id: member.entity.id,
            name: member.entity.name,
            type: member.entity.type,
            profilePhoto: member.entity.profilePhoto,
          });
        }
      }

      // Second pass: create edges only between existing nodes
      // For binary relations (2 members), create one edge
      if (members.length === 2) {
        const [m1, m2] = members;
        // Only create edge if both nodes exist (prevents orphaned edges)
        if (nodes.has(m1.entityId) && nodes.has(m2.entityId)) {
          edges.push({
            id: relation.id,
            source: m1.entityId,
            target: m2.entityId,
            relationType: relation.relationType,
            sourceRole: m1.role,
            targetRole: m2.role,
          });
        }
      } else if (members.length > 2) {
        // For N-ary relations, create edges from central entity to all others
        const centralMember = members.find((m) => m.entityId === entityId);
        const otherMembers = members.filter((m) => m.entityId !== entityId);

        for (const other of otherMembers) {
          // Only create edge if target node exists (prevents orphaned edges)
          if (nodes.has(other.entityId)) {
            edges.push({
              // Include role to prevent ID collision when same entities have multiple relations
              id: `${relation.id}-${other.entityId}-${other.role}`,
              source: entityId,
              target: other.entityId,
              relationType: relation.relationType,
              sourceRole: centralMember?.role || 'member',
              targetRole: other.role,
            });
          }
        }
      }
    }

    return {
      centralEntityId: entityId,
      nodes: Array.from(nodes.values()),
      edges,
    };
  }

  /**
   * Check if entity has FK references that would prevent hard delete.
   * Returns counts of each reference type.
   */
  private async checkEntityReferences(entityId: string): Promise<{
    activities: number;
    commitments: number;
    participations: number;
    total: number;
  }> {
    const [activities, commitments, participations] = await Promise.all([
      this.entityRepo.manager
        .query('SELECT COUNT(*) FROM activities WHERE entity_id = $1', [entityId])
        .then((r) => parseInt(r[0].count, 10)),
      this.entityRepo.manager
        .query('SELECT COUNT(*) FROM commitments WHERE entity_id = $1', [entityId])
        .then((r) => parseInt(r[0].count, 10)),
      this.entityRepo.manager
        .query('SELECT COUNT(*) FROM interaction_participants WHERE entity_id = $1', [entityId])
        .then((r) => parseInt(r[0].count, 10)),
    ]);

    return {
      activities,
      commitments,
      participations,
      total: activities + commitments + participations,
    };
  }
}
