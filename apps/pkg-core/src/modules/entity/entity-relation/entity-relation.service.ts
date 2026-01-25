import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  EntityRelation,
  EntityRelationMember,
  RelationType,
  RelationSource,
  isValidRole,
  isValidCardinality,
  RELATION_ROLES,
} from '@pkg/entities';
import { CreateRelationDto, AddMemberDto, RelationMemberDto } from './dto/create-relation.dto';

export interface RelationWithContext {
  relation: EntityRelation;
  /** Другие участники связи (кроме текущего entityId) */
  otherMembers: EntityRelationMember[];
  /** Роль текущего entityId в связи */
  currentRole: string;
}

@Injectable()
export class EntityRelationService {
  private readonly logger = new Logger(EntityRelationService.name);

  constructor(
    @InjectRepository(EntityRelation)
    private readonly relationRepo: Repository<EntityRelation>,
    @InjectRepository(EntityRelationMember)
    private readonly memberRepo: Repository<EntityRelationMember>,
  ) {}

  /**
   * Создать новую связь между сущностями.
   * Проверяет роли и cardinality перед созданием.
   */
  async create(dto: CreateRelationDto): Promise<EntityRelation> {
    // Validate roles
    this.validateRoles(dto.relationType, dto.members);

    // Validate cardinality
    if (!isValidCardinality(dto.relationType, dto.members.length)) {
      throw new BadRequestException(
        `Invalid number of members (${dto.members.length}) for relation type ${dto.relationType}`,
      );
    }

    // Check for duplicate relation
    const existing = await this.findDuplicate(dto);
    if (existing) {
      this.logger.debug(`Duplicate relation found: ${existing.id}`);
      return existing;
    }

    // Create relation
    const relation = this.relationRepo.create({
      relationType: dto.relationType,
      source: dto.source || RelationSource.EXTRACTED,
      confidence: dto.confidence,
      metadata: dto.metadata,
    });

    // Create members
    relation.members = dto.members.map((m) =>
      this.memberRepo.create({
        entityId: m.entityId,
        role: m.role,
        label: m.label,
        properties: m.properties,
      }),
    );

    const saved = await this.relationRepo.save(relation);
    this.logger.log(
      `Created relation ${saved.id} (${dto.relationType}) with ${dto.members.length} members`,
    );

    return saved;
  }

  /**
   * Найти связь по ID.
   */
  async findById(id: string): Promise<EntityRelation | null> {
    return this.relationRepo.findOne({
      where: { id },
      relations: ['members', 'members.entity'],
    });
  }

  /**
   * Найти все связи для сущности.
   * Возвращает только активные связи (validUntil IS NULL).
   */
  async findByEntity(entityId: string): Promise<EntityRelation[]> {
    // Find all relation IDs where entity participates
    const memberRecords = await this.memberRepo.find({
      where: {
        entityId,
        validUntil: IsNull(),
      },
      select: ['relationId'],
    });

    if (memberRecords.length === 0) {
      return [];
    }

    // Use Set to avoid duplicate IDs (entity may have multiple roles in same relation)
    const relationIds = [...new Set(memberRecords.map((m) => m.relationId))];

    // Fetch full relations with members
    return this.relationRepo
      .createQueryBuilder('relation')
      .leftJoinAndSelect('relation.members', 'member')
      .leftJoinAndSelect('member.entity', 'entity')
      .where('relation.id IN (:...ids)', { ids: relationIds })
      .andWhere('member.validUntil IS NULL')
      .getMany();
  }

  /**
   * Найти связи для сущности с контекстом.
   * Удобно для отображения: кто другой участник, какая роль у текущей сущности.
   */
  async findByEntityWithContext(entityId: string): Promise<RelationWithContext[]> {
    const relations = await this.findByEntity(entityId);

    return relations.map((relation) => {
      // LIMITATION: If entity has multiple roles in the same relation (e.g., both 'parent' and 'employer'),
      // find() returns only the first one. For full multi-role support, change to filter() and return roles[].
      const currentMember = relation.members.find((m) => m.entityId === entityId);
      const otherMembers = relation.members.filter((m) => m.entityId !== entityId);

      return {
        relation,
        otherMembers,
        currentRole: currentMember?.role || 'unknown',
      };
    });
  }

  /**
   * Найти связи определённого типа для сущности.
   */
  async findByType(entityId: string, type: RelationType): Promise<EntityRelation[]> {
    const allRelations = await this.findByEntity(entityId);
    return allRelations.filter((r) => r.relationType === type);
  }

