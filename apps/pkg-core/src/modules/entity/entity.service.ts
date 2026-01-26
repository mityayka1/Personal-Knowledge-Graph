import {
  Injectable,
  NotFoundException,
  ConflictException,
  Optional,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
        qb.leftJoin('entity.identifiers', 'identifier')
          .andWhere(
            '(identifier.identifierType = :usernameType AND identifier.identifierValue ILIKE :username)',
            { usernameType: 'telegram_username', username: `%${username}%` },
          );
      }
      // Check if search looks like a phone number
      else if (/^\+?\d[\d\s-]{5,}$/.test(search)) {
        const phone = search.replace(/[\s-]/g, ''); // Remove spaces and dashes
        qb.leftJoin('entity.identifiers', 'identifier')
          .andWhere(
            '(identifier.identifierType = :phoneType AND identifier.identifierValue LIKE :phone)',
            { phoneType: 'phone', phone: `%${phone}%` },
          );
      }
      // Default: search by name OR by any identifier value
      else {
        qb.leftJoin('entity.identifiers', 'identifier')
          .andWhere(
            '(entity.name ILIKE :search OR identifier.identifierValue ILIKE :search)',
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

  async remove(id: string) {
    const entity = await this.findOne(id);
    await this.entityRepo.remove(entity);
    return { deleted: true, id };
  }

  async merge(sourceId: string, targetId: string) {
    const source = await this.findOne(sourceId);
    await this.findOne(targetId); // Validate target exists

    if (sourceId === targetId) {
      throw new ConflictException('Cannot merge entity with itself');
    }

    // Move identifiers
    const identifiersMoved = await this.identifierService.moveToEntity(sourceId, targetId);

    // Move facts
    const factsMoved = await this.factService.moveToEntity(sourceId, targetId);

    // Delete source entity
    await this.entityRepo.remove(source);

    return {
      mergedEntityId: targetId,
      sourceEntityDeleted: true,
      identifiersMoved,
      factsMoved,
    };
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
}
