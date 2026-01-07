import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { EntityRecord, EntityType } from '@pkg/entities';
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { EntityIdentifierService } from './entity-identifier/entity-identifier.service';
import { EntityFactService } from './entity-fact/entity-fact.service';

@Injectable()
export class EntityService {
  constructor(
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    private identifierService: EntityIdentifierService,
    private factService: EntityFactService,
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
      qb.andWhere('entity.name ILIKE :search', { search: `%${search}%` });
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
    const target = await this.findOne(targetId);

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
}
