import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityIdentifier, IdentifierType } from '@pkg/entities';
import { CreateIdentifierDto } from '../dto/create-entity.dto';

@Injectable()
export class EntityIdentifierService {
  constructor(
    @InjectRepository(EntityIdentifier)
    private identifierRepo: Repository<EntityIdentifier>,
  ) {}

  async create(entityId: string, dto: CreateIdentifierDto) {
    // Check for duplicate
    const existing = await this.identifierRepo.findOne({
      where: {
        identifierType: dto.type,
        identifierValue: dto.value,
      },
    });

    if (existing) {
      throw new ConflictException(
        `Identifier ${dto.type}:${dto.value} already exists for entity ${existing.entityId}`,
      );
    }

    const identifier = this.identifierRepo.create({
      entityId,
      identifierType: dto.type,
      identifierValue: dto.value,
      metadata: dto.metadata,
    });

    return this.identifierRepo.save(identifier);
  }

  /**
   * Find identifier by type and value.
   * Returns null if the linked entity has been soft-deleted.
   */
  async findByIdentifier(type: IdentifierType, value: string) {
    const identifier = await this.identifierRepo.findOne({
      where: {
        identifierType: type,
        identifierValue: value,
      },
      relations: ['entity'],
    });

    // If entity is soft-deleted, treat identifier as not found
    if (identifier?.entity?.deletedAt) {
      return null;
    }

    return identifier;
  }

  async moveToEntity(fromEntityId: string, toEntityId: string) {
    const result = await this.identifierRepo.update(
      { entityId: fromEntityId },
      { entityId: toEntityId },
    );
    return result.affected || 0;
  }
}