  /**
   * Найти связь между двумя конкретными сущностями.
   * Используется для проверки дубликатов при inference.
   *
   * @param entityId1 - ID первой сущности
   * @param entityId2 - ID второй сущности
   * @param relationType - Опционально: фильтр по типу связи
   * @returns Первая найденная активная связь или null
   */
  async findByPair(
    entityId1: string,
    entityId2: string,
    relationType?: RelationType,
  ): Promise<EntityRelation | null> {
    const qb = this.relationRepo
      .createQueryBuilder('relation')
      .leftJoinAndSelect('relation.members', 'member')
      .innerJoin(
        'relation.members',
        'm1',
        'm1.entity_id = :entityId1 AND m1.valid_until IS NULL',
        { entityId1 },
      )
      .innerJoin(
        'relation.members',
        'm2',
        'm2.entity_id = :entityId2 AND m2.valid_until IS NULL',
        { entityId2 },
      );

    if (relationType) {
      qb.andWhere('relation.relationType = :relationType', { relationType });
    }

    const relation = await qb.getOne();

    if (relation) {
      this.logger.debug(
        `Found existing relation ${relation.id} (${relation.relationType}) between ${entityId1} and ${entityId2}`,
      );
    }

    return relation;
  }

  /**
   * Добавить участника в существующую связь.
   */
  async addMember(relationId: string, dto: AddMemberDto): Promise<EntityRelationMember> {
    const relation = await this.findById(relationId);
    if (!relation) {
      throw new NotFoundException(`Relation ${relationId} not found`);
    }

    // Validate role
    if (!isValidRole(relation.relationType, dto.role)) {
      throw new BadRequestException(
        `Invalid role "${dto.role}" for relation type ${relation.relationType}. ` +
          `Valid roles: ${RELATION_ROLES[relation.relationType].join(', ')}`,
      );
    }

    // Check cardinality
    const activeMembers = relation.members.filter((m) => !m.validUntil);
    if (!isValidCardinality(relation.relationType, activeMembers.length + 1)) {
      throw new BadRequestException(
        `Cannot add more members to relation type ${relation.relationType}`,
      );
    }

    // Check if already a member with same role
    const existingMember = relation.members.find(
      (m) => m.entityId === dto.entityId && m.role === dto.role && !m.validUntil,
    );
    if (existingMember) {
      return existingMember;
    }

    const member = this.memberRepo.create({
      relationId,
      entityId: dto.entityId,
      role: dto.role,
      label: dto.label,
      properties: dto.properties,
    });

    return this.memberRepo.save(member);
  }

  /**
   * Удалить участника из связи (soft delete).
   */
  async removeMember(relationId: string, entityId: string, role: string): Promise<boolean> {
    const result = await this.memberRepo.update(
      { relationId, entityId, role, validUntil: IsNull() },
      { validUntil: new Date() },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Removed member ${entityId} (${role}) from relation ${relationId}`);
      return true;
    }

    return false;
  }

  /**
   * Найти дубликат связи.
   * Связи считаются дубликатами, если совпадают тип и набор участников с ролями.
   */
  async findDuplicate(dto: CreateRelationDto): Promise<EntityRelation | null> {
    // Get all relations of this type that include the first member
    const firstMember = dto.members[0];
    const candidateRelations = await this.relationRepo
      .createQueryBuilder('relation')
      .leftJoinAndSelect('relation.members', 'member')
      .where('relation.relationType = :type', { type: dto.relationType })
      .andWhere((qb) => {
        const subQuery = qb
          .subQuery()
          .select('m.relation_id')
          .from(EntityRelationMember, 'm')
          .where('m.entity_id = :entityId', { entityId: firstMember.entityId })
          .andWhere('m.role = :role', { role: firstMember.role })
          .andWhere('m.valid_until IS NULL')
          .getQuery();
        return `relation.id IN ${subQuery}`;
      })
      .getMany();

    // Check if any candidate has exactly the same members
    for (const candidate of candidateRelations) {
      const activeMembers = candidate.members.filter((m) => !m.validUntil);

      if (activeMembers.length !== dto.members.length) {
        continue;
      }

      const allMatch = dto.members.every((dtoMember) =>
        activeMembers.some(
          (m) => m.entityId === dtoMember.entityId && m.role === dtoMember.role,
        ),
      );

      if (allMatch) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Валидировать роли участников для типа связи.
   */
  private validateRoles(type: RelationType, members: RelationMemberDto[]): void {
    const validRoles = RELATION_ROLES[type];
    if (!validRoles) {
      throw new BadRequestException(`Unknown relation type: ${type}`);
    }

    for (const member of members) {
      if (!validRoles.includes(member.role)) {
        throw new BadRequestException(
          `Invalid role "${member.role}" for relation type ${type}. ` +
            `Valid roles: ${validRoles.join(', ')}`,
        );
      }
    }
  }

  /**
   * Форматировать связи для отображения в контексте extraction.
   */
  formatForContext(relations: RelationWithContext[]): string {
    if (relations.length === 0) {
      return '';
    }

    const lines: string[] = ['СВЯЗИ:'];

    for (const { otherMembers } of relations) {
      for (const member of otherMembers) {
        const entityName = member.entity?.name || member.label || 'Неизвестно';
        const label = member.label ? ` — "${member.label}"` : '';
        const entityIdHint = member.entityId ? ` (entityId: ${member.entityId})` : '';

        lines.push(`• ${member.role}: ${entityName}${entityIdHint}${label}`);
      }
    }

    return lines.join('\n');
  }
}
